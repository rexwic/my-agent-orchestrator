/**
 * Syncing main into a task worktree (real git): merge main in before review,
 * leave conflicts in progress for the agent, detect leftover markers, and
 * conclude the merge on commit.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceManager } from '../../../src/infrastructure/workspace/workspace-manager.js';
import { ProcessManager } from '../../../src/infrastructure/process/process-manager.js';
import { DEFAULT_CONFIG } from '../../../src/domain/config.js';
import type { Task } from '../../../src/domain/task.js';
import type { Agent } from '../../../src/domain/agent.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const readText = async (p: string): Promise<string> => (await fs.readFile(p, 'utf-8')).replace(/\r\n/g, '\n');

const task = { id: 'tsk_s1', title: 'Order API', workspace_mode: 'worktree' } as Task;
const agent = { config: {} } as Agent;

describe('WorkspaceManager sync with main (real git)', { timeout: 90_000 }, () => {
  let repo: string;
  let manager: WorkspaceManager;
  let ws: string;
  let branch: string;

  /** Commit a file on the main branch (the project root). */
  const commitOnMain = async (file: string, content: string) => {
    await fs.writeFile(path.join(repo, file), content);
    git(repo, 'add', file);
    git(repo, 'commit', '-qm', `main: ${file}`);
  };

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-sync-'));
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'user.email', 'test@example.invalid');
    git(repo, 'config', 'commit.gpgsign', 'false');
    git(repo, 'config', 'core.autocrlf', 'false');
    await fs.writeFile(path.join(repo, 'Order.java'), 'class Order {\n  int total;\n}\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'init');
    manager = new WorkspaceManager(repo, path.join(repo, '.orchestry'), new ProcessManager());
    const prepared = await manager.prepare(task, agent, DEFAULT_CONFIG);
    ws = prepared.path;
    branch = prepared.branch!;
  }, 60_000);

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true, maxRetries: 5 });
  });

  it('reports the target head of the project root', async () => {
    const head = await manager.targetHead();
    expect(head.sha).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(head.name).toBe(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'));
  });

  it('is up to date when main has not moved', async () => {
    await fs.writeFile(path.join(ws, 'OrderApi.java'), 'class OrderApi {}\n');
    await manager.commitAll(ws, 'task work');
    const { sha } = await manager.targetHead();

    await expect(manager.syncWorktree(ws, sha, 'sync')).resolves.toEqual({ status: 'up_to_date' });
  });

  it('merges new main commits into the task branch; merging back is then conflict-free', async () => {
    await fs.writeFile(path.join(ws, 'OrderApi.java'), 'class OrderApi {}\n');
    await manager.commitAll(ws, 'task work');
    await commitOnMain('User.java', 'class User {}\n');
    const { sha } = await manager.targetHead();

    await expect(manager.syncWorktree(ws, sha, 'orch: merge main')).resolves.toEqual({ status: 'merged' });

    // The task's own commit is kept as-is (merge, not rebase) and main's file arrived.
    expect(git(ws, 'log', '--format=%s', '-3')).toContain('task work');
    expect(await readText(path.join(ws, 'User.java'))).toBe('class User {}\n');
    expect(git(ws, 'merge-base', '--is-ancestor', sha, 'HEAD')).toBe('');
    expect(await manager.getChangedFiles(branch)).toEqual(['OrderApi.java']);
    await expect(manager.mergeBack(branch)).resolves.toEqual({ success: true });
  });

  it('leaves a conflicting merge in progress with markers, and reports the files', async () => {
    await fs.writeFile(path.join(ws, 'Order.java'), 'class Order {\n  long total;\n}\n');
    await manager.commitAll(ws, 'task: long total');
    await commitOnMain('Order.java', 'class Order {\n  BigDecimal total;\n}\n');
    const { sha } = await manager.targetHead();

    const result = await manager.syncWorktree(ws, sha, 'orch: merge main');

    expect(result).toMatchObject({ status: 'conflict', files: ['Order.java'] });
    expect(git(ws, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toBe(sha);
    expect(await readText(path.join(ws, 'Order.java'))).toMatch(/^<<<<<<< /m);
    await expect(manager.unresolvedConflicts(ws, [])).resolves.toEqual(['Order.java']);
  });

  it('treats a conflict as resolved once the markers are gone, and commitAll concludes the merge', async () => {
    await fs.writeFile(path.join(ws, 'Order.java'), 'class Order {\n  long total;\n}\n');
    await manager.commitAll(ws, 'task: long total');
    await commitOnMain('Order.java', 'class Order {\n  BigDecimal total;\n}\n');
    const { sha } = await manager.targetHead();
    await manager.syncWorktree(ws, sha, 'orch: merge main');

    // The agent resolves without `git add` — still fine.
    await fs.writeFile(path.join(ws, 'Order.java'), 'class Order {\n  BigDecimal total;\n  long legacyTotal;\n}\n');
    await expect(manager.unresolvedConflicts(ws, ['Order.java'])).resolves.toEqual([]);

    await expect(manager.commitAll(ws, 'orch: resolve')).resolves.toBe(true);

    expect(git(ws, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3); // merge commit
    expect(git(ws, 'merge-base', '--is-ancestor', sha, 'HEAD')).toBe('');
    await expect(manager.mergeBack(branch)).resolves.toEqual({ success: true });
    expect(await readText(path.join(repo, 'Order.java'))).toContain('legacyTotal');
  });

  it('concludes a merge even when the resolution leaves nothing to stage', async () => {
    await fs.writeFile(path.join(ws, 'Order.java'), 'class Order {\n  long total;\n}\n');
    await manager.commitAll(ws, 'task: long total');
    await commitOnMain('Order.java', 'class Order {\n  BigDecimal total;\n}\n');
    const { sha } = await manager.targetHead();
    await manager.syncWorktree(ws, sha, 'orch: merge main');
    // Resolved by taking the task's side and staging it: the tree equals HEAD.
    git(ws, 'checkout', '--ours', 'Order.java');
    git(ws, 'add', 'Order.java');

    await expect(manager.commitAll(ws, 'orch: resolve')).resolves.toBe(true);

    expect(() => git(ws, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toThrow();
    expect(git(ws, 'merge-base', '--is-ancestor', sha, 'HEAD')).toBe('');
  });

  it('finds leftover markers in files that are no longer unmerged', async () => {
    await fs.writeFile(path.join(ws, 'Order.java'), '<<<<<<< HEAD\nlong total;\n=======\nBigDecimal total;\n>>>>>>> main\n');
    git(ws, 'add', 'Order.java');

    await expect(manager.unresolvedConflicts(ws, ['Order.java', 'Missing.java'])).resolves.toEqual(['Order.java']);
  });
});
