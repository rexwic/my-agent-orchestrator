/**
 * IntegrationService — gets a finished worktree task onto the main branch.
 *
 *   commit → merge the latest main into the task branch → review the merged
 *   result → (approved) merge the branch back
 *
 * - Merging main in conflicts: the merge is left in progress in the worktree and
 *   the task goes back to `todo` (same role / assignee) with instructions.
 * - Review fails on the merged result: sent back with the report.
 *   Both count toward review.max_send_backs; past it the task waits in `review`.
 * - Merging back is serialized (a merge queue) and only happens while main is
 *   still the commit the task was verified against; if main moved, the task is
 *   synced and reviewed again first.
 *
 * Approval (`task.approved`) is a flag: auto policy / passing criteria set it
 * here; a human sets it via `orch task approve`. Whoever runs the orchestrator
 * picks approved tasks up and integrates them.
 *
 * Shared-mode tasks (no worktree) don't come through here.
 */

import type { OrchestratorConfig } from '../domain/config.js';
import type { ReviewCriterion, ReviewResult, Task } from '../domain/task.js';
import { normalizeRelativePath } from '../domain/scope.js';
import type { ITaskStore } from '../infrastructure/storage/interfaces.js';
import type { IWorkspaceManager, TargetHead } from '../infrastructure/workspace/interface.js';
import type { IShellRunner } from '../infrastructure/process/shell-runner.js';
import type { EventBus } from './event-bus.js';
import type { TaskService } from './task-service.js';
import { prefixSummary, type ReviewGate } from './review-gate.js';
import { ReviewRunner } from './review-runner.js';
import { Semaphore } from './semaphore.js';
import type { DecisionService } from './decision-service.js';

export const DEFAULT_MAX_SEND_BACKS = 3;
/** Re-sync attempts in one go when main keeps moving; the next tick tries again. */
const MAX_SYNC_ROUNDS = 3;
const FEEDBACK_REPORT_MAX = 3000;

export type IntegrationTrigger =
  /** The agent just finished: verify (sync + review) unconditionally. */
  | 'completed'
  /** The task was approved: merge, re-verifying only if main moved. */
  | 'approved';

export type IntegrationOutcome =
  | { status: 'done' }
  | { status: 'sent_back'; reason: SendBackReason; files?: string[] }
  /** Synced and reviewed; waits for a human to approve (manual policy, no criteria). */
  | { status: 'awaiting_approval' }
  /** Checks passed; a reviewer role reviews it next (it stays in review meanwhile). */
  | { status: 'awaiting_review' }
  /** Stays in review for a human. */
  | { status: 'review'; detail: string }
  /** Loop limit reached: a human decides (`orch decision answer`). */
  | { status: 'waiting_decision'; decisionId: string; detail: string }
  /** Still approved; retried on a later tick (shutting down, or main kept moving). */
  | { status: 'deferred'; detail: string }
  /** Not a worktree task in review, or already being integrated. */
  | { status: 'skipped' };

export type CommitOutcome =
  | { status: 'ok' }
  | { status: 'unresolved'; files: string[] }
  | { status: 'error'; detail: string };

export interface IntegrationDeps {
  taskStore: ITaskStore;
  taskService: TaskService;
  workspaceManager: IWorkspaceManager;
  eventBus: EventBus;
  reviewGate: ReviewGate;
  shellRunner: IShellRunner;
  config: OrchestratorConfig;
  /** Limits concurrent review runs (shared with shared-mode reviews). */
  reviewSlots?: Semaphore;
  /** Serializes task transitions with the caller's scheduler (the orchestrator state lock). */
  withLock?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** When true, approved tasks are left approved for the next start instead of merged. */
  isStopping?: () => boolean;
  /** Escalation: past the send-back limit a human decides (otherwise the task just waits in review). */
  decisions?: Pick<DecisionService, 'request'>;
  /** Review by a reviewer role once the checks pass (see ReviewService.gate). */
  agentReview?: { gate(task: Task): Promise<'not_required' | 'passed' | 'pending'> };
}

