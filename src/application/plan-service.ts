/**
 * PlanService — a requirement → a planner agent → a plan a human approves → tasks.
 *
 *   start()   creates the plan and its planning task (role: planner)
 *   submit()  validates the planner's plan; asks a human to approve it (a decision
 *             with source 'plan' — it shows up in `orch decision list`)
 *   answer    (through the decision, or approve/revise/cancel here)
 *     approve  → a goal plus every task of the plan, in dependency order
 *     continue → sent back: a new planning task (next revision) gets the
 *                feedback and the previous plan
 *     cancel   → the plan is dropped
 *
 * The planning task never merges code: it is done once its plan is submitted,
 * and fails (and is retried) if the planner ends without submitting one.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import yaml from 'js-yaml';
import type { Decision } from '../domain/decision.js';
import { describeAnswer } from '../domain/decision.js';
import { InvalidArgumentsError } from '../domain/errors.js';
import {
  DEFAULT_MAX_PLAN_TASKS,
  DEFAULT_PLANNER_ROLE,
  PLANNING_LABEL,
  planTaskOrder,
  planTitle,
  validatePlanDraft,
  type Plan,
  type PlanDraft,
  type PlanValidation,
} from '../domain/plan.js';
import type { OrchestratorConfig } from '../domain/config.js';
import { dutyRole } from '../domain/role.js';
import type { Task } from '../domain/task.js';
import { isTerminal } from '../domain/transitions.js';
import type { IPlanStore, IRoleStore, ITaskStore } from '../infrastructure/storage/interfaces.js';
import type { DecisionService } from './decision-service.js';
import type { EventBus } from './event-bus.js';
import type { GoalService } from './goal-service.js';
import type { TaskService } from './task-service.js';

export interface PlanServiceDeps {
  store: IPlanStore;
  taskStore: ITaskStore;
  taskService: TaskService;
  goalService: GoalService;
  decisionService: DecisionService;
  roleStore: IRoleStore;
  eventBus: EventBus;
  config: OrchestratorConfig;
  /** Project root: `uses` files no plan task produces must exist here. */
  projectRoot?: string;
}

export interface StartPlanInput {
  requirement: string;
  /** Planner role (default: config planner.role, else "planner"). */
  role?: string;
  title?: string;
  /** The PRD the requirement is (a version of). */
  prd?: { name: string; version: number };
}

export interface SubmitPlanInput {
  /** Plan ID; or found from taskId (the planner's $ORCH_TASK_ID); or the only open plan. */
  planId?: string;
  taskId?: string;
  raw: unknown;
  submittedBy?: string;
}

/** What the planner's prompt gets. */
export interface PlanningPromptContext {
  plan_id: string;
  revision: number;
  max_tasks: number;
  roles: Array<{ name: string; description?: string; agents: number }>;
  /** The plan that was sent back (YAML), for revisions. */
  previous_plan?: string;
}

const PLANNER_ROLE_HINT = 'Create one, e.g.: orch role add planner --adapter claude --model opus -d "Breaks requirements into tasks for the team"';

export class PlanService {
  constructor(private readonly deps: PlanServiceDeps) {
    deps.decisionService.onAnswer((d) => this.onDecisionAnswered(d));
  }

  /** The role that plans: one declaring the plan duty, else config planner.role, else "planner". */
  async plannerRole(): Promise<string> {
    const roles = await this.deps.roleStore.list().catch(() => []);
    return dutyRole(roles, 'plan', this.deps.config.planner?.role || DEFAULT_PLANNER_ROLE);
  }

  get maxTasks(): number {
    return this.deps.config.planner?.max_tasks ?? DEFAULT_MAX_PLAN_TASKS;
  }

  async start(input: StartPlanInput): Promise<{ plan: Plan; task: Task }> {
    const requirement = input.requirement.trim();
    if (!requirement) throw new InvalidArgumentsError('Describe the requirement to plan');
    const role = input.role?.trim() || await this.plannerRole();
    if (!(await this.deps.roleStore.get(role).catch(() => null))) {
      throw new InvalidArgumentsError(`There is no "${role}" role to do the planning`, PLANNER_ROLE_HINT);
    }

    const id = `pln_${nanoid(7)}`;
    const title = input.title?.trim() || planTitle(requirement);
    const task = await this.createPlanningTask(id, title, requirement, role, 1);
    const now = new Date().toISOString();
    const plan: Plan = {
      id,
      status: 'planning',
      title,
      requirement,
      role,
      revision: 1,
      planning_task_id: task.id,
      planning_task_ids: [task.id],
      ...(input.prd ? { prd: input.prd } : {}),
      created_at: now,
      updated_at: now,
    };
    await this.deps.store.save(plan);
    return { plan, task };
  }

