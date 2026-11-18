/**
 * ReviewGate — the single path from `review` to `done`.
 *
 * Worktree tasks are merged into the main branch here, i.e. only after the
 * task passed review (auto-review criteria, auto-approve policy, or a human
 * `orch task approve`). Until then the worktree and its branch are kept so the
 * work can be inspected, reviewed in place, or reworked after a reject.
 *
 * Used by the orchestrator (automatic approval) and by the CLI/TUI approve
 * commands. It does not need the orchestrator lock: it only touches git and
 * the task file.
 */

import { InvalidTransitionError } from '../domain/errors.js';
import type { Task } from '../domain/task.js';
import type { ITaskStore } from '../infrastructure/storage/interfaces.js';
import type { IWorkspaceManager } from '../infrastructure/workspace/interface.js';
import type { EventBus } from './event-bus.js';
import type { TaskService } from './task-service.js';

export type ApproveResult =
  | { ok: true; merged: boolean }
  | { ok: false; detail: string };

export interface ReviewGateDeps {
  taskStore: ITaskStore;
  taskService: TaskService;
  workspaceManager: IWorkspaceManager;
  eventBus: EventBus;
}

const MERGE_PREFIX = /^MERGE (CONFLICT|ERROR): [\s\S]*?\n\n/;

export class ReviewGate {
  constructor(private readonly deps: ReviewGateDeps) {}

  /**
   * Approve a task in `review`: merge its worktree branch (if any), clean up the
   * worktree, then mark it `done`. If the merge fails the task stays in `review`
   * with the reason prepended to its summary, and the worktree is kept.
   */
  async approve(taskId: string): Promise<ApproveResult> {
    const task = await this.deps.taskService.get(taskId);
    if (task.status !== 'review') {
      throw new InvalidTransitionError(taskId, task.status, 'done');
    }

    const branch = task.proof?.branch;
    let merged = false;

    if (branch && !task.proof?.merged) {
      let failure: string | undefined;
      try {
        const result = await this.deps.workspaceManager.mergeBack(branch);
        if (!result.success) failure = `MERGE CONFLICT: ${result.conflictInfo}`;
      } catch (err) {
        failure = `MERGE ERROR: ${err instanceof Error ? err.message : String(err)}`;
      }

      if (failure) {
        await this.recordMergeFailure(task, failure);
        this.deps.eventBus.emit({
          type: 'workspace:merge_conflict',
          taskId,
          branch,
          conflictInfo: failure,
        });
        return { ok: false, detail: failure };
      }

      // Persist before cleanup so a crash between merge and `done` never merges twice.
      task.proof = { ...task.proof, files_changed: task.proof?.files_changed ?? [], merged: true };
      await this.deps.taskStore.save(task);
      merged = true;
      this.deps.eventBus.emit({ type: 'workspace:merge_succeeded', taskId, branch });

      await this.deps.workspaceManager.cleanup(taskId, branch).catch((err) => {
        this.deps.eventBus.emit({
          type: 'orchestrator:error',
          error: err instanceof Error ? err.message : String(err),
          context: `workspace cleanup for ${taskId}`,
          fatal: false,
        });
      });
    }

    await this.deps.taskService.updateStatus(taskId, 'done');
    return { ok: true, merged };
  }

  private async recordMergeFailure(task: Task, failure: string): Promise<void> {
    const summary = (task.proof?.agent_summary ?? '').replace(MERGE_PREFIX, '');
    task.proof = {
      ...task.proof,
      files_changed: task.proof?.files_changed ?? [],
      agent_summary: `${failure}\n\n${summary}`.slice(0, 2000),
    };
    task.updated_at = new Date().toISOString();
    await this.deps.taskStore.save(task);
  }
}
