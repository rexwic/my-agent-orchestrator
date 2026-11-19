/**
 * Delivery reports in the orchestrator: a run must end with a report handed in
 * during that run; partial / blocked waits for a human; prompts carry the
 * report contract and the reports of the tasks a task depends on.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Orchestrator } from '../../../src/application/orchestrator.js';
import { DecisionService } from '../../../src/application/decision-service.js';
import { DeliverableService } from '../../../src/application/deliverable-service.js';
import { DEFAULT_CONFIG } from '../../../src/domain/config.js';
import type { Agent } from '../../../src/domain/agent.js';
import { MemoryDecisionStore } from '../../../src/infrastructure/storage/decision-store.js';
import { MemoryDeliverableStore } from '../../../src/infrastructure/storage/deliverable-store.js';
import { AdapterRegistry } from '../../../src/infrastructure/adapters/registry.js';
import {
  buildDeps,
  makeAgent,
  makeRun,
  makeTask,
  createMockTaskStore,
  createMockAgentStore,
  createMockRunStore,
  createMockStateStore,
  createMockAdapter,
} from './helpers.js';

vi.mock('../../../src/infrastructure/storage/lock.js', () => ({
  acquireLock: vi.fn(async () => ({ acquired: true, pid: process.pid })),
  releaseLock: vi.fn(async () => {}),
  touchLock: vi.fn(async () => {}),
}));

const report = '## Summary\nAdded it.\n## Verification\nmvn test: 3 passed\n## Open issues\nNone';

const orchestrators: Orchestrator[] = [];
afterEach(() => {
  for (const o of orchestrators.splice(0)) {
    (o as any).shuttingDown = true;
    if ((o as any).intervalId) clearInterval((o as any).intervalId);
    if ((o as any).immediateDispatchTimer) clearTimeout((o as any).immediateDispatchTimer);
  }
});

/** Task tsk_w is running (started a minute ago) for an agent with the given adapter. */
async function setup(adapter: Agent['adapter'] = 'claude') {
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const taskStore = createMockTaskStore([makeTask({ id: 'tsk_w', title: 'Discount API', status: 'in_progress', attempts: 1, role: 'backend' })]);
  const agent = makeAgent({ id: 'agt_b', name: 'backend-1', adapter, status: 'running', current_task: 'tsk_w' });
  const runStore = createMockRunStore();
  await runStore.save(makeRun({ id: 'run_w', task_id: 'tsk_w', agent_id: 'agt_b', status: 'streaming' }));
  const entry = { run_id: 'run_w', task_id: 'tsk_w', agent_id: 'agt_b', pid: 1, started_at: startedAt };
  const deps = buildDeps({
    taskStore, runStore, agentStore: createMockAgentStore([agent]),
    stateStore: createMockStateStore({ running: { tsk_w: entry as any } }),
  });
  const decisions = new DecisionService(new MemoryDecisionStore(), taskStore, deps.taskService, deps.eventBus);
  const store = new MemoryDeliverableStore();
  const deliverables = new DeliverableService({ store, taskStore, eventBus: deps.eventBus, config: DEFAULT_CONFIG });
  deps.decisionService = decisions;
  deps.deliverableService = deliverables;
  const orch = new Orchestrator(deps);
  orchestrators.push(orch);
  await (orch as any).loadState();
  return {
    orch, decisions, deliverables, store, startedAt,
    get: async () => (await taskStore.get('tsk_w'))!,
    finish: () => (orch as any).handleRunSuccess('tsk_w', 'run_w', 'agt_b', undefined, 'all done!', []),
  };
}

