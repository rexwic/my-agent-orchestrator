/**
 * Review gate in the orchestrator: worktree work is committed when the agent
 * finishes, reviewed inside the worktree, and merged only once approved.
 */
import { describe, it, expect, vi } from 'vitest';
import { Orchestrator } from '../../../src/application/orchestrator.js';
import { DEFAULT_CONFIG, type OrchestratorConfig } from '../../../src/domain/config.js';
import type { ApprovalPolicy } from '../../../src/domain/agent.js';
import type { ReviewCriterion } from '../../../src/domain/task.js';
import type { IShellRunner, ShellRunResult } from '../../../src/infrastructure/process/shell-runner.js';
import {
  buildDeps,
  makeTask,
  makeAgent,
  makeRun,
  createMockTaskStore,
  createMockAgentStore,
  createMockRunStore,
  createMockStateStore,
  createMockWorkspaceManager,
} from './helpers.js';

const WORKTREE = '/tmp/project/.orchestry/workspaces/tsk_rg';
const BRANCH = 'orchestry/tsk_rg/build-api';

interface SetupOptions {
  policy?: ApprovalPolicy;
  criteria?: ReviewCriterion[];
  shellResult?: ShellRunResult;
  worktree?: boolean;
  config?: OrchestratorConfig;
}

async function setup(opts: SetupOptions = {}) {
  const taskId = 'tsk_rg';
  const agentId = 'agt_rg';
  const runId = 'run_rg';

  const task = makeTask({
    id: taskId,
    title: 'Build API',
    status: 'in_progress',
    attempts: 1,
    review_criteria: opts.criteria ?? [],
    ...(opts.worktree === false
      ? {}
      : { workspace: WORKTREE, proof: { branch: BRANCH, files_changed: [] } }),
  });
  const agent = makeAgent({
    id: agentId,
    status: 'running',
    current_task: taskId,
    config: { approval_policy: opts.policy ?? 'auto', max_turns: 50, timeout_ms: 3_600_000, stall_timeout_ms: 300_000 },
  });

  const taskStore = createMockTaskStore([task]);
  const agentStore = createMockAgentStore([agent]);
  const runStore = createMockRunStore();
  await runStore.save(makeRun({ id: runId, task_id: taskId, agent_id: agentId, status: 'streaming' }));
  const stateStore = createMockStateStore({
    running: { [taskId]: { run_id: runId, task_id: taskId, agent_id: agentId, pid: 12345, started_at: '2025-01-01T00:00:00Z' } as any },
  });

  const calls: string[] = [];
  const workspaceManager = createMockWorkspaceManager();
  vi.mocked(workspaceManager.commitAll).mockImplementation(async () => { calls.push('commit'); return true; });
  vi.mocked(workspaceManager.mergeBack).mockImplementation(async () => { calls.push('merge'); return { success: true }; });
  vi.mocked(workspaceManager.cleanup).mockImplementation(async () => { calls.push('cleanup'); });

  const shellRunner: IShellRunner = {
    run: vi.fn(async (command: string) => {
      calls.push(`review:${command}`);
      return opts.shellResult ?? { exitCode: 0, output: 'ok', timedOut: false };
    }),
  };

  const deps = buildDeps({
    taskStore, agentStore, runStore, stateStore, workspaceManager, shellRunner,
    ...(opts.config ? { config: opts.config } : {}),
  });
  const events: any[] = [];
  deps.eventBus.onAny((e: any) => events.push(e));

  const orch = new Orchestrator(deps);
  await (orch as any).loadState();
  const finish = () => (orch as any).handleRunSuccess(taskId, runId, agentId, undefined, 'summary', []);

  return { finish, taskStore, workspaceManager, shellRunner, calls, events, taskId };
}

