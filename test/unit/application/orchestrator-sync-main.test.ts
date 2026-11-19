/**
 * Worktree tasks are synced with main before review, sent back to their agent
 * on conflicts / failed review, and merged through a queue that re-verifies when
 * main moved. Approval is a flag the orchestrator acts on.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Orchestrator } from '../../../src/application/orchestrator.js';
import { DEFAULT_CONFIG } from '../../../src/domain/config.js';
import type { ApprovalPolicy } from '../../../src/domain/agent.js';
import type { ReviewCriterion, Task } from '../../../src/domain/task.js';
import type { IShellRunner, ShellRunResult } from '../../../src/infrastructure/process/shell-runner.js';
import type { SyncResult } from '../../../src/infrastructure/workspace/interface.js';
import { acquireLock } from '../../../src/infrastructure/storage/lock.js';
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

vi.mock('../../../src/infrastructure/storage/lock.js', () => ({
  acquireLock: vi.fn(async () => ({ acquired: true, pid: process.pid })),
  releaseLock: vi.fn(async () => {}),
  touchLock: vi.fn(async () => {}),
}));

const WORKTREE = '/tmp/project/.orchestry/workspaces/tsk_s';
const BRANCH = 'orchestry/tsk_s/order-api';

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

interface SetupOptions {
  policy?: ApprovalPolicy;
  criteria?: ReviewCriterion[];
  /** Successive review results (the last one repeats). */
  reviews?: ShellRunResult[];
  /** Successive main heads returned by targetHead (the last one repeats). */
  heads?: string[];
  sync?: SyncResult;
  task?: Partial<Task>;
  /** A reviewer role reviews it: what the review gate answers. */
  reviewGate?: 'not_required' | 'passed' | 'pending';
}

const orchestrators: Orchestrator[] = [];
afterEach(() => {
  for (const o of orchestrators.splice(0)) {
    (o as any).shuttingDown = true;
    if ((o as any).intervalId) clearInterval((o as any).intervalId);
    if ((o as any).immediateDispatchTimer) clearTimeout((o as any).immediateDispatchTimer);
  }
  vi.mocked(acquireLock).mockClear();
});

async function setup(opts: SetupOptions = {}) {
  const taskId = 'tsk_s';
  const task = makeTask({
    id: taskId,
    title: 'Order API',
    status: 'in_progress',
    attempts: 1,
    review_criteria: opts.criteria ?? [],
    workspace: WORKTREE,
    proof: { branch: BRANCH, files_changed: [] },
    ...opts.task,
  });
  const agent = makeAgent({
    id: 'agt_s',
    status: 'running',
    current_task: taskId,
    config: { approval_policy: opts.policy ?? 'auto', max_turns: 50, timeout_ms: 3_600_000, stall_timeout_ms: 300_000 },
  });
  const taskStore = createMockTaskStore([task]);
  const runStore = createMockRunStore();
  await runStore.save(makeRun({ id: 'run_s', task_id: taskId, agent_id: 'agt_s', status: 'streaming' }));
  const stateStore = createMockStateStore({
    running: task.status === 'in_progress'
      ? { [taskId]: { run_id: 'run_s', task_id: taskId, agent_id: 'agt_s', pid: 1, started_at: new Date().toISOString() } as any }
      : {},
  });

  const calls: string[] = [];
  const heads = [...(opts.heads ?? ['main1'])];
  const wm = createMockWorkspaceManager();
  vi.mocked(wm.commitAll).mockImplementation(async () => { calls.push('commit'); return true; });
  vi.mocked(wm.targetHead).mockImplementation(async () => ({ sha: heads.length > 1 ? heads.shift()! : heads[0]!, name: 'main' }));
  vi.mocked(wm.syncWorktree).mockImplementation(async (_ws, sha) => { calls.push(`sync:${sha}`); return opts.sync ?? { status: 'merged' }; });
  vi.mocked(wm.mergeBack).mockImplementation(async () => { calls.push('merge'); return { success: true }; });
  vi.mocked(wm.cleanup).mockImplementation(async () => { calls.push('cleanup'); });

  const reviews = [...(opts.reviews ?? [{ exitCode: 0, output: 'BUILD SUCCESS', timedOut: false }])];
  const shellRunner: IShellRunner = {
    run: vi.fn(async (command: string) => {
      calls.push(`review:${command}`);
      return reviews.length > 1 ? reviews.shift()! : reviews[0]!;
    }),
  };

  const deps = buildDeps({ taskStore, agentStore: createMockAgentStore([agent]), runStore, stateStore, workspaceManager: wm, shellRunner, config: DEFAULT_CONFIG });
  const gate = vi.fn(async () => opts.reviewGate ?? 'not_required');
  if (opts.reviewGate) deps.reviewService = { gate } as any;
  const events: any[] = [];
  deps.eventBus.onAny((e: any) => events.push(e));
  const orch = new Orchestrator(deps);
  orchestrators.push(orch);
  await (orch as any).loadState();
  const finish = () => (orch as any).handleRunSuccess(taskId, 'run_s', 'agt_s', undefined, 'implemented', []);
  const get = async () => (await taskStore.get(taskId))!;
  return { orch, finish, get, taskStore, wm, shellRunner, calls, events, taskId, gate };
}