export class IntegrationService {
  private readonly mergeQueue = new Semaphore(1);
  private readonly inFlight = new Set<string>();
  private readonly reviewSlots: Semaphore;
  private readonly withLock: <T>(fn: () => Promise<T>) => Promise<T>;

  constructor(private readonly deps: IntegrationDeps) {
    this.reviewSlots = deps.reviewSlots ?? new Semaphore(1);
    this.withLock = deps.withLock ?? ((fn) => fn());
  }

  get maxSendBacks(): number {
    const n = this.deps.config.review?.max_send_backs;
    return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : DEFAULT_MAX_SEND_BACKS;
  }

  /** Is this task being integrated right now (by this process)? */
  isBusy(taskId: string): boolean {
    return this.inFlight.has(taskId);
  }

  /**
   * Commit what was left in a worktree. Refuses while conflicts from a main
   * sync are unresolved (unmerged paths or leftover markers), so markers never
   * get committed. Mutates `task.proof.conflict_files` (cleared on success);
   * the caller saves the task.
   */
  async commitWork(task: Task): Promise<CommitOutcome> {
    if (!task.workspace) return { status: 'ok' };
    const unresolved = await this.deps.workspaceManager.unresolvedConflicts(task.workspace, task.proof?.conflict_files ?? []);
    if (unresolved.length > 0) return { status: 'unresolved', files: unresolved };
    try {
      await this.deps.workspaceManager.commitAll(task.workspace, `orch: ${task.title} (${task.id})`);
    } catch (err) {
      return { status: 'error', detail: err instanceof Error ? err.message : String(err) };
    }
    if (task.proof?.conflict_files) delete task.proof.conflict_files;
    return { status: 'ok' };
  }

  /** Run review criteria in `cwd`, save the results on the task, return whether all passed. */
  async review(taskId: string, criteria: ReviewCriterion[], cwd: string): Promise<boolean> {
    const results = await this.reviewSlots.run(() =>
      new ReviewRunner({ cwd, shell: this.deps.shellRunner, review: this.deps.config.review }).runAll(criteria));
    return this.saveReview(taskId, results);
  }

  /**
   * Integrate a worktree task in `review`. Never throws for git/review problems:
   * they end as `review` (held for a human) or `sent_back`.
   */
  async process(taskId: string, opts: { trigger: IntegrationTrigger; autoApprove?: boolean }): Promise<IntegrationOutcome> {
    if (this.inFlight.has(taskId)) return { status: 'skipped' };
    this.inFlight.add(taskId);
    try {
      return await this.integrate(taskId, opts.trigger, opts.autoApprove ?? false);
    } catch (err) {
      const detail = `SYNC ERROR: ${err instanceof Error ? err.message : String(err)}`;
      const task = await this.deps.taskStore.get(taskId).catch(() => null);
      if (task?.status === 'review') await this.hold(task, detail);
      return { status: 'review', detail };
    } finally {
      this.inFlight.delete(taskId);
    }
  }

