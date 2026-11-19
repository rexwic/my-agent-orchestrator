import { describe, it, expect, vi } from 'vitest';
import { PrdService } from '../../../src/application/prd-service.js';
import { TaskService } from '../../../src/application/task-service.js';
import { EventBus } from '../../../src/application/event-bus.js';
import { DEFAULT_CONFIG } from '../../../src/domain/config.js';
import { validateRole, type Role } from '../../../src/domain/role.js';
import { prdNameFrom } from '../../../src/domain/prd.js';
import { MemoryPrdStore } from '../../../src/infrastructure/storage/prd-store.js';
import type { IRoleStore } from '../../../src/infrastructure/storage/interfaces.js';
import { createMockTaskStore, createMockAgentStore } from './helpers.js';

function setup(roleNames: string[] = ['pm', 'planner', 'backend']) {
  const roles: Role[] = roleNames.map((name) => validateRole({ name, adapter: 'claude' }));
  const roleStore: IRoleStore = {
    save: async () => {}, delete: async () => {},
    get: async (n) => roles.find((r) => r.name === n) ?? null,
    load: async () => ({ roles, errors: [] }),
    list: async () => roles,
  };
  const taskStore = createMockTaskStore();
  const eventBus = new EventBus();
  const events: any[] = [];
  eventBus.onAny((e: any) => events.push(e));
  const taskService = new TaskService(taskStore, eventBus, DEFAULT_CONFIG, undefined, createMockAgentStore(), roleStore);
  const planService = { start: vi.fn(async () => ({ plan: { id: 'pln_x' }, task: {} })) };
  const service = new PrdService({ store: new MemoryPrdStore(), taskService, roleStore, eventBus, config: DEFAULT_CONFIG, planService: planService as any });
  return { service, taskStore, events, planService };
}

describe('PrdService versions', () => {
  it('numbers versions 1, 2, …; agent versions are unseen until a human looks', async () => {
    const { service, events } = setup();
    const v1 = await service.add({ name: 'discount', content: '# Discount\nPercent only' });
    const v2 = await service.add({ name: 'discount', content: '# Discount\nPercent, max 50%', createdBy: 'pm-1', note: 'cap for dec_1' });
    expect([v1.version, v1.seen, v2.version, v2.seen]).toEqual([1, true, 2, false]);
    expect((await service.get('discount')).version).toBe(2);
    expect((await service.get('discount', 1)).content).toBe('# Discount\nPercent only');
    expect((await service.unseen()).map((v) => v.version)).toEqual([2]);
    expect(await service.list()).toEqual([expect.objectContaining({ name: 'discount', versions: 2, unseen: 1 })]);
    await service.markSeen('discount');
    expect(await service.unseen()).toEqual([]);
    expect(events).toContainEqual({ type: 'prd:versioned', name: 'discount', version: 2, by: 'pm-1', note: 'cap for dec_1' });
  });

  it('rejects bad names, empty or unchanged content, unknown versions', async () => {
    const { service } = setup();
    await expect(service.add({ name: 'Order Discounts', content: 'x' })).rejects.toThrow(/lowercase/);
    await expect(service.add({ name: 'd', content: '  ' })).rejects.toThrow(/empty/);
    await service.add({ name: 'd', content: 'x' });
    await expect(service.add({ name: 'd', content: 'x\r\n' })).rejects.toThrow(/already has this content/);
    await expect(service.get('d', 5)).rejects.toThrow(/no version 5/);
    await expect(service.get('nope')).rejects.toThrow(/No PRD named "nope"/);
  });

  it('names from a requirement: ASCII words, else prd-<suffix>', () => {
    expect(prdNameFrom('Order discounts: percent & fixed\nmore', 'abcde')).toBe('order-discounts-percent-fixed');
    expect(prdNameFrom('訂單折扣功能', 'abcde')).toBe('prd-abcde');
  });
});

