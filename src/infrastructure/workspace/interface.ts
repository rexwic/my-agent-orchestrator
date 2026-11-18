/**
 * Workspace manager interface.
 */

import type { Agent } from '../../domain/agent.js';
import type { OrchestratorConfig } from '../../domain/config.js';
import type { Task } from '../../domain/task.js';
import type { MergeResult } from './merge-strategy.js';

export interface PrepareResult {
  path: string;
  branch?: string;
}

/** The commit task branches merge into: whatever is checked out in the project root. */
export interface TargetHead {
  sha: string;
  /** Branch name, or "HEAD" when detached. */
  name: string;
}

export type SyncResult =
  | { status: 'up_to_date' }
  | { status: 'merged' }
  /** The merge is left in progress in the worktree, with conflict markers in `files`. */
  | { status: 'conflict'; files: string[]; output: string }
  | { status: 'error'; output: string };

export interface IWorkspaceManager {
  prepare(task: Task, agent: Agent, config: OrchestratorConfig): Promise<PrepareResult>;
  mergeBack(branch: string): Promise<MergeResult>;
  cleanup(taskId: string, branch?: string): Promise<void>;
  validate(workspacePath: string, projectRoot: string): void;
  /** Get files changed on a worktree branch relative to its merge-base. */
  getChangedFiles(branch: string): Promise<string[]>;
  /** Commit all uncommitted changes in a worktree. Returns false if there was nothing to commit. */
  commitAll(workspacePath: string, message: string): Promise<boolean>;
  /** HEAD of the project root — the commit task branches are synced with and merged into. */
  targetHead(): Promise<TargetHead>;
  /**
   * Merge `sha` into the branch checked out in a worktree. On conflict the merge
   * is left in progress (markers in the files) so an agent can resolve it there.
   */
  syncWorktree(workspacePath: string, sha: string, message: string): Promise<SyncResult>;
  /**
   * Paths in a worktree that still contain conflict marker lines, checked among
   * the unmerged paths and `candidates` (paths relative to the worktree).
   */
  unresolvedConflicts(workspacePath: string, candidates: string[]): Promise<string[]>;
}