  private async integrate(taskId: string, trigger: IntegrationTrigger, autoApprove: boolean): Promise<IntegrationOutcome> {
    let verify = trigger === 'completed';

    for (let round = 0; round < MAX_SYNC_ROUNDS; round++) {
      let task = await this.deps.taskStore.get(taskId);
      if (!task || task.status !== 'review' || !task.proof?.branch || !task.workspace) return { status: 'skipped' };
      const workspace = task.workspace;
      const branch = task.proof.branch;
      const criteria = task.review_criteria ?? [];

      if (task.proof.merged) {
        // Merged before a crash/stop but never marked done: just finish it.
        const finished = await this.withLock(() => this.deps.reviewGate.approve(taskId));
        return finished.ok ? { status: 'done' } : { status: 'review', detail: finished.detail };
      }

      const target = await this.deps.workspaceManager.targetHead();

      if (round === 0) {
        // Commit what the agent (or a human, before approving) left in the worktree.
        const commit = await this.commitWork(task);
        if (commit.status === 'unresolved') {
          return trigger === 'completed'
            ? this.sendBack(task, 'conflict', target, { files: commit.files })
            : this.hold(task, `UNRESOLVED CONFLICT: ${commit.files.join(', ')} still contain conflicts in ${workspace}`);
        }
        if (commit.status === 'error') return this.hold(task, `COMMIT ERROR: ${commit.detail}`);
        if (!task.proof.files_changed?.length) {
          task.proof.files_changed = await this.deps.workspaceManager.getChangedFiles(branch);
        }
        await this.deps.taskStore.save(task);

        // Contracts the task follows (uses) are changed only by the task that produces them.
        if (trigger === 'completed' && task.uses?.length) {
          const changed = (await this.deps.workspaceManager.getChangedFiles(branch)).map(normalizeRelativePath);
          const touched = task.uses.filter((u) => changed.includes(u));
          if (touched.length) return this.sendBack(task, 'contract', target, { files: touched });
        }
      }

      if (verify || task.proof.synced_main !== target.sha) {
        const sync = await this.deps.workspaceManager.syncWorktree(workspace, target.sha, `orch: merge ${target.name} into ${branch}`);
        if (sync.status === 'conflict') {
          return this.sendBack(task, 'conflict', target, { files: sync.files });
        }
        if (sync.status === 'error') return this.hold(task, `SYNC ERROR: merging ${target.name} failed: ${sync.output}`);

        task.proof = { ...task.proof, files_changed: task.proof.files_changed ?? [], synced_main: target.sha };
        await this.deps.taskStore.save(task);
        this.deps.eventBus.emit({ type: 'task:synced', taskId, target: target.name, sha: target.sha, merged: sync.status === 'merged' });

        if (criteria.length > 0) {
          const passed = await this.review(taskId, criteria, workspace);
          if (!passed) {
            task = (await this.deps.taskStore.get(taskId)) ?? task;
            return this.sendBack(task, 'review', target, { report: task.proof?.test_results ?? '' });
          }
        }
        verify = false;
      }

      // A reviewer role reviews work that just passed its checks (a human approval skips it).
      task = (await this.deps.taskStore.get(taskId)) ?? task;
      if (trigger === 'completed' && !task.approved && this.deps.agentReview) {
        const current = task;
        const gate = await this.withLock(() => this.deps.agentReview!.gate(current));
        // (A passed review approves through ReviewService; afterwards the usual rules apply.)
        if (gate === 'pending') return { status: 'awaiting_review' };
        task = (await this.deps.taskStore.get(taskId)) ?? task;
      }

      // Passing criteria approve (as before); without criteria the approval policy decides.
      if (!task.approved) {
        if (!autoApprove && criteria.length === 0) return { status: 'awaiting_approval' };
        task.approved = true;
        await this.deps.taskStore.save(task);
        this.deps.eventBus.emit({ type: 'task:approved', taskId });
      }

      if (this.deps.isStopping?.()) return { status: 'deferred', detail: 'shutting down' };

      const verifiedAgainst = task.proof?.synced_main;
      const merge = await this.mergeQueue.run(async () => {
        const now = await this.deps.workspaceManager.targetHead();
        if (now.sha !== verifiedAgainst) return null; // main moved since verification
        return this.withLock(() => this.deps.reviewGate.approve(taskId));
      });
      if (merge === null) {
        verify = true;
        continue;
      }
      if (merge.ok) return { status: 'done' };

      // Merge into main failed (e.g. local changes in the project root). Wait for a human.
      const failed = await this.deps.taskStore.get(taskId);
      if (failed) {
        delete failed.approved;
        await this.deps.taskStore.save(failed);
      }
      return { status: 'review', detail: merge.detail };
    }

    return { status: 'deferred', detail: `main kept moving; retrying ${taskId} later` };
  }