describe('PrdService drafts', () => {
  it('gives the PM a drafting task; the run is done once a version is handed in from it', async () => {
    const { service } = setup();
    const { name, task } = await service.startDraft({ requirement: '訂單折扣\n支援百分比', name: 'discount' });
    expect(task).toMatchObject({ role: 'pm', prd_draft: 'discount', labels: ['prd'], title: 'PRD: 訂單折扣', description: '訂單折扣\n支援百分比' });
    expect(await service.draftOutcome(task)).toBe('missing');
    const v = await service.add({ name, content: '# PRD', createdBy: 'pm-1', taskId: task.id });
    expect(await service.draftOutcome(task)).toBe('submitted');
    expect(v.seen).toBe(true); // reviewed with the plan, not announced as a change
  });

  it('needs a PM role', async () => {
    const { service } = setup(['planner']);
    await expect(service.startDraft({ requirement: 'x' })).rejects.toThrow(/no "pm" role/);
  });

  it('a finished draft starts a plan from the latest version (when there is a planner)', async () => {
    const { service, planService } = setup();
    const { task } = await service.startDraft({ requirement: 'Discounts', name: 'discount' });
    await service.add({ name: 'discount', content: '# PRD v1', createdBy: 'pm-1', taskId: task.id });
    expect(await service.draftFinished(task)).toBe('pln_x');
    expect(planService.start).toHaveBeenCalledWith({ requirement: '# PRD v1', title: 'Discounts', prd: { name: 'discount', version: 1 } });

    const none = setup(['pm']);
    const { task: t2 } = await none.service.startDraft({ requirement: 'X', name: 'x' });
    await none.service.add({ name: 'x', content: 'c', taskId: t2.id });
    expect(await none.service.draftFinished(t2)).toBeUndefined();
  });

  it('prompt context: the PRD a task implements, or the one being drafted', async () => {
    const { service } = setup();
    const { task: draft } = await service.startDraft({ requirement: 'Discounts', name: 'discount' });
    expect(await service.promptContext(draft)).toEqual({ name: 'discount', version: 0, drafting: { next_version: 1 } });
    await service.add({ name: 'discount', content: 'y'.repeat(40_000) });
    const ctx = await service.promptContext({ ...draft, prd_draft: undefined, prd: 'discount' });
    expect(ctx).toMatchObject({ name: 'discount', version: 1, truncated: true });
    expect(ctx!.content).toHaveLength(30_000);
  });
});

describe('PrdService changes after work was done', () => {
  it('lists done tasks built on an older version and plans only the change', async () => {
    const { service, taskStore } = setup();
    const v1 = await service.add({ name: 'discount', content: '1. percent' });
    const save = (id: string, status: 'done' | 'todo', at: string, prd = 'discount') =>
      taskStore.save({ id, title: id, description: '', status, priority: 3, labels: [], depends_on: [], created_at: at, updated_at: at, attempts: 1, max_attempts: 3, prd });
    await save('tsk_old', 'done', '2000-01-01T00:00:00.000Z');
    await save('tsk_open', 'todo', '2000-01-01T00:00:00.000Z');
    await save('tsk_other', 'done', '2000-01-01T00:00:00.000Z', 'other');
    await save('tsk_new', 'done', '2999-01-01T00:00:00.000Z');
    await service.add({ name: 'discount', content: '1. percent\n2. cap', createdBy: 'pm-1' });

    expect((await service.doneBefore('discount', 2)).map((t) => t.id)).toEqual(['tsk_old']);

    const { requirement, latest, done } = await service.changeRequirement('discount', v1.version, '+2. cap');
    expect(latest.version).toBe(2);
    expect(done.map((t) => t.id)).toEqual(['tsk_old']);
    expect(requirement).toContain('PRD discount changed since v1 (now v2). Plan only the work these changes need');
    expect(requirement).toContain('~~~~diff\n+2. cap\n~~~~');
    expect(requirement).toContain('- tsk_old tsk_old');
    expect(requirement).toMatch(/## The whole PRD \(v2\)\n1\. percent\n2\. cap$/);
    await expect(service.changeRequirement('discount', 2, '')).rejects.toThrow(/no version after v2/);
  });
});