  /** A plan by its ID or by one of its planning tasks. */
  async get(idOrTaskId: string): Promise<Plan> {
    const plan = idOrTaskId.startsWith('pln_')
      ? await this.deps.store.get(idOrTaskId)
      : (await this.deps.store.list()).find((p) => p.planning_task_ids.includes(idOrTaskId)) ?? null;
    if (!plan) throw new InvalidArgumentsError(`Plan not found: ${idOrTaskId}`, 'List plans with: orch plan list');
    return plan;
  }

  list(): Promise<Plan[]> {
    return this.deps.store.list();
  }

  /** Validate a plan without submitting it. */
  async validate(raw: unknown, plan?: Plan): Promise<PlanValidation> {
    const [roles, tasks] = await Promise.all([this.deps.roleStore.load(), this.deps.taskStore.list()]);
    const planner = plan?.role ?? dutyRole(roles.roles, 'plan', this.deps.config.planner?.role || DEFAULT_PLANNER_ROLE);
    return validatePlanDraft(raw, {
      roles: roles.roles.filter((r) => r.name !== planner && !r.duties?.includes('review')).map((r) => r.name),
      existingTaskIds: new Set(tasks.map((t) => t.id)),
      maxTasks: this.maxTasks,
      ...(this.deps.projectRoot ? { fileExists: (p: string) => existsSync(path.join(this.deps.projectRoot!, p)) } : {}),
    });
  }

  async submit(input: SubmitPlanInput): Promise<{ plan: Plan; decision: Decision; warnings: string[] }> {
    const plan = await this.findForSubmit(input);
    if (plan.status !== 'planning' && plan.status !== 'awaiting_approval') {
      throw new InvalidArgumentsError(`Plan ${plan.id} is ${plan.status}; it cannot be changed`);
    }
    if (input.taskId && plan.planning_task_ids.includes(input.taskId) && input.taskId !== plan.planning_task_id) {
      throw new InvalidArgumentsError(`Task ${input.taskId} planned an older revision of ${plan.id}; revision ${plan.revision} is planned by ${plan.planning_task_id}`);
    }

    const result = await this.validate(input.raw, plan);
    if (!result.draft) {
      throw new InvalidArgumentsError(
        `The plan has ${result.errors.length} problem(s):\n${result.errors.map((e) => `  - ${e}`).join('\n')}`,
        'Fix the plan file and run orch plan submit again',
      );
    }

    plan.draft = result.draft;
    plan.status = 'awaiting_approval';
    plan.submitted_at = new Date().toISOString();
    plan.submitted_by = input.submittedBy ?? 'human';
    plan.updated_at = plan.submitted_at;

    const question = `Approve plan ${plan.id} "${result.draft.goal}" (${result.draft.tasks.length} task(s), revision ${plan.revision})?`;
    const context = approvalContext(plan, result.draft, result.warnings);
    const pending = plan.decision_id ? await this.deps.decisionService.get(plan.decision_id).catch(() => null) : null;
    let decision: Decision;
    if (pending?.status === 'pending') {
      // Submitted again before anyone answered: the same decision now shows the new plan.
      decision = await this.deps.decisionService.refresh(pending.id, { question, context });
    } else {
      decision = await this.deps.decisionService.request({
        source: 'plan',
        plan_id: plan.id,
        question,
        context,
        requested_by: plan.submitted_by,
      });
    }
    plan.decision_id = decision.id;
    await this.deps.store.save(plan);

    this.deps.eventBus.emit({ type: 'plan:submitted', planId: plan.id, revision: plan.revision, tasks: result.draft.tasks.length, decisionId: decision.id });
    return { plan, decision, warnings: result.warnings };
  }

  /** Approve the submitted plan: creates its goal and tasks. */
  async approve(idOrTaskId: string, message?: string): Promise<Plan> {
    const plan = await this.get(idOrTaskId);
    await this.deps.decisionService.answer(this.pendingDecisionId(plan), { action: 'approve', ...(message ? { message } : {}) });
    return this.get(plan.id);
  }

  /** Send the submitted plan back to the planner with feedback (next revision). */
  async revise(idOrTaskId: string, feedback: string): Promise<Plan> {
    if (!feedback.trim()) throw new InvalidArgumentsError('Say what to change', 'orch plan reject <id> -m "<what to change>"');
    const plan = await this.get(idOrTaskId);
    await this.deps.decisionService.answer(this.pendingDecisionId(plan), { action: 'continue', message: feedback });
    return this.get(plan.id);
  }

