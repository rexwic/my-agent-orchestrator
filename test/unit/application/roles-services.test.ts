import { describe, it, expect } from 'vitest';
import { TaskService } from '../../../src/application/task-service.js';
import { AgentService } from '../../../src/application/agent-service.js';
import { EventBus } from '../../../src/application/event-bus.js';
import { Semaphore } from '../../../src/application/semaphore.js';
import { DEFAULT_CONFIG } from '../../../src/domain/config.js';
import { validateRole, type Role } from '../../../src/domain/role.js';
import type { IRoleStore } from '../../../src/infrastructure/storage/interfaces.js';
import { createMockTaskStore, createMockAgentStore, createMockStateStore, makeAgent, makeTask } from './helpers.js';

const roleStore = (roles: Role[]): IRoleStore => ({
  save: async () => {},
  get: async (name) => roles.find((r) => r.name === name) ?? null,
  load: async () => ({ roles, errors: [] }),
  list: async () => roles,
  delete: async () => {},
});

describe('TaskService — roles', () => {
  const backend = validateRole({
    name: 'backend', adapter: 'claude', replicas: 2,
    task_defaults: { review_criteria: ['test_pass'], max_attempts: 2, priority: 2 },
  });
  const service = new TaskService(createMockTaskStore(), new EventBus(), DEFAULT_CONFIG, undefined, createMockAgentStore(), roleStore([backend]));

  it('stores the role and applies its task defaults', async () => {
    const task = await service.create({ title: 'Add order API', role: 'backend' });
    expect(task).toMatchObject({ role: 'backend', review_criteria: ['test_pass'], max_attempts: 2, priority: 2 });
  });

  it('lets explicit task fields win over role defaults', async () => {
    const task = await service.create({ title: 'Hotfix', role: 'backend', review_criteria: ['typecheck'], max_attempts: 1, priority: 1 });
    expect(task).toMatchObject({ review_criteria: ['typecheck'], max_attempts: 1, priority: 1 });
  });

  it('rejects unknown roles', async () => {
    await expect(service.create({ title: 'x', role: 'frontend' })).rejects.toThrow(/Unknown role "frontend"/);
  });

  it('leaves tasks without a role unchanged', async () => {
    const task = await service.create({ title: 'plain' });
    expect(task.role).toBeUndefined();
    expect(task.review_criteria).toBeUndefined();
  });
});

describe('AgentService — role instances', () => {
  it('refuses per-instance edits: settings come from the role', async () => {
    const agentStore = createMockAgentStore([makeAgent({ id: 'agt_1', name: 'backend-1', role_id: 'backend' })]);
    const service = new AgentService(agentStore, createMockStateStore(), new EventBus(), DEFAULT_CONFIG);

    await expect(service.update('agt_1', { model: 'opus' })).rejects.toThrow(/roles\/backend\.yml/);
  });

  it('picks only instances of the task\'s role', async () => {
    const agentStore = createMockAgentStore([
      makeAgent({ id: 'agt_qa', name: 'qa-1', role_id: 'qa' }),
      makeAgent({ id: 'agt_be', name: 'backend-1', role_id: 'backend' }),
    ]);
    const service = new AgentService(agentStore, createMockStateStore(), new EventBus(), DEFAULT_CONFIG);

    await expect(service.findBestAgent(makeTask({ role: 'backend' }))).resolves.toMatchObject({ id: 'agt_be' });
    await expect(service.findBestAgent(makeTask({ role: 'frontend' }))).resolves.toBeNull();
  });
});

describe('Semaphore', () => {
  it('limits concurrency and runs queued tasks in order', async () => {
    const sem = new Semaphore(2);
    const order: string[] = [];
    let active = 0;
    let max = 0;
    const job = (name: string, ms: number) => sem.run(async () => {
      active++; max = Math.max(max, active); order.push(`start:${name}`);
      await new Promise((r) => setTimeout(r, ms));
      active--; order.push(`end:${name}`);
      return name;
    });

    const results = await Promise.all([job('a', 30), job('b', 10), job('c', 5)]);

    expect(results).toEqual(['a', 'b', 'c']);
    expect(max).toBe(2);
    expect(order.indexOf('start:c')).toBeGreaterThan(order.indexOf('end:b'));
    expect(sem.running).toBe(0);
  });

  it('releases the slot when a task throws', async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('rejects invalid limits', () => {
    expect(() => new Semaphore(0)).toThrow();
  });
});
