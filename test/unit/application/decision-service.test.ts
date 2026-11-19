import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DecisionService, buildDecisionFeedback } from '../../../src/application/decision-service.js';
import { TaskService } from '../../../src/application/task-service.js';
import { EventBus } from '../../../src/application/event-bus.js';
import { DEFAULT_CONFIG } from '../../../src/domain/config.js';
import { DecisionStore, MemoryDecisionStore } from '../../../src/infrastructure/storage/decision-store.js';
import { Paths } from '../../../src/infrastructure/storage/paths.js';
import type { Task } from '../../../src/domain/task.js';
import { createMockTaskStore, createMockAgentStore, makeTask } from './helpers.js';

function setup(tasks: Task[] = []) {
  const taskStore = createMockTaskStore(tasks);
  const eventBus = new EventBus();
  const events: any[] = [];
  eventBus.onAny((e: any) => events.push(e));
  const taskService = new TaskService(taskStore, eventBus, DEFAULT_CONFIG, undefined, createMockAgentStore());
  const store = new MemoryDecisionStore();
  const service = new DecisionService(store, taskStore, taskService, eventBus);
  const task = async (id: string) => (await taskStore.get(id))!;
  return { service, taskService, taskStore, store, events, task };
}

describe('DecisionService.request', () => {
  it('records the decision and holds a queued or reviewed task in waiting_decision', async () => {
    const { service, events, task } = setup([
      makeTask({ id: 'tsk_todo', status: 'todo' }),
      makeTask({ id: 'tsk_rev', status: 'review' }),
    ]);

    const d = await service.request({ task_id: 'tsk_todo', source: 'gate', question: 'Start the schema migration?' });
    await service.request({ task_id: 'tsk_rev', source: 'escalation', question: 'Still conflicting', requested_by: 'orch' });

    expect(d).toMatchObject({ status: 'pending', source: 'gate', task_id: 'tsk_todo', requested_by: 'human', options: [] });
    expect(d.id).toMatch(/^dec_/);
    expect((await task('tsk_todo')).status).toBe('waiting_decision');
    expect((await task('tsk_rev')).status).toBe('waiting_decision');
    expect(events).toContainEqual(expect.objectContaining({ type: 'decision:requested', decisionId: d.id, taskId: 'tsk_todo', source: 'gate' }));
  });

  it('leaves a running task alone (the orchestrator moves it when the run ends)', async () => {
    const { service, task } = setup([makeTask({ id: 'tsk_run', status: 'in_progress' })]);

    await service.request({ task_id: 'tsk_run', source: 'agent', question: 'Which API version?', requested_by: 'backend-1' });

    expect((await task('tsk_run')).status).toBe('in_progress');
    expect(await service.pendingFor('tsk_run')).toHaveLength(1);
  });

  it('rejects unknown and finished tasks', async () => {
    const { service } = setup([makeTask({ id: 'tsk_done', status: 'done' })]);
    await expect(service.request({ task_id: 'tsk_nope', source: 'agent', question: 'q' })).rejects.toThrow(/not found/);
    await expect(service.request({ task_id: 'tsk_done', source: 'agent', question: 'q' })).rejects.toThrow(/done/);
  });
});