  async cancel(idOrTaskId: string): Promise<Plan> {
    const plan = await this.get(idOrTaskId);
    if (plan.status === 'awaiting_approval') {
      await this.deps.decisionService.answer(this.pendingDecisionId(plan), { action: 'cancel' });
      return this.get(plan.id);
    }
    if (plan.status !== 'planning') throw new InvalidArgumentsError(`Plan ${plan.id} is already ${plan.status}`);
    const task = await this.deps.taskStore.get(plan.planning_task_id);
    if (task && !isTerminal(task.status)) await this.deps.taskService.cancel(task.id);
    plan.status = 'cancelled';
    plan.updated_at = new Date().toISOString();
    await this.deps.store.save(plan);
    this.deps.eventBus.emit({ type: 'plan:cancelled', planId: plan.id });
    return plan;
  }

  /**
   * How a planning task's run ended: `submitted` once its plan was submitted
   * (or the plan moved on without it), `missing` if the planner never submitted.
   */
  async planningRunOutcome(task: Pick<Task, 'id' | 'plan_id'>): Promise<'submitted' | 'missing'> {
    if (!task.plan_id) return 'submitted';
    const plan = await this.deps.store.get(task.plan_id);
    if (!plan) return 'submitted';
    return plan.status === 'planning' && plan.planning_task_id === task.id ? 'missing' : 'submitted';
  }

  /** Prompt context for a planning task (undefined for other tasks). */
  async promptContext(task: Pick<Task, 'id' | 'plan_id'>): Promise<PlanningPromptContext | undefined> {
    if (!task.plan_id) return undefined;
    const plan = await this.deps.store.get(task.plan_id);
    if (!plan) return undefined;
    const roles = (await this.deps.roleStore.load()).roles.filter((r) => r.name !== plan.role && !r.duties?.includes('review'));
    return {
      plan_id: plan.id,
      revision: plan.revision,
      max_tasks: this.maxTasks,
      roles: roles.map((r) => ({ name: r.name, ...(r.description ? { description: r.description } : {}), agents: r.replicas })),
      ...(plan.revision > 1 && plan.status === 'planning' && plan.draft ? { previous_plan: dumpDraft(plan.draft) } : {}),
    };
  }

  // ─── Answers ────────────────────────────────────────────────

  private async onDecisionAnswered(decision: Decision): Promise<void> {
    if (!decision.plan_id || !decision.answer) return;
    const plan = await this.get(decision.plan_id);
    if (plan.status !== 'awaiting_approval' || plan.decision_id !== decision.id) {
      throw new InvalidArgumentsError(`Plan ${plan.id} is ${plan.status}; this decision no longer applies`);
    }
    switch (decision.answer.action) {
      case 'approve':
        await this.materialize(plan);
        return;
      case 'cancel':
        plan.status = 'cancelled';
        plan.updated_at = new Date().toISOString();
        await this.deps.store.save(plan);
        this.deps.eventBus.emit({ type: 'plan:cancelled', planId: plan.id });
        return;
      case 'continue':
        await this.sendBack(plan, describeAnswer(decision));
        return;
    }
  }

  private async sendBack(plan: Plan, feedback: string): Promise<void> {
    const revision = plan.revision + 1;
    const task = await this.createPlanningTask(plan.id, plan.title, plan.requirement, plan.role, revision);
    task.feedback = [
      `A human reviewed your plan (revision ${plan.revision}) and sent it back:`,
      feedback,
      '',
      'Revise the plan (shown under "Your previous plan") and submit it again. Keep what the feedback does not object to.',
    ].join('\n');
    task.updated_at = new Date().toISOString();
    await this.deps.taskStore.save(task);

    plan.revision = revision;
    plan.status = 'planning';
    plan.planning_task_id = task.id;
    plan.planning_task_ids = [...plan.planning_task_ids, task.id];
    plan.feedback = feedback;
    delete plan.decision_id;
    plan.updated_at = new Date().toISOString();
    await this.deps.store.save(plan);
    this.deps.eventBus.emit({ type: 'plan:revised', planId: plan.id, revision, taskId: task.id });
  }

