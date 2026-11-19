/**
 * DecisionService — requests, answers and the decision log.
 *
 * Requesting a decision on a task holds the task in `waiting_decision` (a task
 * that is running is moved there by the orchestrator when its run ends).
 * Answering applies the action once no other decision on the task is pending:
 *   continue → todo, with the answer as feedback (send-back count reset)
 *   approve  → review + approved (the orchestrator integrates it); for a gate
 *              (a task that has not started) → todo: it starts
 *   cancel   → cancelled
 * Answer hooks (e.g. plans) run before an answer is recorded; if one throws,
 * the decision stays pending.
 * Answered decisions are given to later agents (bindingFor).
 */

import { nanoid } from 'nanoid';
import {
  normalizeDecisionRequest,
  resolveDecisionAnswer,
  describeAnswer,
  type Decision,
  type DecisionAnswerInput,
  type DecisionRequest,
} from '../domain/decision.js';
import { MAX_CONTEXT_LENGTH } from '../domain/decision.js';
import { InvalidArgumentsError, InvalidTransitionError, TaskNotFoundError } from '../domain/errors.js';
import { roleAgentIndex } from '../domain/role.js';
import { isTerminal } from '../domain/transitions.js';
import type { Task } from '../domain/task.js';
import type { IDecisionStore, ITaskStore } from '../infrastructure/storage/interfaces.js';
import type { EventBus } from './event-bus.js';
import type { TaskService } from './task-service.js';

/** Most recent project-wide decisions given to every prompt. */
const MAX_PROJECT_DECISIONS_IN_PROMPT = 30;

export interface AnswerResult {
  decision: Decision;
  /** The task after the answer was applied (undefined if it has none / was not changed). */
  task?: Task;
  /** Other decisions on the task still pending (the action waits for them). */
  stillPending: number;
}

/** Runs when a decision is answered, before the answer is recorded (throw to reject it). */
export type DecisionAnswerHook = (decision: Decision) => Promise<void>;

/**
 * Picks who answers a new decision first: a role (e.g. the PM, with a task to
 * answer it) or nobody (a human). `asker` is the task it is about.
 */
export type DecisionRouter = (decision: Decision, asker: Task | null) => Promise<{ assignee: string; triage_task_id: string } | undefined>;

/** Who answers: a human (default) or an agent ($ORCH_AGENT_NAME). */
export interface DecisionActor {
  agent?: string;
}

export class DecisionService {
  private readonly answerHooks: DecisionAnswerHook[] = [];
  private router: DecisionRouter | undefined;

  constructor(
    private readonly store: IDecisionStore,
    private readonly taskStore: ITaskStore,
    private readonly taskService: TaskService,
    private readonly eventBus: EventBus,
  ) {}

  /** Set who answers new decisions first (see DecisionRouter). */
  setRouter(router: DecisionRouter): void {
    this.router = router;
  }

  /** Register a hook run on every answer (see DecisionAnswerHook). */
  onAnswer(hook: DecisionAnswerHook): void {
    this.answerHooks.push(hook);
  }

  async request(input: DecisionRequest): Promise<Decision> {
    const req = normalizeDecisionRequest(input);
    let task: Task | null = null;
    if (req.task_id) {
      task = await this.taskStore.get(req.task_id);
      if (!task) throw new TaskNotFoundError(req.task_id);
      if (isTerminal(task.status)) {
        throw new InvalidArgumentsError(`Task ${task.id} is ${task.status}; no decision can be requested on it`);
      }
    }

    const decision: Decision = {
      id: `dec_${nanoid(7)}`,
      status: 'pending',
      source: req.source,
      ...(req.task_id ? { task_id: req.task_id } : {}),
      ...(req.plan_id ? { plan_id: req.plan_id } : {}),
      question: req.question,
      options: req.options,
      ...(req.context ? { context: req.context } : {}),
      requested_by: req.requested_by ?? (req.source === 'escalation' ? 'orch' : 'human'),
      created_at: new Date().toISOString(),
    };
    const routed = this.router ? await this.router(decision, task) : undefined;
    if (routed) {
      decision.assignee = routed.assignee;
      decision.triage_task_id = routed.triage_task_id;
    }
    await this.store.save(decision);

    // A running task is moved when its run ends (the orchestrator owns it meanwhile).
    if (task && task.status !== 'in_progress' && task.status !== 'waiting_decision') {
      await this.taskService.updateStatus(task.id, 'waiting_decision');
    }

    this.eventBus.emit({
      type: 'decision:requested',
      decisionId: decision.id,
      ...(decision.task_id ? { taskId: decision.task_id } : {}),
      source: decision.source,
      question: decision.question,
      ...(decision.assignee ? { assignee: decision.assignee } : {}),
    });
    return decision;
  }