describe('DecisionService.answer', () => {
  it('continue: the task goes back to todo with the answer as feedback and a fresh send-back budget', async () => {
    const { service, task, events, taskStore } = setup([makeTask({ id: 'tsk_a', status: 'in_progress', attempts: 2, send_backs: 3 })]);
    const d = await service.request({ task_id: 'tsk_a', source: 'agent', question: 'Money type?', options: ['BigDecimal', 'long'] });
    // the run ended: orchestrator moved it
    const t = await task('tsk_a');
    t.status = 'waiting_decision';
    await taskStore.save(t);

    const result = await service.answer(d.id, { choice: '1', message: 'scale 2, HALF_UP' });

    expect(result.decision).toMatchObject({ status: 'answered', answer: { choice: 'BigDecimal', message: 'scale 2, HALF_UP', action: 'continue', scope: 'task' } });
    const after = await task('tsk_a');
    expect(after).toMatchObject({ status: 'todo', send_backs: 0, attempts: 0 });
    expect(after.feedback).toContain('Question: Money type?');
    expect(after.feedback).toContain('Answer: BigDecimal — scale 2, HALF_UP');
    expect(events).toContainEqual(expect.objectContaining({ type: 'decision:answered', decisionId: d.id, action: 'continue' }));
  });

  it('approve: back to review, approved (the orchestrator integrates it)', async () => {
    const { service, task } = setup([makeTask({ id: 'tsk_a', status: 'review' })]);
    const d = await service.request({ task_id: 'tsk_a', source: 'escalation', question: 'Still failing' });

    await service.answer(d.id, { action: 'approve' });

    expect(await task('tsk_a')).toMatchObject({ status: 'review', approved: true });
  });

  it('cancel: the task is cancelled', async () => {
    const { service, task } = setup([makeTask({ id: 'tsk_a', status: 'todo' })]);
    const d = await service.request({ task_id: 'tsk_a', source: 'gate', question: 'Start?' });

    await service.answer(d.id, { action: 'cancel', message: 'not now' });

    expect((await task('tsk_a')).status).toBe('cancelled');
  });

  it('waits until every pending decision on the task is answered', async () => {
    const { service, task } = setup([makeTask({ id: 'tsk_a', status: 'todo' })]);
    const first = await service.request({ task_id: 'tsk_a', source: 'gate', question: 'Start?' });
    const second = await service.request({ task_id: 'tsk_a', source: 'gate', question: 'Which module first?' });

    const r1 = await service.answer(first.id, { message: 'yes' });
    expect(r1.stillPending).toBe(1);
    expect((await task('tsk_a')).status).toBe('waiting_decision');

    await service.answer(second.id, { message: 'orders' });
    expect((await task('tsk_a')).status).toBe('todo');
  });

  it('refuses to answer twice', async () => {
    const { service } = setup();
    const d = await service.request({ source: 'gate', question: 'Naming convention?' });
    await service.answer(d.id, { message: 'kebab-case' });
    await expect(service.answer(d.id, { message: 'snake_case' })).rejects.toThrow(/already answered: kebab-case/);
  });
});

describe('DecisionService.bindingFor', () => {
  it('gives the task its own answers plus project-wide ones, not other tasks\' task-scoped answers', async () => {
    const { service } = setup([
      makeTask({ id: 'tsk_a', status: 'todo' }),
      makeTask({ id: 'tsk_b', status: 'todo' }),
    ]);
    const rule = await service.request({ task_id: 'tsk_b', source: 'agent', question: 'Money type?' });
    await service.answer(rule.id, { message: 'BigDecimal', scope: 'project' });
    const local = await service.request({ task_id: 'tsk_b', source: 'agent', question: 'Endpoint name?' });
    await service.answer(local.id, { message: '/orders' });
    const own = await service.request({ task_id: 'tsk_a', source: 'agent', question: 'Page size?' });
    await service.answer(own.id, { message: '50' });
    await service.request({ task_id: 'tsk_a', source: 'agent', question: 'Still pending' });

    const forA = await service.bindingFor({ id: 'tsk_a' });

    expect(forA.map((d) => d.question)).toEqual(['Money type?', 'Page size?']);
  });
});

describe('buildDecisionFeedback', () => {
  it('includes the escalation background so the agent knows what it is resuming', () => {
    const text = buildDecisionFeedback({
      id: 'dec_1', status: 'answered', source: 'escalation', question: 'Still conflicting. Proceed?', options: [],
      context: 'The merge is still in progress in your workspace.\n- Order.java', requested_by: 'orch', created_at: '',
      answer: { message: 'keep main\'s BigDecimal, drop long', action: 'continue', scope: 'task', answered_at: '' },
    });
    expect(text).toContain('Answer: keep main\'s BigDecimal, drop long');
    expect(text).toContain('Background (why it was escalated):');
    expect(text).toContain('- Order.java');
  });
});

describe('TaskService — needs_decision', () => {
  it('creates the task in waiting_decision so it is never dispatched before the answer', async () => {
    const { taskService } = setup();
    const task = await taskService.create({ title: 'Change the orders schema', needs_decision: true });
    expect(task.status).toBe('waiting_decision');
  });
});

describe('DecisionStore (files)', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-decisions-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }); });

  it('round-trips decisions as YAML files, oldest first', async () => {
    const paths = new Paths(dir);
    const store = new DecisionStore(paths);
    await store.save({ id: 'dec_b', status: 'pending', source: 'agent', question: 'B?', options: [], requested_by: 'x', created_at: '2026-11-19T02:00:00Z' });
    await store.save({ id: 'dec_a', status: 'pending', source: 'gate', question: 'A?', options: ['1', '2'], requested_by: 'human', created_at: '2026-11-19T01:00:00Z' });

    expect((await store.list()).map((d) => d.id)).toEqual(['dec_a', 'dec_b']);
    expect(await store.get('dec_a')).toMatchObject({ options: ['1', '2'] });
    await expect(fs.readFile(path.join(paths.decisionsDir, 'dec_a.yml'), 'utf-8')).resolves.toContain('question: A?');
  });
});