const FAIL: ShellRunResult = { exitCode: 1, output: 'OrderServiceTest.total expected 10 but was 0', timedOut: false };

describe('sync main before review', () => {
  it('commits, merges main into the branch, reviews the merged result, then merges back', async () => {
    const { finish, get, calls, events } = await setup({ criteria: ['test_pass'] });

    await finish();

    expect(calls).toEqual(['commit', 'sync:main1', 'review:npm test', 'merge', 'cleanup']);
    const task = await get();
    expect(task.status).toBe('done');
    expect(task.proof?.synced_main).toBe('main1');
    expect(events).toContainEqual(expect.objectContaining({ type: 'task:synced', sha: 'main1', target: 'main', merged: true }));
  });

  it('fills files_changed from the committed branch when the adapter reported none', async () => {
    const { finish, get, wm } = await setup({ policy: 'manual' });
    vi.mocked(wm.getChangedFiles).mockResolvedValue(['src/main/java/OrderApi.java']);

    await finish();

    expect((await get()).proof?.files_changed).toEqual(['src/main/java/OrderApi.java']);
  });

  it('manual policy without criteria: synced, then waits for a human (not approved, not merged)', async () => {
    const { finish, get, calls } = await setup({ policy: 'manual' });

    await finish();

    expect(calls).toEqual(['commit', 'sync:main1']);
    const task = await get();
    expect(task.status).toBe('review');
    expect(task.approved).toBeUndefined();
  });
});

