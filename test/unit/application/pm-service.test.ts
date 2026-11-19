import { describe, it, expect } from 'vitest';
import { PmService } from '../../../src/application/pm-service.js';
import { DecisionService, buildDecisionFeedback } from '../../../src/application/decision-service.js';
import { TaskService } from '../../../src/application/task-service.js';
import { EventBus } from '../../../src/application/event-bus.js';
import { DEFAULT_CONFIG } from '../../../src/domain/config.js';
import { validateRole, type Role } from '../../../src/domain/role.js';
import { MemoryDecisionStore } from '../../../src/infrastructure/storage/decision-store.js';
import type { IRoleStore } from '../../../src/infrastructure/storage/interfaces.js';
import { createMockTaskStore, createMockAgentStore, makeTask } from './helpers.js';

function setup(roleNames: string[] = ['pm', 'backend']) {
  const roles: Role[] = roleNames.map((name) => validateRole({ name, adapter: 'claude' }));
  const roleStore: IRoleStore = {
    save: async () => {}, delete: async () => {},
    get: async (n) => roles.find((r) => r.name === n) ?? null,
    load: async () => ({ roles, errors: [] }),
    list: async () => roles,
  };
  const taskStore = createMockTaskStore([
    makeTask({ id: 'tsk_be', title: 'Discount API', description: 'Implement it', status: 'in_progress', role: 'backend', prd: 'discount' }),
    makeTask({ id: 'tsk_pmown', title: 'PRD: discounts', status: 'in_progress', role: 'pm', prd_draft: 'discount' }),
  ]);
  const eventBus = new EventBus();
  const events: any[] = [];
  eventBus.onAny((e: any) => events.push(e));
  const taskService = new TaskService(taskStore, eventBus, DEFAULT_CONFIG, undefined, createMockAgentStore(), roleStore);
  const decisions = new DecisionService(new MemoryDecisionStore(), taskStore, taskService, eventBus);
  const pm = new PmService({ decisionService: decisions, taskService, taskStore, roleStore, eventBus, config: DEFAULT_CONFIG });
  const ask = (taskId = 'tsk_be', requestedBy = 'backend-1') => decisions.request({
    task_id: taskId, source: 'agent', question: 'Percent or fixed discounts?', options: ['percent', 'fixed'], context: 'PRD is silent', requested_by: requestedBy,
  });
  return { pm, decisions, taskStore, events, ask, task: async (id: string) => (await taskStore.get(id))! };
}