describe('delivery report at the end of a run', () => {
  it('a run without a report fails and is retried with the reason', async () => {
    const { finish, get, orch } = await setup();
    await finish();
    expect((await get()).status).toBe('retrying');
    expect((orch as any).state.retry_queue).toContainEqual(expect.objectContaining({
      task_id: 'tsk_w', error: expect.stringMatching(/without a delivery report.*orch task deliver/),
    }));
  });

  it('a report from an earlier run does not count', async () => {
    const { finish, get, store, startedAt } = await setup();
    await store.save({ task_id: 'tsk_w', status: 'done', report, submitted_by: 'backend-1', submitted_at: new Date(Date.parse(startedAt) - 1000).toISOString() });
    await finish();
    expect((await get()).status).toBe('retrying');
  });

  it('done goes on to review as before', async () => {
    const { finish, get, deliverables } = await setup();
    await deliverables.submit({ taskId: 'tsk_w', report, status: 'done', submittedBy: 'backend-1' });
    await finish();
    expect(['review', 'done']).toContain((await get()).status);
  });

  it('blocked waits for a human, with the report as background', async () => {
    const { finish, get, deliverables, decisions } = await setup();
    await deliverables.submit({ taskId: 'tsk_w', report, status: 'blocked', submittedBy: 'backend-1' });
    await finish();
    expect((await get()).status).toBe('waiting_decision');
    const [d] = await decisions.pendingFor('tsk_w');
    expect(d).toMatchObject({ source: 'delivery', requested_by: 'backend-1', context: report });
    expect(d!.question).toMatch(/"Discount API" was delivered as blocked/);
  });

  it('a pending question needs no report (the agent stopped to ask)', async () => {
    const { finish, get, decisions } = await setup();
    await decisions.request({ task_id: 'tsk_w', source: 'agent', question: 'Percent or fixed?' });
    await finish();
    expect((await get()).status).toBe('waiting_decision');
  });

  it('shell roles need no report', async () => {
    const { finish, get } = await setup('shell');
    await finish();
    expect(['review', 'done']).toContain((await get()).status);
  });
});

describe('delivery prompt', () => {
  it('carries the report contract, the reports of dependencies and the contracts it uses', async () => {
    const taskStore = createMockTaskStore([
      makeTask({ id: 'tsk_up', title: 'API contract', status: 'done' }),
      makeTask({ id: 'tsk_fe', title: 'Discount screen', status: 'todo', depends_on: ['tsk_up'], produces: ['src/fe/**'], uses: ['docs/api/none.yaml'] }),
    ]);
    const adapterRegistry = new AdapterRegistry();
    adapterRegistry.register(createMockAdapter([{ type: 'done', timestamp: new Date().toISOString(), data: { result: 'ok' } }]));
    const deps = buildDeps({ taskStore, adapterRegistry, agentStore: createMockAgentStore([makeAgent({ id: 'agt_f', name: 'frontend-1', status: 'idle' })]) });
    const deliverables = new DeliverableService({ store: new MemoryDeliverableStore(), taskStore, eventBus: deps.eventBus, config: DEFAULT_CONFIG });
    // tsk_up is done (submit refuses finished tasks): put its report in place directly.
    await (deliverables as any).deps.store.save({ task_id: 'tsk_up', status: 'done', report, submitted_by: 'backend-1', submitted_at: new Date().toISOString() });
    vi.spyOn(deliverables, 'requiresReport').mockResolvedValue(true);
    deps.deliverableService = deliverables;
    const orch = new Orchestrator(deps);
    orchestrators.push(orch);
    await (orch as any).loadState();
    (orch as any).lockAcquired = true;

    await (orch as any).tick();
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && vi.mocked(deps.templateEngine.render).mock.calls.length === 0) await new Promise((r) => setTimeout(r, 10));

    const ctx = vi.mocked(deps.templateEngine.render).mock.calls.map(([, c]) => c as any).find((c) => c.task.id === 'tsk_fe');
    expect(ctx.delivery).toEqual({ sections: ['Summary', 'Verification', 'Open issues'], produces: ['src/fe/**'] });
    expect(ctx.upstream).toEqual([expect.objectContaining({ task_id: 'tsk_up', title: 'API contract', status: 'done' })]);
    expect(ctx.upstream[0].report).toMatch(/^#### Summary/);
    expect(ctx.contracts).toEqual([{ path: 'docs/api/none.yaml', content: '', missing: true }]);
  });
});