describe('send back to the agent', () => {
  it('a conflict merging main sends the task back with the files and instructions; no review, no merge', async () => {
    const { finish, get, calls, events } = await setup({
      criteria: ['test_pass'],
      sync: { status: 'conflict', files: ['src/main/java/Order.java'], output: 'CONFLICT (content)' },
    });

    await finish();

    expect(calls).toEqual(['commit', 'sync:main1']);
    const task = await get();
    expect(task).toMatchObject({ status: 'todo', send_backs: 1, attempts: 0 });
    expect(task.proof?.conflict_files).toEqual(['src/main/java/Order.java']);
    expect(task.feedback).toContain('src/main/java/Order.java');
    expect(task.feedback).toContain('`main`');
    expect(task.feedback).toMatch(/merge is still in progress/);
    expect(task.workspace).toBe(WORKTREE); // worktree kept for the agent
    expect(events).toContainEqual(expect.objectContaining({ type: 'task:sent_back', reason: 'conflict', count: 1, max: 3 }));
  });

  it('review failing on the merged result sends the task back with the report', async () => {
    const { finish, get, wm } = await setup({ criteria: ['test_pass'], reviews: [FAIL] });

    await finish();

    const task = await get();
    expect(task).toMatchObject({ status: 'todo', send_backs: 1 });
    expect(task.feedback).toContain('expected 10 but was 0');
    expect(task.review_results?.[0]).toMatchObject({ passed: false });
    expect(wm.mergeBack).not.toHaveBeenCalled();
    expect(wm.cleanup).not.toHaveBeenCalled();
  });

  it('changing a contract the task uses sends it back with how to restore it; no sync, no merge', async () => {
    const { finish, get, wm, calls, events } = await setup({ task: { uses: ['docs/api/order.yaml'] } });
    vi.mocked(wm.getChangedFiles).mockResolvedValue(['src/Order.java', 'docs\\api\\order.yaml']);

    await finish();

    expect(calls).toEqual(['commit']);
    const task = await get();
    expect(task).toMatchObject({ status: 'todo', send_backs: 1 });
    expect(task.feedback).toContain('- docs/api/order.yaml');
    expect(task.feedback).toContain('git checkout main -- docs/api/order.yaml');
    expect(task.feedback).toContain('orch decision request');
    expect(events).toContainEqual(expect.objectContaining({ type: 'task:sent_back', reason: 'contract', files: ['docs/api/order.yaml'] }));
  });

  it('leaving a used contract alone integrates as usual', async () => {
    const { finish, get, wm } = await setup({ task: { uses: ['docs/api/order.yaml'] } });
    vi.mocked(wm.getChangedFiles).mockResolvedValue(['src/Order.java']);
    await finish();
    expect((await get()).status).toBe('done');
  });

  it('a contract change past max_send_backs waits in review for a human', async () => {
    const { finish, get, wm } = await setup({ task: { uses: ['docs/api/order.yaml'], send_backs: 3 } });
    vi.mocked(wm.getChangedFiles).mockResolvedValue(['docs/api/order.yaml']);
    await finish();
    const task = await get();
    expect(task.status).toBe('review');
    expect(task.proof?.agent_summary).toMatch(/^CONTRACT CHANGED: .*docs\/api\/order\.yaml/);
  });

  it('after max_send_backs it stops sending back and waits in review for a human', async () => {
    const { finish, get, events } = await setup({
      criteria: ['test_pass'],
      task: { send_backs: 3 },
      sync: { status: 'conflict', files: ['Order.java'], output: 'CONFLICT' },
    });

    await finish();

    const task = await get();
    expect(task.status).toBe('review');
    expect(task.send_backs).toBe(3);
    expect(task.proof?.agent_summary).toMatch(/^SYNC CONFLICT: .*Order\.java/);
    expect(task.proof?.conflict_files).toEqual(['Order.java']);
    expect(events).toContainEqual(expect.objectContaining({ type: 'workspace:merge_conflict' }));
    expect(events.some((e) => e.type === 'task:sent_back')).toBe(false);
  });

  it('a rework that still has conflict markers is sent back again without committing them', async () => {
    const { finish, get, wm } = await setup({ criteria: ['test_pass'], task: { send_backs: 1, proof: { branch: BRANCH, files_changed: [], conflict_files: ['Order.java'] } } });
    vi.mocked(wm.unresolvedConflicts).mockResolvedValue(['Order.java']);

    await finish();

    expect(wm.unresolvedConflicts).toHaveBeenCalledWith(WORKTREE, ['Order.java']);
    expect(wm.commitAll).not.toHaveBeenCalled();
    const task = await get();
    expect(task).toMatchObject({ status: 'todo', send_backs: 2 });
    expect(task.feedback).toContain('Order.java');
  });

  it('clears conflict_files once the rework is committed', async () => {
    const { finish, get } = await setup({ criteria: ['test_pass'], task: { send_backs: 1, proof: { branch: BRANCH, files_changed: [], conflict_files: ['Order.java'] } } });

    await finish();

    const task = await get();
    expect(task.status).toBe('done');
    expect(task.proof?.conflict_files).toBeUndefined();
  });
});