describe('Orchestrator review gate (worktree)', () => {
  it('commits the agent\'s changes in the worktree before anything else', async () => {
    const { finish, workspaceManager, calls } = await setup({ criteria: ['test_pass'] });

    await finish();

    expect(workspaceManager.commitAll).toHaveBeenCalledWith(WORKTREE, expect.stringContaining('Build API'));
    expect(workspaceManager.commitAll).toHaveBeenCalledWith(WORKTREE, expect.stringContaining('tsk_rg'));
    expect(calls[0]).toBe('commit');
  });

  it('reviews inside the worktree, then merges and cleans up only after the criteria pass', async () => {
    const { finish, taskStore, shellRunner, calls, taskId } = await setup({ criteria: ['test_pass'] });

    await finish();

    expect(shellRunner.run).toHaveBeenCalledWith('npm test', expect.objectContaining({ cwd: WORKTREE }));
    expect(calls).toEqual(['commit', 'review:npm test', 'merge', 'cleanup']);
    const task = await taskStore.get(taskId);
    expect(task!.status).toBe('done');
    expect(task!.proof?.merged).toBe(true);
  });

  it('does not merge when criteria fail (even with auto policy): sent back to the agent with the report', async () => {
    const { finish, taskStore, workspaceManager, taskId } = await setup({
      criteria: ['test_pass'],
      shellResult: { exitCode: 1, output: 'Tests run: 3, Failures: 1', timedOut: false },
    });

    await finish();

    const task = await taskStore.get(taskId);
    expect(task!.status).toBe('todo');
    expect(task!.feedback).toContain('Failures: 1');
    expect(task!.review_results?.[0]).toMatchObject({ criterion: 'test_pass', passed: false });
    expect(task!.review_results?.[0]?.output).toContain('Failures: 1');
    expect(workspaceManager.mergeBack).not.toHaveBeenCalled();
    expect(workspaceManager.cleanup).not.toHaveBeenCalled();
  });

  it('uses review commands and timeout from config', async () => {
    const config: OrchestratorConfig = {
      ...DEFAULT_CONFIG,
      review: {
        timeout_ms: 900_000,
        commands: { test_pass: { default: './mvnw -q test', win32: 'mvnw.cmd -q test' } },
      },
    };
    const { finish, shellRunner } = await setup({ criteria: ['test_pass'], config });

    await finish();

    const expected = process.platform === 'win32' ? 'mvnw.cmd -q test' : './mvnw -q test';
    expect(shellRunner.run).toHaveBeenCalledWith(expected, { cwd: WORKTREE, timeoutMs: 900_000 });
  });

  it('auto policy without criteria: commit → merge → done', async () => {
    const { finish, taskStore, calls, taskId } = await setup({ policy: 'auto' });

    await finish();

    expect(calls).toEqual(['commit', 'merge', 'cleanup']);
    expect((await taskStore.get(taskId))!.status).toBe('done');
  });

  it('manual policy without criteria: commits but waits in review for a human, worktree kept', async () => {
    const { finish, taskStore, calls, taskId } = await setup({ policy: 'manual' });

    await finish();

    expect(calls).toEqual(['commit']);
    expect((await taskStore.get(taskId))!.status).toBe('review');
  });

  it('a failed commit sends the task to review with the reason and skips review/merge', async () => {
    const { finish, taskStore, workspaceManager, shellRunner, taskId } = await setup({ criteria: ['test_pass'] });
    vi.mocked(workspaceManager.commitAll).mockRejectedValueOnce(new Error('pre-commit hook failed'));

    await finish();

    const task = await taskStore.get(taskId);
    expect(task!.status).toBe('review');
    expect(task!.proof?.agent_summary).toMatch(/^COMMIT ERROR: pre-commit hook failed/);
    expect(shellRunner.run).not.toHaveBeenCalled();
    expect(workspaceManager.mergeBack).not.toHaveBeenCalled();
  });

  it('a merge conflict on approval keeps the task in review and the worktree in place', async () => {
    const { finish, taskStore, workspaceManager, events, taskId } = await setup({ policy: 'auto' });
    vi.mocked(workspaceManager.mergeBack).mockResolvedValueOnce({ success: false, conflictInfo: 'CONFLICT (content): Merge conflict in A.java' });

    await finish();

    const task = await taskStore.get(taskId);
    expect(task!.status).toBe('review');
    expect(task!.proof?.agent_summary).toContain('MERGE CONFLICT');
    expect(task!.proof?.merged).toBeUndefined();
    expect(workspaceManager.cleanup).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ type: 'workspace:merge_conflict', taskId }));
  });

  it('shared-mode tasks (no worktree) are not committed or merged', async () => {
    const { finish, taskStore, workspaceManager, shellRunner, taskId } = await setup({ worktree: false, criteria: ['lint'] });

    await finish();

    expect(workspaceManager.commitAll).not.toHaveBeenCalled();
    expect(workspaceManager.mergeBack).not.toHaveBeenCalled();
    expect(shellRunner.run).toHaveBeenCalledWith('npm run lint', expect.objectContaining({ cwd: '/tmp/project' }));
    expect((await taskStore.get(taskId))!.status).toBe('done');
  });
});