  async get(id: string): Promise<Decision> {
    const decision = await this.store.get(id);
    if (!decision) throw new InvalidArgumentsError(`Decision not found: ${id}`, 'List them with: orch decision list');
    return decision;
  }

  /** `assignee: 'human'` = decisions no role holds (a human's queue); a role name = that role's. */
  async list(filter: { status?: Decision['status']; taskId?: string; assignee?: string } = {}): Promise<Decision[]> {
    return (await this.store.list()).filter((d) =>
      (!filter.status || d.status === filter.status) && (!filter.taskId || d.task_id === filter.taskId)
      && (!filter.assignee || (filter.assignee === 'human' ? !d.assignee : d.assignee === filter.assignee)));
  }

  /**
   * Hand a decision a role holds (the PM) to a human, with the reason added to
   * its background. `by` is the agent that escalates it, or "orch".
   */
  async escalate(id: string, input: { by: string; note: string }): Promise<Decision> {
    const decision = await this.get(id);
    if (decision.status !== 'pending') throw new InvalidArgumentsError(`${id} was already answered`);
    if (!decision.assignee) throw new InvalidArgumentsError(`${id} is not assigned to a role; it already waits for a human`);
    if (input.by !== 'orch' && roleAgentIndex(decision.assignee, input.by) === null) {
      throw new InvalidArgumentsError(`${id} is assigned to the ${decision.assignee} role; ${input.by} cannot escalate it`);
    }
    const note = input.note.trim();
    if (!note) throw new InvalidArgumentsError('Say why a human must decide', 'orch decision escalate <id> -m "<why>"');
    const role = decision.assignee;
    delete decision.assignee;
    decision.context = [decision.context, `${input.by} escalated it: ${note}`].filter(Boolean).join('\n\n').slice(-MAX_CONTEXT_LENGTH);
    await this.store.save(decision);
    this.eventBus.emit({
      type: 'decision:escalated',
      decisionId: id,
      ...(decision.task_id ? { taskId: decision.task_id } : {}),
      from: role,
      by: input.by,
      note,
    });
    return decision;
  }

  /** Update the question/background of a pending decision (e.g. a plan submitted again). */
  async refresh(id: string, fields: { question?: string; context?: string }): Promise<Decision> {
    const decision = await this.get(id);
    if (decision.status !== 'pending') throw new InvalidArgumentsError(`${id} was already answered`);
    const req = normalizeDecisionRequest({
      source: decision.source,
      question: fields.question ?? decision.question,
      options: decision.options,
      context: fields.context ?? decision.context,
    });
    decision.question = req.question;
    if (req.context) decision.context = req.context;
    await this.store.save(decision);
    return decision;
  }

  async pendingFor(taskId: string): Promise<Decision[]> {
    return this.list({ status: 'pending', taskId });
  }