describe('merge queue', () => {
  it('re-syncs and re-reviews when main moved after review, then merges', async () => {
    // round 0 target, merge check (moved!), round 1 target, merge check
    const { finish, get, calls } = await setup({ criteria: ['test_pass'], heads: ['main1', 'main2', 'main2', 'main2'] });

    await finish();

    expect(calls).toEqual(['commit', 'sync:main1', 'review:npm test', 'sync:main2', 'review:npm test', 'merge', 'cleanup']);
    const task = await get();
    expect(task.status).toBe('done');
    expect(task.proof?.synced_main).toBe('main2');
  });

  it('merges one task at a time', async () => {
    const { orch, taskStore, wm } = await setup({ policy: 'manual' });
    for (const id of ['tsk_q1', 'tsk_q2']) {
      await taskStore.save(makeTask({ id, status: 'review', approved: true, workspace: `/ws/${id}`, proof: { branch: `b/${id}`, files_changed: [], synced_main: 'main1' } }));
    }
    let active = 0;
    let maxActive = 0;
    vi.mocked(wm.mergeBack).mockImplementation(async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      return { success: true };
    });
    const integration = (orch as any).integration;

    await Promise.all([
      integration.process('tsk_q1', { trigger: 'approved' }),
      integration.process('tsk_q2', { trigger: 'approved' }),
    ]);

    expect(maxActive).toBe(1);
    expect((await taskStore.get('tsk_q1'))!.status).toBe('done');
    expect((await taskStore.get('tsk_q2'))!.status).toBe('done');
  });

  it('while shutting down, an approved task is left approved (merged on the next start) instead of merged', async () => {
    const { orch, finish, get, wm } = await setup({ policy: 'auto' });
    (orch as any).shuttingDown = true;

    await finish();

    expect(await get()).toMatchObject({ status: 'review', approved: true });
    expect(wm.mergeBack).not.toHaveBeenCalled();
  });

  it('a failed merge into main keeps the task in review and drops the approval (no retry loop)', async () => {
    const { finish, get, wm } = await setup({ policy: 'auto' });
    vi.mocked(wm.mergeBack).mockResolvedValueOnce({ success: false, conflictInfo: 'error: Your local changes would be overwritten' });

    await finish();

    const task = await get();
    expect(task.status).toBe('review');
    expect(task.approved).toBeUndefined();
    expect(task.proof?.agent_summary).toMatch(/^MERGE CONFLICT: /);
  });
});

