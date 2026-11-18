/**
 * WorkspaceManager.commitAll + the worktree lifecycle against a real git repo:
 * uncommitted agent work must survive until it is merged.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceManager } from '../../../src/infrastructure/workspace/workspace-manager.js';
import { ProcessManager } from '../../../src/infrastructure/process/process-manager.js';
import { WorkspaceError } from '../../../src/domain/errors.js';
import { DEFAULT_CONFIG } from '../../../src/domain/config.js';
import type { Task } from '../../../src/domain/task.js';
import type { Agent } from '../../../src/domain/agent.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const task = { id: 'tsk_c1', title: 'Add backend file', workspace_mode: 'worktree' } as Task;
const agent = { config: {} } as Agent;

// ~12 git processes per test; process creation is slow on a loaded Windows machine.
describe('WorkspaceManager.commitAll (real git)', { timeout: 90_000 }, () => {
  let repo: string;
  let manager: WorkspaceManager;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-commit-'));
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'user.email', 'test@example.invalid');
    git(repo, 'config', 'commit.gpgsign', 'false');
    await fs.writeFile(path.join(repo, 'README.md'), '# repo\n');
    // ORCH state tracked in git — must never be deleted by a worktree merge.
    await fs.mkdir(path.join(repo, '.orchestry'));
    await fs.writeFile(path.join(repo, '.orchestry', 'config.yml'), 'project: {}\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'init');
    manager = new WorkspaceManager(repo, path.join(repo, '.orchestry'), new ProcessManager());
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true, maxRetries: 5 });
  });

  it('commits uncommitted worktree changes so merging carries them to the main branch', async () => {
    const { path: ws, branch } = await manager.prepare(task, agent, DEFAULT_CONFIG);
    await fs.writeFile(path.join(ws, 'backend.txt'), 'API_VERSION=1\n');

    await expect(manager.commitAll(ws, 'orch: Add backend file (tsk_c1)')).resolves.toBe(true);

    expect(git(ws, 'status', '--porcelain', '--', '.', ':(exclude).orchestry')).toBe('');
    expect(git(ws, 'log', '-1', '--format=%s')).toBe('orch: Add backend file (tsk_c1)');
    expect(await manager.getChangedFiles(branch!)).toEqual(['backend.txt']);

    await expect(manager.mergeBack(branch!)).resolves.toEqual({ success: true });
    await manager.cleanup(task.id, branch);

    // core.autocrlf may rewrite line endings on checkout (Windows)
    const readText = async (p: string): Promise<string> => (await fs.readFile(p, 'utf-8')).replace(/\r\n/g, '\n');
    expect(await readText(path.join(repo, 'backend.txt'))).toBe('API_VERSION=1\n');
    // .orchestry (removed inside the worktree) is untouched on the main branch
    expect(await readText(path.join(repo, '.orchestry', 'config.yml'))).toBe('project: {}\n');
  });

  it('returns false and creates no commit when there is nothing to commit', async () => {
    const { path: ws } = await manager.prepare(task, agent, DEFAULT_CONFIG);
    const before = git(ws, 'rev-parse', 'HEAD');

    await expect(manager.commitAll(ws, 'noop')).resolves.toBe(false);

    expect(git(ws, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('falls back to an ORCH identity when git has no user.email', async () => {
    const { path: ws } = await manager.prepare(task, agent, DEFAULT_CONFIG);
    git(repo, 'config', '--unset', 'user.email');
    git(repo, 'config', '--unset', 'user.name');
    await fs.writeFile(path.join(ws, 'a.txt'), 'a');

    // Hide the developer's global/system git identity from the spawned git.
    const overrides = { GIT_CONFIG_GLOBAL: path.join(repo, 'no-global'), GIT_CONFIG_NOSYSTEM: '1' };
    const saved = Object.fromEntries(Object.keys(overrides).map((k) => [k, process.env[k]]));
    Object.assign(process.env, overrides);
    try {
      await expect(manager.commitAll(ws, 'with fallback identity')).resolves.toBe(true);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }

    expect(git(ws, 'log', '-1', '--format=%ae')).toBe('orch@localhost');
  });

  it('throws a WorkspaceError when a commit hook rejects the commit', async () => {
    const { path: ws } = await manager.prepare(task, agent, DEFAULT_CONFIG);
    const hooks = path.join(repo, 'hooks');
    await fs.mkdir(hooks);
    await fs.writeFile(path.join(hooks, 'pre-commit'), '#!/bin/sh\necho "lint failed" >&2\nexit 1\n', { mode: 0o755 });
    git(repo, 'config', 'core.hooksPath', hooks);
    await fs.writeFile(path.join(ws, 'a.txt'), 'a');

    const err = await manager.commitAll(ws, 'blocked').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(WorkspaceError);
    expect((err as Error).message).toContain('lint failed');
  });
});
