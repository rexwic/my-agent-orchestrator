import { describe, it, expect, vi } from 'vitest';
import { ReviewGate } from '../../../src/application/review-gate.js';
import { TaskService } from '../../../src/application/task-service.js';
import { EventBus } from '../../../src/application/event-bus.js';
import { DEFAULT_CONFIG } from '../../../src/domain/config.js';
import { InvalidTransitionError } from '../../../src/domain/errors.js';
import type { Task } from '../../../src/domain/task.js';
import { makeTask, createMockTaskStore, createMockWorkspaceManager } from './helpers.js';

function setup(task: Task) {
  const taskStore = createMockTaskStore([task]);
  const eventBus = new EventBus();
  const taskService = new TaskService(taskStore, eventBus, DEFAULT_CONFIG);
  const workspaceManager = createMockWorkspaceManager();
  const events: any[] = [];
  eventBus.onAny((e: any) => events.push(e));
  const gate = new ReviewGate({ taskStore, taskService, workspaceManager, eventBus });
  return { gate, taskStore, workspaceManager, events };
}

const worktreeTask = (overrides: Partial<Task> = {}) =>
  makeTask({
    id: 'tsk_g',
    status: 'review',
    proof: { branch: 'orchestry/tsk_g/x', files_changed: ['A.java'], agent_summary: 'did it' },
    ...overrides,
  });

describe('ReviewGate.approve', () => {
  it('marks a task without a worktree branch done without touching git', async () => {
    const { gate, taskStore, workspaceManager } = setup(makeTask({ id: 'tsk_g', status: 'review' }));

    await expect(gate.approve('tsk_g')).resolves.toEqual({ ok: true, merged: false });

    expect((await taskStore.get('tsk_g'))!.status).toBe('done');
    expect(workspaceManager.mergeBack).not.toHaveBeenCalled();
  });

  it('merges the branch, records it, cleans up the worktree, then marks done', async () => {
    const { gate, taskStore, workspaceManager, events } = setup(worktreeTask());

    await expect(gate.approve('tsk_g')).resolves.toEqual({ ok: true, merged: true });

    expect(workspaceManager.mergeBack).toHaveBeenCalledWith('orchestry/tsk_g/x');
    expect(workspaceManager.cleanup).toHaveBeenCalledWith('tsk_g', 'orchestry/tsk_g/x');
    const task = await taskStore.get('tsk_g');
    expect(task!.status).toBe('done');
    expect(task!.proof?.merged).toBe(true);
    expect(events.map((e) => e.type)).toEqual(['workspace:merge_succeeded', 'task:status_changed']);
  });

  it('keeps the task in review with the conflict in its summary when the merge conflicts', async () => {
    const { gate, taskStore, workspaceManager, events } = setup(worktreeTask());
    vi.mocked(workspaceManager.mergeBack).mockResolvedValue({ success: false, conflictInfo: 'CONFLICT in A.java' });

    const result = await gate.approve('tsk_g');

    expect(result).toEqual({ ok: false, detail: 'MERGE CONFLICT: CONFLICT in A.java' });
    const task = await taskStore.get('tsk_g');
    expect(task!.status).toBe('review');
    expect(task!.proof?.agent_summary).toBe('MERGE CONFLICT: CONFLICT in A.java\n\ndid it');
    expect(workspaceManager.cleanup).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ type: 'workspace:merge_conflict', taskId: 'tsk_g' }));
  });

  it('does not stack merge-failure prefixes on repeated attempts', async () => {
    const { gate, taskStore, workspaceManager } = setup(worktreeTask());
    vi.mocked(workspaceManager.mergeBack).mockResolvedValue({ success: false, conflictInfo: 'first' });
    await gate.approve('tsk_g');
    vi.mocked(workspaceManager.mergeBack).mockRejectedValue(new Error('index.lock exists'));

    await gate.approve('tsk_g');

    expect((await taskStore.get('tsk_g'))!.proof?.agent_summary).toBe('MERGE ERROR: index.lock exists\n\ndid it');
  });

  it('does not merge again when the branch was already merged', async () => {
    const { gate, taskStore, workspaceManager } = setup(
      worktreeTask({ proof: { branch: 'orchestry/tsk_g/x', files_changed: [], merged: true } }),
    );

    await expect(gate.approve('tsk_g')).resolves.toEqual({ ok: true, merged: false });

    expect(workspaceManager.mergeBack).not.toHaveBeenCalled();
    expect((await taskStore.get('tsk_g'))!.status).toBe('done');
  });

  it('still marks done when cleanup fails after a successful merge', async () => {
    const { gate, taskStore, workspaceManager, events } = setup(worktreeTask());
    vi.mocked(workspaceManager.cleanup).mockRejectedValue(new Error('EBUSY'));

    await expect(gate.approve('tsk_g')).resolves.toMatchObject({ ok: true });

    expect((await taskStore.get('tsk_g'))!.status).toBe('done');
    expect(events).toContainEqual(expect.objectContaining({ type: 'orchestrator:error', error: 'EBUSY' }));
  });

  it('rejects tasks that are not in review', async () => {
    const { gate } = setup(worktreeTask({ status: 'in_progress' }));

    await expect(gate.approve('tsk_g')).rejects.toBeInstanceOf(InvalidTransitionError);
  });
});