describe('approval', () => {
  it('approveTask without a running orchestrator integrates inline: re-syncs if main moved, then merges', async () => {
    const { orch, get, calls, events } = await setup({ policy: 'manual', heads: ['main1', 'main2'] });
    await (orch as any).handleRunSuccess('tsk_s', 'run_s', 'agt_s', undefined, 'implemented', []);
    calls.length = 0;

    const outcome = await orch.approveTask('tsk_s');

    expect(outcome).toEqual({ status: 'done' });
    expect(acquireLock).toHaveBeenCalled();
    expect(calls).toEqual(['commit', 'sync:main2', 'merge', 'cleanup']);
    expect((await get()).status).toBe('done');
    expect(events).toContainEqual({ type: 'task:approved', taskId: 'tsk_s' });
  });

  it('approveTask merges without re-reviewing when main has not moved (human decision stands)', async () => {
    const { orch, get, calls } = await setup({ criteria: ['test_pass'], policy: 'manual', task: { status: 'review', proof: { branch: BRANCH, files_changed: [], synced_main: 'main1' } } });

    await orch.approveTask('tsk_s');

    expect(calls).toEqual(['commit', 'merge', 'cleanup']);
    expect((await get()).status).toBe('done');
  });

  it('approveTask while another process runs the orchestrator only marks the task approved', async () => {
    const { orch, get, wm } = await setup({ policy: 'manual', task: { status: 'review', proof: { branch: BRANCH, files_changed: [], synced_main: 'main1' } } });
    vi.mocked(acquireLock).mockResolvedValueOnce({ acquired: false, pid: 4242 });

    await expect(orch.approveTask('tsk_s')).resolves.toEqual({ status: 'queued' });

    const task = await get();
    expect(task).toMatchObject({ status: 'review', approved: true });
    expect(wm.mergeBack).not.toHaveBeenCalled();
  });

  it('the running orchestrator integrates approved tasks on its tick', async () => {
    const { orch, get } = await setup({ policy: 'manual', task: { status: 'review', approved: true, proof: { branch: BRANCH, files_changed: [], synced_main: 'main0' } } });
    (orch as any).lockAcquired = true;

    await (orch as any).tick();
    await waitFor(async () => (await get()).status === 'done');

    expect((await get()).proof?.synced_main).toBe('main1');
  });

  it('approveTask inside the running orchestrator queues the integration in the background', async () => {
    const { orch, get } = await setup({ policy: 'manual', task: { status: 'review', proof: { branch: BRANCH, files_changed: [], synced_main: 'main1' } } });
    (orch as any).lockAcquired = true;

    await expect(orch.approveTask('tsk_s')).resolves.toEqual({ status: 'queued' });
    await waitFor(async () => (await get()).status === 'done');
    expect(acquireLock).not.toHaveBeenCalled();
  });

  it('approving with conflict markers still in the worktree keeps the task in review', async () => {
    const { orch, get, wm } = await setup({ policy: 'manual', task: { status: 'review', proof: { branch: BRANCH, files_changed: [], conflict_files: ['Order.java'] } } });
    vi.mocked(wm.unresolvedConflicts).mockResolvedValue(['Order.java']);

    const outcome = await orch.approveTask('tsk_s');

    expect(outcome).toMatchObject({ status: 'review' });
    const task = await get();
    expect(task.status).toBe('review');
    expect(task.approved).toBeUndefined();
    expect(task.proof?.agent_summary).toMatch(/^UNRESOLVED CONFLICT: Order\.java/);
    expect(wm.mergeBack).not.toHaveBeenCalled();
  });

  it('a task without a worktree is approved directly', async () => {
    const { orch, get, wm } = await setup({ task: { status: 'review', workspace: undefined, proof: { files_changed: [] } } });

    await expect(orch.approveTask('tsk_s')).resolves.toEqual({ status: 'done' });

    expect((await get()).status).toBe('done');
    expect(wm.syncWorktree).not.toHaveBeenCalled();
  });

  it('refuses tasks that are not in review', async () => {
    const { orch } = await setup({ task: { status: 'todo' } });
    await expect(orch.approveTask('tsk_s')).rejects.toThrow(/todo/);
  });
});

describe('review by a reviewer role', () => {
  it('passing checks wait for the reviewer: stays in review, not approved, not merged', async () => {
    const { finish, get, calls, gate } = await setup({ criteria: ['test_pass'], reviewGate: 'pending' });
    await finish();
    expect(calls).toEqual(['commit', 'sync:main1', 'review:npm test']);
    const task = await get();
    expect(task.status).toBe('review');
    expect(task.approved).toBeUndefined();
    expect(gate).toHaveBeenCalledTimes(1);
  });

  it('a failing check sends the work back before any review', async () => {
    const { finish, get, gate } = await setup({ criteria: ['test_pass'], reviews: [FAIL], reviewGate: 'pending' });
    await finish();
    expect((await get()).status).toBe('todo');
    expect(gate).not.toHaveBeenCalled();
  });

  it('work reviewed before (e.g. back after a conflict) follows the usual approval rules', async () => {
    const auto = await setup({ reviewGate: 'passed' });
    await auto.finish();
    expect((await auto.get()).status).toBe('done');
    const manual = await setup({ policy: 'manual', reviewGate: 'passed' });
    await manual.finish();
    expect((await manual.get()).status).toBe('review');
  });
});
