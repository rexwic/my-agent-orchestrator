/**
 * BugService — bugs filed by a verifying role, their owner, hand-offs, and the
 * second verification round. See domain/bug.ts for the rules.
 */

import {
  BUG_LABEL,
  MAX_BUG_REASSIGNS,
  VERIFY_LABEL,
  bugDescription,
  validateNewBug,
  type BugInfo,
  type NewBugInput,
} from '../domain/bug.js';
import type { OrchestratorConfig } from '../domain/config.js';
import { MAX_CONTEXT_LENGTH, type Decision } from '../domain/decision.js';
import { InvalidArgumentsError, TaskNotFoundError } from '../domain/errors.js';
import type { Role } from '../domain/role.js';
import { hasGlob, isProjectRelativePath } from '../domain/scope.js';
import type { Task } from '../domain/task.js';
import { isTerminal } from '../domain/transitions.js';
import type { IRoleStore, ITaskStore } from '../infrastructure/storage/interfaces.js';
import type { DecisionService } from './decision-service.js';
import type { EventBus } from './event-bus.js';
import type { TaskService } from './task-service.js';

export interface BugServiceDeps {
  taskStore: ITaskStore;
  taskService: TaskService;
  roleStore: IRoleStore;
  decisionService: DecisionService;
  eventBus: EventBus;
  config: OrchestratorConfig;
}

/** What prompts get: how to file bugs (verifier), how to hand one off (owner), what to re-verify. */
export type BugPromptContext =
  | { kind: 'file'; owners: string[] }
  | { kind: 'bug'; can_reassign: boolean; owners: string[]; contract?: string }
  | { kind: 'verify'; round: number; bugs: Array<{ id: string; title: string; owner?: string; repro: string; expected: string; actual: string }> };

