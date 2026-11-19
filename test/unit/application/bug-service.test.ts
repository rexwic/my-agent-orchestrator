import { describe, it, expect } from 'vitest';
import { BugService } from '../../../src/application/bug-service.js';
import { DecisionService } from '../../../src/application/decision-service.js';
import { TaskService } from '../../../src/application/task-service.js';
import { EventBus } from '../../../src/application/event-bus.js';
import { DEFAULT_CONFIG } from '../../../src/domain/config.js';
import { validateRole } from '../../../src/domain/role.js';
import { MemoryDecisionStore } from '../../../src/infrastructure/storage/decision-store.js';
import type { IRoleStore } from '../../../src/infrastructure/storage/interfaces.js';
import { createMockTaskStore, createMockAgentStore, makeTask } from './helpers.js';

function setup() {
  const roles = [
    validateRole({ name: 'backend', adapter: 'claude' }),
    validateRole({ name: 'frontend', adapter: 'claude' }),
    validateRole({ name: 'qa', adapter: 'claude', duties: ['verify'], bug_owners: ['backend', 'frontend'] }),
  ];
  const roleStore: IRoleStore = {
    save: async () => {}, delete: async () => {},
    get: async (n) => roles.find((r) => r.name === n) ?? null,
    load: async () => ({ roles, errors: [] }), list: async () => roles,
  };
  const taskStore = createMockTaskStore([
    makeTask({ id: 'tsk_qa', title: 'E2E', status: 'in_progress', role: 'qa', goalId: 'goal_1' }),
    makeTask({ id: 'tsk_be', status: 'in_progress', role: 'backend' }),
  ]);
  const eventBus = new EventBus();
  const taskService = new TaskService(taskStore, eventBus, DEFAULT_CONFIG, undefined, createMockAgentStore(), roleStore);
  const decisions = new DecisionService(new MemoryDecisionStore(), taskStore, taskService, eventBus);
  const bugs = new BugService({ taskStore, taskService, roleStore, decisionService: decisions, eventBus, config: DEFAULT_CONFIG });
  const file = (owner = 'backend') => bugs.add({ title: 'Total wrong', owner, repro: 'add item', expected: '90', actual: '100', contract: 'docs/api.yaml' }, { taskId: 'tsk_qa', by: 'qa-1' });
  return { bugs, decisions, taskStore, taskService, file, get: async (id: string) => (await taskStore.get(id))! };
}

describe('BugService', () => {
  it('a verifier files a bug for exactly one allowed owner; the owner gets the contract', async () => {
    const { file, bugs } = setup();
    const t = await file();
    expect(t).toMatchObject({ role: 'backend', labels: ['bug'], uses: ['docs/api.yaml'], goalId: 'goal_1', bug: { found_by: 'tsk_qa', round: 1 } });
    await expect(file('qa')).rejects.toThrow(/cannot own a bug/);
    await expect(bugs.add({ title: 'x', owner: 'backend', repro: 'r', expected: 'e', actual: 'a' }, { taskId: 'tsk_be', by: 'backend-1' })).rejects.toThrow(/Only a verifying role files bugs/);
  });

  it('one hand-off (after the run when running); a second one asks a human, whose choice sets the owner', async () => {
    const { file, bugs, decisions, taskStore, get } = setup();
    const t = await file();
    await taskStore.save({ ...(await get(t.id)), status: 'in_progress' });
    expect((await bugs.reassign({ bugTaskId: t.id, to: 'frontend', reason: 'UI sends a string', by: 'backend-1' })).result).toBe('after_run');
    await taskStore.save({ ...(await get(t.id)), status: 'review' });
    expect(await bugs.applyHandoff(await get(t.id))).toBe(true);
    expect(await get(t.id)).toMatchObject({ role: 'frontend', status: 'todo' });

    const r = await bugs.reassign({ bugTaskId: t.id, to: 'backend', reason: 'API rounds wrong', by: 'frontend-1' });
    expect(r.result).toBe('decision');
    const d = (await decisions.pendingFor(t.id))[0]!;
    expect(d.options.sort()).toEqual(['backend', 'frontend']);
    await decisions.answer(d.id, { choice: 'backend', message: 'contract says number' });
    expect(await get(t.id)).toMatchObject({ role: 'backend', status: 'todo' });
  });

  it('when all bugs of a verification are done, one re-verify task; still broken goes to a human', async () => {
    const { file, bugs, taskStore, taskService, decisions, get } = setup();
    const a = await file();
    const b = await file('frontend');
    for (const t of [a, b]) {
      await taskStore.save({ ...(await get(t.id)), status: 'review' });
      await taskService.updateStatus(t.id, 'done');
    }
    await new Promise((r) => setTimeout(r, 30));
    const verify = (await taskStore.list()).filter((t) => t.verify_bugs?.length);
    expect(verify).toHaveLength(1);
    expect(verify[0]).toMatchObject({ role: 'qa', verify_bugs: [a.id, b.id] });
    expect(await bugs.verifyOutcome(verify[0]!)).toBe('missing');
    await bugs.verify({ bugTaskId: a.id, fixed: true, by: 'qa-1', verifyTaskId: verify[0]!.id });
    await bugs.verify({ bugTaskId: b.id, fixed: false, note: 'still 100', by: 'qa-1', verifyTaskId: verify[0]!.id });
    expect(await bugs.verifyOutcome(verify[0]!)).toBe('submitted');
    await bugs.verifyFinished(verify[0]!);
    const d = (await decisions.list({ status: 'pending' })).find((x) => x.source === 'bug')!;
    expect(d.bug_ids).toEqual([b.id]);
    await decisions.answer(d.id, { message: 'use BigDecimal' });
    const reopened = (await taskStore.list()).filter((t) => t.bug?.round === 2);
    expect(reopened).toHaveLength(1);
    expect(reopened[0]).toMatchObject({ role: 'frontend', priority: 1 });
  });
});
