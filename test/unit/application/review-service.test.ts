import { describe, it, expect } from 'vitest';
import { ReviewService } from '../../../src/application/review-service.js';
import { DecisionService } from '../../../src/application/decision-service.js';
import { TaskService } from '../../../src/application/task-service.js';
import { EventBus } from '../../../src/application/event-bus.js';
import { DEFAULT_CONFIG } from '../../../src/domain/config.js';
import { validateRole, type Role } from '../../../src/domain/role.js';
import type { Task } from '../../../src/domain/task.js';
import { MemoryDecisionStore } from '../../../src/infrastructure/storage/decision-store.js';
import type { IRoleStore } from '../../../src/infrastructure/storage/interfaces.js';
import { createMockTaskStore, createMockAgentStore, makeTask } from './helpers.js';

function setup(roleDefs: Array<Record<string, unknown>> = [
  { name: 'backend', adapter: 'claude' },
  { name: 'reviewer', adapter: 'codex', duties: ['review'], reviews: ['backend'] },
]) {
  const roles: Role[] = roleDefs.map((r) => validateRole(r));
  const roleStore: IRoleStore = {
    save: async () => {}, delete: async () => {},
    get: async (n) => roles.find((r) => r.name === n) ?? null,
    load: async () => ({ roles, errors: [] }),
    list: async () => roles,
  };
  const taskStore = createMockTaskStore([makeTask({
    id: 'tsk_be', title: 'Discount API', description: 'Implement it', status: 'review', role: 'backend', priority: 3,
    prd: 'discount', uses: ['docs/api.yaml'], proof: { branch: 'orchestry/tsk_be/api', files_changed: ['src/A.java'] },
  })]);
  const eventBus = new EventBus();
  const events: any[] = [];
  eventBus.onAny((e: any) => events.push(e));
  const taskService = new TaskService(taskStore, eventBus, DEFAULT_CONFIG, undefined, createMockAgentStore(), roleStore);
  const decisions = new DecisionService(new MemoryDecisionStore(), taskStore, taskService, eventBus);
  const service = new ReviewService({ taskStore, taskService, roleStore, decisionService: decisions, eventBus, config: DEFAULT_CONFIG });
  const get = async (id = 'tsk_be') => (await taskStore.get(id))!;
  return { service, taskStore, taskService, decisions, events, get };
}

const mustFix = { findings: [{ severity: 'must-fix', file: 'src/A.java', issue: 'NPE on empty cart' }, { severity: 'should', issue: 'extract method' }] };

describe('review gate', () => {
  it('no reviewer for the role: not required', async () => {
    const { service, get } = setup([{ name: 'backend', adapter: 'claude' }]);
    expect(await service.gate(await get())).toBe('not_required');
  });

  it('opens one review task for the reviewer role, carrying the PRD and contracts; waits while it is open', async () => {
    const { service, get, events } = setup();
    expect(await service.gate(await get())).toBe('pending');
    const task = await get();
    expect(task.review).toMatchObject({ round: 1, status: 'pending' });
    const reviewTask = await get(task.review!.review_task_id!);
    expect(reviewTask).toMatchObject({ role: 'reviewer', review_of: 'tsk_be', labels: ['review'], prd: 'discount', uses: ['docs/api.yaml'], priority: 2 });
    expect(await service.gate(task)).toBe('pending');
    expect(events.filter((e) => e.type === 'review:requested')).toHaveLength(1);
    expect(await service.promptContext(reviewTask)).toMatchObject({ task_id: 'tsk_be', round: 1, max_rounds: 2, branch: 'orchestry/tsk_be/api', files_changed: ['src/A.java'], to_verify: [] });
    expect(await service.outcome(reviewTask)).toBe('missing');
  });
});

describe('review rounds', () => {
  async function opened() {
    const s = setup();
    await s.service.gate(await s.get());
    const reviewTaskId = (await s.get()).review!.review_task_id!;
    return { ...s, reviewTaskId };
  }

  it('passing approves the work (it merges on the next tick)', async () => {
    const { service, get, reviewTaskId } = await opened();
    const r = await service.submit({ reviewTaskId, raw: { summary: 'LGTM', findings: [{ severity: 'nit', issue: 'typo' }] }, by: 'reviewer-1' });
    expect(r.verdict).toBe('passed');
    const task = await get();
    expect(task).toMatchObject({ status: 'review', approved: true });
    expect(task.review).toMatchObject({ status: 'passed', reviewer: 'reviewer-1', summary: 'LGTM' });
    expect(task.feedback).toMatch(/Optional suggestions[\s\S]*typo/);
    expect(await service.outcome(await get(reviewTaskId))).toBe('submitted');
  });

  it('must-fix in round 1 sends the work back with the findings; round 2 only verifies them', async () => {
    const { service, get, reviewTaskId, taskStore } = await opened();
    await service.submit({ reviewTaskId, raw: mustFix, by: 'reviewer-1' });
    let task = await get();
    expect(task.status).toBe('todo');
    expect(task.approved).toBeUndefined();
    expect(task.feedback).toMatch(/round 1 of 2[\s\S]*F1 \[must-fix\] src\/A\.java — NPE on empty cart[\s\S]*Optional[\s\S]*F2 \[should\]/);

    // The author fixed it and finished again.
    await taskStore.save({ ...task, status: 'review' });
    expect(await service.gate(await get())).toBe('pending');
    task = await get();
    expect(task.review).toMatchObject({ round: 2, status: 'pending' });
    const ctx = await service.promptContext(await get(task.review!.review_task_id!));
    expect(ctx!.to_verify).toEqual(['F1 [must-fix] src/A.java — NPE on empty cart']);
    await expect(service.submit({ reviewTaskId: task.review!.review_task_id!, raw: { findings: [] } })).rejects.toThrow(/missing: F1/);
  });

  it('still open after round 2: a human decides', async () => {
    const { service, get, reviewTaskId, taskStore, decisions } = await opened();
    await service.submit({ reviewTaskId, raw: mustFix });
    await taskStore.save({ ...(await get()), status: 'review' });
    await service.gate(await get());
    const second = (await get()).review!.review_task_id!;
    const r = await service.submit({ reviewTaskId: second, raw: { checks: [{ id: 'F1', fixed: false, note: 'still NPE' }] }, by: 'reviewer-1' });
    expect(r.escalated).toBe(true);
    const task = await get();
    expect(task.status).toBe('waiting_decision');
    expect(task.review!.status).toBe('escalated');
    const [d] = await decisions.pendingFor('tsk_be');
    expect(d).toMatchObject({ source: 'review' });
    expect(d!.context).toMatch(/F1 \[must-fix\][\s\S]*reviewer: still NPE/);
    // After a human decides, the work is not reviewed again.
    expect(await service.gate(task)).toBe('passed');
  });

  it('a submission for a replaced or finished review is refused', async () => {
    const { service, reviewTaskId } = await opened();
    await service.submit({ reviewTaskId, raw: {} });
    await expect(service.submit({ reviewTaskId, raw: {} })).rejects.toThrow(/not waiting for this review/);
  });

  it('a review task that fails for good leaves the decision to a human', async () => {
    const { get, reviewTaskId, taskStore, taskService, decisions } = await opened();
    await taskStore.save({ ...(await get(reviewTaskId)), status: 'in_progress' } as Task);
    await taskService.updateStatus(reviewTaskId, 'failed');
    await new Promise((r) => setTimeout(r, 20));
    expect((await get()).review!.status).toBe('escalated');
    expect((await decisions.pendingFor('tsk_be'))[0]!.question).toMatch(/could not be done/);
  });
});