  /**
   * Send the task back to its role/assignee (review → todo) with feedback, or
   * hold it in review once the send-back limit is reached.
   */
  private async sendBack(
    task: Task,
    reason: SendBackReason,
    target: TargetHead,
    info: { files?: string[]; report?: string },
  ): Promise<IntegrationOutcome> {
    const count = task.send_backs ?? 0;
    const max = this.maxSendBacks;

    if (count >= max) {
      if (reason === 'conflict') {
        // Keep the conflict in the worktree and remember the files, so whoever
        // resolves it by hand is checked for leftover markers on approve.
        task.proof = { ...task.proof, files_changed: task.proof?.files_changed ?? [], conflict_files: info.files ?? [] };
        this.deps.eventBus.emit({
          type: 'workspace:merge_conflict',
          taskId: task.id,
          branch: task.proof.branch ?? '',
          conflictInfo: `merging ${target.name} into the task branch: ${(info.files ?? []).join(', ')}`,
        });
      }
      const what = reason === 'conflict'
        ? `SYNC CONFLICT: merging ${target.name} conflicts in ${(info.files ?? []).join(', ')} (resolve in ${task.workspace}, then approve)`
        : reason === 'contract'
          ? `CONTRACT CHANGED: the task changed ${(info.files ?? []).join(', ')}, which it must follow (approving accepts the change)`
          : `REVIEW FAILED: review failed after merging ${target.name}`;
      const held = await this.hold(task, `${what} — sent back ${count} time(s) already, waiting for a human`);
      return this.escalate(task, reason, target, info, count, held);
    }

    const sentBack = await this.withLock(async () => {
      const fresh = await this.deps.taskStore.get(task.id);
      if (!fresh || fresh.status !== 'review') return false;
      fresh.send_backs = count + 1;
      fresh.feedback = buildSendBackFeedback(reason, target.name, info);
      fresh.attempts = 0;
      delete fresh.approved;
      fresh.proof = {
        ...fresh.proof,
        files_changed: fresh.proof?.files_changed ?? [],
        ...(reason === 'conflict' ? { conflict_files: info.files ?? [] } : {}),
      };
      await this.deps.taskStore.save(fresh);
      await this.deps.taskService.updateStatus(task.id, 'todo');
      return true;
    });
    if (!sentBack) return { status: 'skipped' };

    this.deps.eventBus.emit({
      type: 'task:sent_back',
      taskId: task.id,
      reason,
      count: count + 1,
      max,
      ...(info.files ? { files: info.files } : {}),
    });
    return { status: 'sent_back', reason, ...(info.files ? { files: info.files } : {}) };
  }

  /**
   * Past the send-back limit: ask a human instead of looping. The decision
   * carries what the agent would have been told, so "continue" can resume it.
   */
  private async escalate(
    task: Task,
    reason: SendBackReason,
    target: TargetHead,
    info: { files?: string[]; report?: string },
    count: number,
    held: IntegrationOutcome,
  ): Promise<IntegrationOutcome> {
    if (!this.deps.decisions || held.status !== 'review') return held;
    const after = count > 0 ? ` after ${count} send-back(s)` : '';
    const question = reason === 'conflict'
      ? `"${task.title}" ${count > 0 ? 'still ' : ''}conflicts with ${target.name}${after} (${(info.files ?? []).join(', ')}). How should we proceed?`
      : reason === 'contract'
        ? `"${task.title}" keeps changing the contract ${(info.files ?? []).join(', ')}${after}. Should the contract change (approve), or how should the task follow it?`
        : `Review ${count > 0 ? 'keeps failing' : 'fails'} for "${task.title}" after merging ${target.name}${count > 0 ? ` (${count} send-back(s))` : ''}. How should we proceed?`;
    const decision = await this.withLock(() => this.deps.decisions!.request({
      task_id: task.id,
      source: 'escalation',
      question,
      context: buildSendBackFeedback(reason, target.name, info),
      requested_by: 'orch',
    }));
    return { status: 'waiting_decision', decisionId: decision.id, detail: held.detail };
  }