export class BugService {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: BugServiceDeps) {
    deps.decisionService.onAnswer((d) => this.onDecisionAnswered(d));
    deps.eventBus.on('task:status_changed', (e) => {
      if (e.to === 'done' || e.to === 'cancelled') {
        void this.serial(() => this.maybeReverify(e.taskId)).catch((err: unknown) => {
          deps.eventBus.emit({ type: 'orchestrator:error', error: err instanceof Error ? err.message : String(err), context: `re-verification after ${e.taskId}`, fatal: false });
        });
      }
    });
  }

  /** One at a time: two bugs finishing together must not open two re-verifications. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async roles(): Promise<Role[]> {
    return this.deps.roleStore.list().catch(() => []);
  }

  /** Roles a bug filed by `verifierRole` may go to. */
  private async allowedOwners(verifierRole: string | undefined): Promise<string[]> {
    const roles = await this.roles();
    const verifier = roles.find((r) => r.name === verifierRole);
    if (verifier?.bug_owners?.length) return verifier.bug_owners.filter((n) => roles.some((r) => r.name === n));
    return roles.filter((r) => r.name !== verifierRole && !r.duties?.some((d) => d === 'review' || d === 'plan')).map((r) => r.name);
  }

  /** File a bug. `reporterTaskId` is the verifying task ($ORCH_TASK_ID); without it a human files it. */
  async add(input: Partial<NewBugInput>, reporter: { taskId?: string; by: string }): Promise<Task> {
    const b = validateNewBug(input);
    const from = reporter.taskId ? await this.deps.taskStore.get(reporter.taskId) : null;
    if (reporter.taskId && !from) throw new TaskNotFoundError(reporter.taskId);
    if (from?.verify_bugs?.length) {
      throw new InvalidArgumentsError('This round only re-verifies earlier bugs; new bugs cannot be filed now', 'Mention new problems in your summary; a human decides what to do with them');
    }
    if (from) {
      const role = (await this.roles()).find((r) => r.name === from.role);
      if (!role?.duties?.includes('verify')) {
        throw new InvalidArgumentsError(`Only a verifying role files bugs (${from.role ?? 'this task'} has no verify duty)`, 'Ask with orch decision request instead');
      }
    }
    const owners = await this.allowedOwners(from?.role);
    if (!owners.includes(b.owner)) {
      throw new InvalidArgumentsError(`"${b.owner}" cannot own a bug${from ? ` filed by ${from.role}` : ''}`, `Pick exactly one of: ${owners.join(', ') || 'none'}`);
    }
    if (b.contract && (!isProjectRelativePath(b.contract) || hasGlob(b.contract))) {
      throw new InvalidArgumentsError(`--contract "${b.contract}" must be a file path relative to the project root`);
    }
    const bug: BugInfo = {
      ...(from ? { found_by: from.id } : {}),
      reporter: reporter.by,
      repro: b.repro,
      expected: b.expected,
      actual: b.actual,
      ...(b.contract ? { contract: b.contract } : {}),
      ...(b.evidence ? { evidence: b.evidence } : {}),
      round: 1,
    };
    const task = await this.deps.taskService.create({
      title: `Bug: ${b.title}`,
      description: bugDescription({ ...b, reporter: reporter.by }),
      role: b.owner,
      priority: 2,
      labels: [BUG_LABEL],
      bug,
      ...(from?.goalId ? { goalId: from.goalId } : {}),
      ...(from?.prd ? { prd: from.prd } : {}),
      ...(b.contract ? { uses: [b.contract] } : {}),
    });
    this.deps.eventBus.emit({ type: 'bug:filed', taskId: task.id, owner: b.owner, ...(from ? { foundBy: from.id } : {}), title: b.title });
    return task;
  }

  /**
   * Hand a bug to another role. The first hand-off is applied (at the end of
   * the owner's run if it is running); a further one asks a human to pick.
   */
  async reassign(input: { bugTaskId: string; to: string; reason: string; by: string }): Promise<{ result: 'applied' | 'after_run' | 'decision'; task: Task; decisionId?: string }> {
    const task = await this.deps.taskStore.get(input.bugTaskId);
    if (!task?.bug) throw new InvalidArgumentsError(`${input.bugTaskId} is not a bug`);
    if (isTerminal(task.status)) throw new InvalidArgumentsError(`Bug ${task.id} is ${task.status}`);
    const reason = input.reason.trim();
    if (!reason) throw new InvalidArgumentsError('Say why it is not yours (-m "<reason>")', 'e.g. "the backend follows the contract; the frontend sends price as a string"');
    if (input.to === task.role) throw new InvalidArgumentsError(`${task.id} already belongs to ${input.to}`);
    const found = task.bug.found_by ? await this.deps.taskStore.get(task.bug.found_by).catch(() => null) : null;
    const owners = await this.allowedOwners(found?.role);
    if (!owners.includes(input.to)) throw new InvalidArgumentsError(`"${input.to}" cannot own this bug`, `Roles: ${owners.join(', ')}`);

    const done = task.bug.reassigned ?? [];
    if (done.length >= MAX_BUG_REASSIGNS) {
      const history = done.map((h) => `${h.from} → ${h.to} (${h.by}): ${h.reason}`);
      const decision = await this.deps.decisionService.request({
        task_id: task.id,
        source: 'bug',
        bug_ids: [task.id],
        question: `Who fixes bug "${task.title.replace(/^Bug: /, '')}"? It was handed off already and ${task.role} says it is not theirs either.`,
        options: [...new Set([task.role!, input.to, ...done.map((h) => h.from)])],
        context: [...history, `${task.role} (${input.by}) → ${input.to}: ${reason}`, '', task.description].join('\n').slice(0, MAX_CONTEXT_LENGTH),
        requested_by: input.by,
      });
      return { result: 'decision', task: (await this.deps.taskStore.get(task.id))!, decisionId: decision.id };
    }
    if (task.status === 'in_progress') {
      task.bug = { ...task.bug, handoff: { to: input.to, reason, by: input.by } };
      await this.deps.taskStore.save(task);
      return { result: 'after_run', task };
    }
    return { result: 'applied', task: await this.applyReassign(task, input.to, reason, input.by) };
  }

  /** At the end of the owner's run: apply a hand-off it asked for. True if one was applied. */
  async applyHandoff(task: Task): Promise<boolean> {
    const h = task.bug?.handoff;
    if (!h) return false;
    await this.applyReassign(task, h.to, h.reason, h.by);
    return true;
  }

  private async applyReassign(task: Task, to: string, reason: string, by: string): Promise<Task> {
    const fresh = (await this.deps.taskStore.get(task.id)) ?? task;
    const from = fresh.role ?? '?';
    const { handoff: _handoff, ...bug } = fresh.bug!;
    fresh.bug = { ...bug, reassigned: [...(bug.reassigned ?? []), { from, to, reason, by, at: new Date().toISOString() }] };
    fresh.role = to;
    delete fresh.assignee;
    fresh.attempts = 0;
    delete fresh.approved;
    fresh.feedback = `${from} (${by}) handed this bug to your role: ${reason}\nIt is yours now. Fix it; a further hand-off goes to a human.`;
    fresh.updated_at = new Date().toISOString();
    await this.deps.taskStore.save(fresh);
    if (fresh.status !== 'todo') await this.deps.taskService.updateStatus(fresh.id, 'todo');
    this.deps.eventBus.emit({ type: 'bug:reassigned', taskId: fresh.id, from, to, by });
    return (await this.deps.taskStore.get(fresh.id))!;
  }

  /** Re-verification of a bug (from the re-verify task, or a human). */
  async verify(input: { bugTaskId: string; fixed: boolean; note?: string; by: string; verifyTaskId?: string }): Promise<Task> {
    const task = await this.deps.taskStore.get(input.bugTaskId);
    if (!task?.bug) throw new InvalidArgumentsError(`${input.bugTaskId} is not a bug`);
    if (input.verifyTaskId) {
      const v = await this.deps.taskStore.get(input.verifyTaskId);
      if (!v?.verify_bugs?.includes(task.id)) throw new InvalidArgumentsError(`${task.id} is not one of the bugs your task re-verifies (${v?.verify_bugs?.join(', ') || 'none'})`);
    }
    if (!input.fixed && !input.note?.trim()) throw new InvalidArgumentsError('Say what is still wrong (-m "<what you saw>")');
    task.bug = { ...task.bug, verified: { fixed: input.fixed, ...(input.note?.trim() ? { note: input.note.trim() } : {}), by: input.by, at: new Date().toISOString() } };
    await this.deps.taskStore.save(task);
    this.deps.eventBus.emit({ type: 'bug:verified', taskId: task.id, fixed: input.fixed, by: input.by });
    return task;
  }

  /** A re-verify task's run is done once every bug it covers has a verdict. */
  async verifyOutcome(verifyTask: Task): Promise<'submitted' | 'missing'> {
    const bugs = await Promise.all((verifyTask.verify_bugs ?? []).map((id) => this.deps.taskStore.get(id).catch(() => null)));
    return bugs.every((b) => !b?.bug || (b.bug.verified && b.bug.verified.at >= verifyTask.created_at)) ? 'submitted' : 'missing';
  }

  /** The re-verify task finished: bugs still broken go to a human. */
  async verifyFinished(verifyTask: Task): Promise<void> {
    const bugs = (await Promise.all((verifyTask.verify_bugs ?? []).map((id) => this.deps.taskStore.get(id).catch(() => null))))
      .filter((b): b is Task => Boolean(b?.bug?.verified && !b.bug.verified.fixed));
    if (!bugs.length) return;
    await this.deps.decisionService.request({
      source: 'bug',
      bug_ids: bugs.map((b) => b.id),
      question: `${bugs.length} bug(s) are still broken after re-verification. Reopen them for their owners with your instructions (answer), accept them as they are (approve), or drop them (cancel)?`,
      context: bugs.map((b) => `- ${b.id} ${b.title} [${b.role}]: ${b.bug!.verified!.note ?? ''}`).join('\n').slice(0, MAX_CONTEXT_LENGTH),
      requested_by: verifyTask.assignee ?? 'orch',
    });
  }

  /** When every bug one verification filed is closed, open the next round (re-verify those only). */
  private async maybeReverify(taskId: string): Promise<void> {
    const task = await this.deps.taskStore.get(taskId);
    const foundBy = task?.bug?.found_by;
    if (!task?.bug || !foundBy) return;
    const all = await this.deps.taskStore.list();
    const round = task.bug.round;
    const siblings = all.filter((t) => t.bug?.found_by === foundBy && t.bug.round === round);
    if (siblings.some((t) => !isTerminal(t.status))) return;
    const toCheck = siblings.filter((t) => t.status === 'done').map((t) => t.id);
    if (!toCheck.length) return;
    if (all.some((t) => t.verify_bugs?.some((id) => toCheck.includes(id)))) return; // already opened
    const verifier = await this.deps.taskStore.get(foundBy);
    if (!verifier?.role) return;
    const bugs = siblings.filter((t) => t.status === 'done');
    await this.deps.taskService.create({
      title: `Re-verify ${bugs.length} bug(s) from "${verifier.title}"`,
      description: ['Re-verify only these bugs (fixed or not):', ...bugs.map((b) => `- ${b.id} ${b.title} [${b.role}]`)].join('\n'),
      role: verifier.role,
      priority: 2,
      labels: [VERIFY_LABEL],
      review_criteria: [],
      verify_bugs: toCheck,
      ...(verifier.goalId ? { goalId: verifier.goalId } : {}),
      ...(verifier.prd ? { prd: verifier.prd } : {}),
    });
  }

  /** Answers about bugs: who owns a bug after a second hand-off; reopen bugs still broken. */
  private async onDecisionAnswered(d: Decision): Promise<void> {
    if (d.source !== 'bug' || !d.bug_ids?.length || !d.answer) return;
    if (d.task_id) {
      // Owner dispute: the chosen role owns it (the answer then continues the task).
      const owner = d.answer.choice;
      if (!owner || d.answer.action !== 'continue') return;
      const task = await this.deps.taskStore.get(d.task_id);
      if (!task?.bug || task.role === owner) return;
      const from = task.role ?? '?';
      const { handoff: _h, ...bug } = task.bug;
      task.bug = { ...bug, reassigned: [...(bug.reassigned ?? []), { from, to: owner, reason: d.answer.message ?? 'a human decided', by: 'human', at: new Date().toISOString() }] };
      task.role = owner;
      delete task.assignee;
      await this.deps.taskStore.save(task);
      this.deps.eventBus.emit({ type: 'bug:reassigned', taskId: task.id, from, to: owner, by: 'human' });
      return;
    }
    if (d.answer.action !== 'continue') return;
    // Reopen: a new bug task per bug still broken, with the human's instructions.
    for (const id of d.bug_ids) {
      const old = await this.deps.taskStore.get(id);
      if (!old?.bug || !old.role) continue;
      const bug: BugInfo = {
        ...(old.bug.found_by ? { found_by: old.bug.found_by } : {}),
        reporter: old.bug.reporter,
        repro: old.bug.repro,
        expected: old.bug.expected,
        actual: old.bug.verified?.note ? `${old.bug.actual}\nStill seen after the fix: ${old.bug.verified.note}` : old.bug.actual,
        ...(old.bug.contract ? { contract: old.bug.contract } : {}),
        ...(old.bug.evidence ? { evidence: old.bug.evidence } : {}),
        round: old.bug.round + 1,
      };
      await this.deps.taskService.create({
        title: old.title,
        description: `${old.description}\n\nReopened: the fix in ${old.id} did not solve it.\n${old.bug.verified?.note ? `Re-verification: ${old.bug.verified.note}\n` : ''}A human says: ${[d.answer.choice, d.answer.message].filter(Boolean).join(' — ')}`,
        role: old.role,
        priority: 1,
        labels: [BUG_LABEL],
        bug,
        ...(old.goalId ? { goalId: old.goalId } : {}),
        ...(old.prd ? { prd: old.prd } : {}),
        ...(old.uses?.length ? { uses: old.uses } : {}),
      });
    }
  }

  async promptContext(task: Task): Promise<BugPromptContext | undefined> {
    if (task.verify_bugs?.length) {
      const bugs = (await Promise.all(task.verify_bugs.map((id) => this.deps.taskStore.get(id).catch(() => null)))).filter((b): b is Task => Boolean(b?.bug));
      return {
        kind: 'verify',
        round: (bugs[0]?.bug?.round ?? 1) + 1,
        bugs: bugs.map((b) => ({ id: b.id, title: b.title, ...(b.role ? { owner: b.role } : {}), repro: b.bug!.repro, expected: b.bug!.expected, actual: b.bug!.actual })),
      };
    }
    if (task.bug) {
      const found = task.bug.found_by ? await this.deps.taskStore.get(task.bug.found_by).catch(() => null) : null;
      return {
        kind: 'bug',
        can_reassign: (task.bug.reassigned?.length ?? 0) < MAX_BUG_REASSIGNS,
        owners: (await this.allowedOwners(found?.role)).filter((n) => n !== task.role),
        ...(task.bug.contract ? { contract: task.bug.contract } : {}),
      };
    }
    const role = (await this.roles()).find((r) => r.name === task.role);
    if (role?.duties?.includes('verify') && !task.plan_id && !task.review_of) {
      return { kind: 'file', owners: await this.allowedOwners(role.name) };
    }
    return undefined;
  }
}