  async answer(id: string, input: DecisionAnswerInput, actor: DecisionActor = {}): Promise<AnswerResult> {
    const decision = await this.get(id);
    if (decision.status !== 'pending') {
      throw new InvalidArgumentsError(`${id} was already answered: ${describeAnswer(decision)}`);
    }
    if (actor.agent) {
      if (!decision.assignee) throw new InvalidArgumentsError(`${id} is for a human; agents cannot answer it`);
      if (roleAgentIndex(decision.assignee, actor.agent) === null) {
        throw new InvalidArgumentsError(`${id} is assigned to the ${decision.assignee} role; ${actor.agent} cannot answer it`);
      }
      if ((input.action ?? 'continue') !== 'continue' || input.scope === 'project') {
        throw new InvalidArgumentsError(
          `As ${decision.assignee} you can only answer the question (the task continues); approving, cancelling and project-wide rules are for a human`,
          'Answer with --choose / -m; put lasting rules into the PRD (orch prd add); or hand it over: orch decision escalate <id> -m "<why>"',
        );
      }
    }
    decision.answer = { ...resolveDecisionAnswer(decision, input), answered_by: actor.agent ?? 'human' };
    decision.status = 'answered';
    for (const hook of this.answerHooks) await hook(structuredClone(decision));
    await this.store.save(decision);
    this.eventBus.emit({
      type: 'decision:answered',
      decisionId: id,
      ...(decision.task_id ? { taskId: decision.task_id } : {}),
      action: decision.answer.action,
      scope: decision.answer.scope,
    });

    // A human answered before the PM got to it: its queued task is not needed any more.
    if (decision.triage_task_id && !actor.agent) {
      const pmTask = await this.taskStore.get(decision.triage_task_id).catch(() => null);
      if (pmTask && (pmTask.status === 'todo' || pmTask.status === 'retrying')) {
        await this.taskService.updateStatus(pmTask.id, 'cancelled').catch(() => {});
      }
    }

    if (!decision.task_id) return { decision, stillPending: 0 };
    const stillPending = (await this.pendingFor(decision.task_id)).length;
    const task = await this.taskStore.get(decision.task_id);
    if (!task || task.status !== 'waiting_decision' || stillPending > 0) {
      return { decision, stillPending };
    }
    return { decision, task: await this.apply(task, decision), stillPending };
  }

  /**
   * Answered decisions an agent working on `task` must follow: this task's
   * decisions plus the most recent project-wide ones, oldest first.
   */
  async bindingFor(task: Pick<Task, 'id'>): Promise<Decision[]> {
    const answered = (await this.store.list()).filter((d) => d.status === 'answered' && d.answer);
    const project = answered.filter((d) => d.answer!.scope === 'project' && d.task_id !== task.id)
      .slice(-MAX_PROJECT_DECISIONS_IN_PROMPT);
    const own = answered.filter((d) => d.task_id === task.id);
    return [...project, ...own]
      .sort((a, b) => a.answer!.answered_at.localeCompare(b.answer!.answered_at));
  }

  private async apply(task: Task, decision: Decision): Promise<Task> {
    const action = decision.answer!.action;
    if (action === 'cancel') return this.taskService.updateStatus(task.id, 'cancelled');

    if (action === 'approve' && decision.source === 'gate') {
      // Approving a gate starts the task (it has no work to merge yet).
      if (decision.answer!.choice || decision.answer!.message) task.feedback = buildDecisionFeedback(decision);
      task.updated_at = new Date().toISOString();
      await this.taskStore.save(task);
      return this.taskService.updateStatus(task.id, 'todo');
    }

    if (action === 'approve') {
      task.approved = true;
      task.updated_at = new Date().toISOString();
      await this.taskStore.save(task);
      return this.taskService.updateStatus(task.id, 'review');
    }

    if (action !== 'continue') throw new InvalidTransitionError(task.id, task.status, action);
    task.feedback = buildDecisionFeedback(decision);
    task.send_backs = 0; // a human gave it a fresh budget
    task.attempts = 0;
    delete task.approved;
    task.updated_at = new Date().toISOString();
    await this.taskStore.save(task);
    return this.taskService.updateStatus(task.id, 'todo');
  }
}

/** Feedback for the agent that continues after a decision. */
export function buildDecisionFeedback(decision: Decision): string {
  const by = decision.answer?.answered_by;
  const lines = [
    by && by !== 'human' ? `${by} (PM) answered a question about this task.` : 'A human answered a question about this task.',
    `Question: ${decision.question}`,
    `Answer: ${describeAnswer(decision)}`,
  ];
  if (decision.source === 'escalation' && decision.context) {
    lines.push('', 'Background (why it was escalated):', decision.context);
  }
  return lines.join('\n');
}