describe('agent questions go to the PM first', () => {
  it('assigns the question to the PM and gives it a task with everything it needs', async () => {
    const { ask, decisions, task } = setup();
    const d = await ask();
    expect(d).toMatchObject({ assignee: 'pm', triage_task_id: expect.stringMatching(/^tsk_/) });
    const pmTask = await task(d.triage_task_id!);
    expect(pmTask).toMatchObject({ role: 'pm', priority: 1, labels: ['pm-answer'], triage_decision_id: d.id, prd: 'discount', status: 'todo' });
    expect(pmTask.title).toBe('Answer: Percent or fixed discounts?');
    expect(pmTask.description).toContain('backend-1 asked a question while working on "Discount API" (tsk_be)');
    expect(pmTask.description).toContain('2. fixed');
    expect(pmTask.description).toContain('PRD is silent');
    // Not in the human's queue.
    expect(await decisions.list({ status: 'pending', assignee: 'human' })).toEqual([]);
  });

  it("the PM's own questions, non-agent decisions and projects without a PM role go to a human", async () => {
    const { ask, decisions } = setup();
    expect((await ask('tsk_pmown', 'pm-1')).assignee).toBeUndefined();
    expect((await decisions.request({ task_id: 'tsk_be', source: 'gate', question: 'Start?' })).assignee).toBeUndefined();
    const noPm = setup(['backend']);
    expect((await noPm.ask()).assignee).toBeUndefined();
  });

  it('the PM answers: the asker continues, told the PM answered', async () => {
    const { ask, decisions, task, taskStore } = setup();
    const d = await ask();
    // The asker's run ended after asking (the orchestrator parks it).
    await taskStore.save({ ...(await task('tsk_be')), status: 'waiting_decision' });
    const r = await decisions.answer(d.id, { choice: 'percent', message: 'PRD v2 says percent, max 50%' }, { agent: 'pm-1' });
    expect(r.decision.answer).toMatchObject({ answered_by: 'pm-1', action: 'continue' });
    expect(r.task?.status).toBe('todo');
    expect((await task('tsk_be')).feedback).toMatch(/^pm-1 \(PM\) answered a question about this task/);
    expect(buildDecisionFeedback(r.decision)).toContain('Answer: percent — PRD v2 says percent, max 50%');
  });

  it('the PM can only continue the task, not approve / cancel / set project rules; other agents cannot answer', async () => {
    const { ask, decisions } = setup();
    const d = await ask();
    await expect(decisions.answer(d.id, { message: 'ok', action: 'approve' }, { agent: 'pm-1' })).rejects.toThrow(/only answer/);
    await expect(decisions.answer(d.id, { message: 'ok', scope: 'project' }, { agent: 'pm-1' })).rejects.toThrow(/only answer/);
    await expect(decisions.answer(d.id, { message: 'ok' }, { agent: 'backend-1' })).rejects.toThrow(/assigned to the pm role/);
    const human = await decisions.request({ task_id: 'tsk_be', source: 'gate', question: 'Start?' });
    await expect(decisions.answer(human.id, { message: 'ok' }, { agent: 'pm-1' })).rejects.toThrow(/for a human/);
  });

  it('the PM escalates: the question moves to the human queue with its note', async () => {
    const { ask, decisions, events } = setup();
    const d = await ask();
    const e = await decisions.escalate(d.id, { by: 'pm-1', note: 'Pricing policy is a business call' });
    expect(e.assignee).toBeUndefined();
    expect(e.context).toContain('pm-1 escalated it: Pricing policy is a business call');
    expect((await decisions.list({ status: 'pending', assignee: 'human' })).map((x) => x.id)).toEqual([d.id]);
    expect(events).toContainEqual(expect.objectContaining({ type: 'decision:escalated', decisionId: d.id, by: 'pm-1' }));
    await expect(decisions.escalate(d.id, { by: 'pm-1', note: 'again' })).rejects.toThrow(/not assigned/);
  });

  it('triage outcome: done once answered or escalated', async () => {
    const { ask, decisions, pm, task } = setup();
    const d = await ask();
    const pmTask = await task(d.triage_task_id!);
    expect(await pm.triageOutcome(pmTask)).toBe('missing');
    await decisions.escalate(d.id, { by: 'pm-1', note: 'no idea' });
    expect(await pm.triageOutcome(pmTask)).toBe('submitted');
    expect(await pm.promptContext(pmTask)).toMatchObject({ decision_id: d.id, asked_by: 'backend-1', asking_task: { id: 'tsk_be', title: 'Discount API' }, options: ['percent', 'fixed'] });
  });

  it('a PM task that fails or is cancelled escalates the question', async () => {
    const { ask, decisions, taskStore } = setup();
    const d = await ask();
    const pmTask = (await taskStore.get(d.triage_task_id!))!;
    await taskStore.save({ ...pmTask, status: 'in_progress' });
    const svc = (decisions as any).taskService as TaskService;
    await svc.updateStatus(pmTask.id, 'failed');
    await new Promise((r) => setTimeout(r, 20));
    const after = await decisions.get(d.id);
    expect(after.assignee).toBeUndefined();
    expect(after.context).toContain(`The PM task ${pmTask.id} ended (failed) without an answer`);
  });

  it('a human answering a question the PM still holds cancels the queued PM task', async () => {
    const { ask, decisions, task } = setup();
    const d = await ask();
    await decisions.answer(d.id, { message: 'fixed' });
    expect((await task(d.triage_task_id!)).status).toBe('cancelled');
    expect((await decisions.get(d.id)).answer?.answered_by).toBe('human');
  });
});