  /** Keep the task in review for a human, with the reason in front of its summary. */
  private async hold(task: Task, detail: string): Promise<IntegrationOutcome> {
    await this.withLock(async () => {
      const fresh = (await this.deps.taskStore.get(task.id)) ?? task;
      fresh.proof = {
        ...task.proof,
        ...fresh.proof,
        ...(task.proof?.conflict_files ? { conflict_files: task.proof.conflict_files } : {}),
        files_changed: fresh.proof?.files_changed ?? task.proof?.files_changed ?? [],
        agent_summary: prefixSummary(fresh.proof?.agent_summary, detail),
      };
      delete fresh.approved;
      fresh.updated_at = new Date().toISOString();
      await this.deps.taskStore.save(fresh);
    });
    this.deps.eventBus.emit({ type: 'orchestrator:error', error: detail, context: `integrate task ${task.id}`, fatal: false });
    return { status: 'review', detail };
  }

  private async saveReview(taskId: string, results: ReviewResult[]): Promise<boolean> {
    const allPassed = ReviewRunner.allPassed(results);
    const task = await this.deps.taskStore.get(taskId);
    if (!task) return false;
    task.review_results = results;
    task.proof = {
      ...task.proof,
      test_results: ReviewRunner.formatReport(results),
      files_changed: task.proof?.files_changed ?? [],
    };
    await this.deps.taskStore.save(task);
    this.deps.eventBus.emit({ type: 'task:auto_reviewed', taskId, passed: allPassed, results });
    return allPassed;
  }
}

/** Instructions for the agent that gets a task sent back. */
/** Why ORCH sent a task back to its agent. */
export type SendBackReason = 'conflict' | 'review' | 'contract';

export function buildSendBackFeedback(
  reason: SendBackReason,
  target: string,
  info: { files?: string[]; report?: string },
): string {
  if (reason === 'contract') {
    const files = info.files ?? [];
    return [
      'This task changed contract file(s) it must follow:',
      ...files.map((f) => `- ${f}`),
      '',
      'A contract is the agreement between tasks (for example the API between frontend and backend). Only the task that produces it changes it.',
      `Restore the contract from \`${target}\`: git checkout ${target} -- ${files.join(' ')}`,
      'Then make your code follow the contract as it is. If the contract is wrong or missing something, do not change it: ask with `orch decision request "<question>"` and end your run.',
    ].join('\n');
  }
  if (reason === 'conflict') {
    const files = (info.files ?? []).map((f) => `- ${f}`).join('\n');
    return [
      `ORCH merged the latest \`${target}\` into this task's branch before review, and it conflicts with this task's changes.`,
      'The merge is still in progress in your workspace. These files contain conflict markers (<<<<<<< / ======= / >>>>>>>):',
      files,
      '',
      `Resolve every conflict so that both sides' intent is kept (the changes that came from \`${target}\` and this task's changes).`,
      'Remove all markers, make sure the code builds and the tests pass, then `git add` the files — ORCH completes the merge commit.',
      'Do not run `git merge --abort` or `git reset`.',
    ].join('\n');
  }
  const report = (info.report ?? '').trim();
  const tail = report.length > FEEDBACK_REPORT_MAX ? `…${report.slice(-FEEDBACK_REPORT_MAX)}` : report;
  return [
    `ORCH merged the latest \`${target}\` into this task's branch and ran the review checks on the result. They failed.`,
    `The cause may be this task's changes or how they combine with the changes that came from \`${target}\`.`,
    'Fix it in your workspace so every check passes, keeping both sides\' intent:',
    '',
    tail,
  ].join('\n');
}