  /**
   * Create the goal and the tasks. Re-validated first (roles or tasks may have
   * changed since submission). Resumable: tasks already created are skipped.
   */
  private async materialize(plan: Plan): Promise<void> {
    if (!plan.draft) throw new InvalidArgumentsError(`Plan ${plan.id} has nothing submitted`);
    const check = await this.validate(plan.draft, plan);
    // Dependencies on plan keys whose tasks exist already are fine on a resumed run.
    if (!check.draft) {
      throw new InvalidArgumentsError(
        `Plan ${plan.id} can no longer be applied:\n${check.errors.map((e) => `  - ${e}`).join('\n')}`,
        `Send it back to the planner: orch plan reject ${plan.id} -m "<what changed>"`,
      );
    }
    const draft = check.draft;

    if (!plan.goal_id) {
      const goal = await this.deps.goalService.create({
        title: draft.goal,
        description: [draft.summary, `Requirement:\n${plan.requirement}`, `Plan: ${plan.id}`].filter(Boolean).join('\n\n'),
      });
      plan.goal_id = goal.id;
      await this.deps.store.save(plan);
    }

    const created: Record<string, string> = { ...plan.created_tasks };
    for (const t of planTaskOrder(draft.tasks)) {
      if (created[t.key]) continue;
      const task = await this.deps.taskService.create({
        title: t.title,
        description: t.description,
        role: t.role,
        depends_on: t.depends_on.map((d) => created[d] ?? d),
        labels: [`plan:${plan.id}`],
        goalId: plan.goal_id,
        ...(t.scope ? { scope: t.scope } : {}),
        ...(t.review_criteria ? { review_criteria: t.review_criteria } : {}),
        ...(t.priority !== undefined ? { priority: t.priority } : {}),
        ...(t.needs_decision ? { needs_decision: true } : {}),
        ...(t.produces ? { produces: t.produces } : {}),
        ...(t.uses ? { uses: t.uses } : {}),
        ...(plan.prd ? { prd: plan.prd.name } : {}),
      });
      if (t.needs_decision) {
        await this.deps.decisionService.request({
          task_id: task.id,
          source: 'gate',
          question: typeof t.needs_decision === 'string'
            ? t.needs_decision
            : `Start "${t.title}"? (plan ${plan.id} marked it as needing your confirmation)`,
          context: t.description,
          requested_by: plan.submitted_by ?? 'planner',
        });
      }
      created[t.key] = task.id;
      plan.created_tasks = { ...created };
      await this.deps.store.save(plan);
    }

    plan.status = 'approved';
    plan.updated_at = new Date().toISOString();
    await this.deps.store.save(plan);
    this.deps.eventBus.emit({
      type: 'plan:approved',
      planId: plan.id,
      goalId: plan.goal_id!,
      taskIds: draft.tasks.map((t) => created[t.key]!),
    });
  }

  // ─── Helpers ────────────────────────────────────────────────

  private async createPlanningTask(planId: string, title: string, requirement: string, role: string, revision: number): Promise<Task> {
    return this.deps.taskService.create({
      title: `Plan: ${title}${revision > 1 ? ` (rev ${revision})` : ''}`,
      description: requirement,
      role,
      labels: [PLANNING_LABEL],
      review_criteria: [], // a plan is reviewed by a human, not by tests
      plan_id: planId,
    });
  }

  private pendingDecisionId(plan: Plan): string {
    if (plan.status === 'planning') {
      throw new InvalidArgumentsError(`Plan ${plan.id} has not been submitted yet (the planner is on revision ${plan.revision})`);
    }
    if (plan.status !== 'awaiting_approval' || !plan.decision_id) {
      throw new InvalidArgumentsError(`Plan ${plan.id} is ${plan.status}`);
    }
    return plan.decision_id;
  }

  private async findForSubmit(input: SubmitPlanInput): Promise<Plan> {
    if (input.planId) return this.get(input.planId);
    if (input.taskId) {
      const task = await this.deps.taskStore.get(input.taskId);
      if (task?.plan_id) return this.get(task.plan_id);
      throw new InvalidArgumentsError(`Task ${input.taskId} is not a planning task`, 'Pass the plan: orch plan submit <file> --plan <plan-id>');
    }
    const open = (await this.deps.store.list()).filter((p) => p.status === 'planning' || p.status === 'awaiting_approval');
    if (open.length === 1) return open[0]!;
    throw new InvalidArgumentsError(
      open.length ? `${open.length} plans are open; say which one` : 'No plan is open',
      open.length ? 'orch plan submit <file> --plan <plan-id>' : 'Start one with: orch plan new "<requirement>"',
    );
  }
}

/** Background for the approval decision: the plan at a glance. */
function approvalContext(plan: Plan, draft: PlanDraft, warnings: string[]): string {
  const lines: string[] = [];
  if (plan.prd) lines.push(`Made from PRD ${plan.prd.name} v${plan.prd.version} — approving the plan approves this PRD too (read it: orch prd show ${plan.prd.name} ${plan.prd.version})`, '');
  if (draft.summary) lines.push(draft.summary, '');
  draft.tasks.forEach((t, i) => {
    const after = t.depends_on.length ? ` (after ${t.depends_on.join(', ')})` : '';
    lines.push(`${i + 1}. [${t.role}] ${t.key}: ${t.title}${after}${t.needs_decision ? ' — asks you before it starts' : ''}`);
  });
  if (warnings.length) lines.push('', 'Warnings:', ...warnings.map((w) => `- ${w}`));
  lines.push('', `Details: orch plan show ${plan.id}`);
  lines.push(`Approve: orch plan approve ${plan.id} · Send back: orch plan reject ${plan.id} -m "<what to change>" · Drop: orch plan cancel ${plan.id}`);
  return lines.join('\n');
}

function dumpDraft(draft: PlanDraft): string {
  return yaml.dump(draft, { lineWidth: 120, noRefs: true }).trimEnd();
}
