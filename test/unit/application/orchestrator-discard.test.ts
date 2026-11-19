/**
 * Tasks a human cancels lose their worktree and branch; tasks ORCH cancelled
 * itself (after a restart) and failed tasks keep theirs.
 */
import { describe, it, expect, vi } from 'vitest';
import { Orchestrator } from '../../../src/application/orchestrator.js';
import { DecisionService } from '../../../src/application/decision-service.js';
import { MemoryDecisionStore } from '../../../src/infrastructure/storage/decision-store.js';
import { buildDeps, makeTask, createMockTaskStore, createMockStateStore, createMockWorkspaceManager } from './helpers.js';

vi.mock('../../../src/infrastructure/storage/lock.js', () => ({
  acquireLock: vi.fn(async () => ({ acquired: true, pid: process.pid })),
  releaseLock: vi.fn(async () => {}),
  touchLock: vi.fn(async () => {}),
}));

const ws = (id: string) => ({ workspace: `/p/.orchestry/workspaces/${id}`, proof: { branch: `orchestry/${id}/x`, files_changed: [] } });

async function setup(running: string[] = []) {
  const taskStore = createMockTaskStore([
    makeTask({ id: 'tsk_h', status: 'cancelled', discard_work: true, ...ws('tsk_h') }),
    makeTask({ id: 'tsk_restart', status: 'cancelled', ...ws('tsk_restart') }),
    makeTask({ id: 'tsk_failed', status: 'failed', discard_work: true, ...ws('tsk_failed') }),
    makeTask({ id: 'tsk_review', status: 'review', ...ws('tsk_review') }),
    makeTask({ id: 'tsk_run', status: 'cancelled', discard_work: true, ...ws('tsk_run') }),
  ]);
  const wm = createMockWorkspaceManager();
  const runningState = Object.fromEntries(running.map((id) => [id, { run_id: 'r', task_id: id, agent_id: 'a', pid: 1, started_at: '' }]));
  const deps = buildDeps({ taskStore, workspaceManager: wm, stateStore: createMockStateStore({ running: runningState as any }) });
  const orch = new Orchestrator(deps);
  await (orch as any).loadState();
  return { orch, wm, taskStore, deps };
}

describe('discarding the work of cancelled tasks', () => {
  it('removes worktree + branch only of tasks a human cancelled, once', async () => {
    const { orch, wm, taskStore } = await setup(['tsk_run']);
    await orch.discardCancelledWork();

    expect(vi.mocked(wm.cleanup).mock.calls).toEqual([['tsk_h', 'orchestry/tsk_h/x']]);
    expect((await taskStore.get('tsk_h'))!.workspace).toBeUndefined();
    expect((await taskStore.get('tsk_restart'))!.workspace).toBeDefined();

    (orch as any).cachedTaskStore.invalidate();
    await orch.discardCancelledWork();
    expect(wm.cleanup).toHaveBeenCalledTimes(1);
  });

  it('a task whose agent still runs is left for a later pass', async () => {
    const { orch, wm } = await setup(['tsk_run']);
    await orch.discardCancelledWork('tsk_run');
    expect(wm.cleanup).not.toHaveBeenCalled();
  });

  it('a failed cleanup keeps the task marked so it is tried again', async () => {
    const { orch, wm, taskStore } = await setup();
    vi.mocked(wm.cleanup).mockRejectedValueOnce(new Error('locked'));
    await orch.discardCancelledWork('tsk_h');
    expect((await taskStore.get('tsk_h'))!.workspace).toBeDefined();
    await orch.discardCancelledWork('tsk_h');
    expect((await taskStore.get('tsk_h'))!.workspace).toBeUndefined();
  });

  it('cancelling through the task service or a decision marks the work to discard', async () => {
    const { deps, taskStore } = await setup();
    await taskStore.save(makeTask({ id: 'tsk_c', status: 'review' }));
    await deps.taskService.cancel('tsk_c');
    expect(await taskStore.get('tsk_c')).toMatchObject({ status: 'cancelled', discard_work: true });

    await taskStore.save(makeTask({ id: 'tsk_d', status: 'in_progress' }));
    const decisions = new DecisionService(new MemoryDecisionStore(), taskStore, deps.taskService, deps.eventBus);
    const d = await decisions.request({ task_id: 'tsk_d', source: 'delivery', question: 'Blocked. Go on?' });
    await taskStore.save({ ...(await taskStore.get('tsk_d'))!, status: 'waiting_decision' });
    await decisions.answer(d.id, { action: 'cancel' });
    expect(await taskStore.get('tsk_d')).toMatchObject({ status: 'cancelled', discard_work: true });
  });
});
