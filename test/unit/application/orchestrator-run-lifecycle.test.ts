/**
 * Run lifecycle fixes (cf. upstream a4975b6, adapted to this fork):
 * - a retrying task waits out its backoff;
 * - timeout_ms stops a run that keeps producing output;
 * - a failed run keeps its worktree and branch;
 * - a stopped run that finishes late cannot complete the newer run of its task.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Orchestrator } from '../../../src/application/orchestrator.js';
import { AdapterRegistry } from '../../../src/infrastructure/adapters/registry.js';
import type { AgentEvent, ExecuteHandle } from '../../../src/infrastructure/adapters/interface.js';
import { DEFAULT_CONFIG, type OrchestratorConfig } from '../../../src/domain/config.js';
import {
  makeTask, makeAgent, createMockTaskStore, createMockAgentStore, createMockStateStore,
  createMockAdapter, createMockWorkspaceManager, cleanupOrch, buildDeps,
} from './helpers.js';

vi.mock('../../../src/infrastructure/storage/lock.js', () => ({
  acquireLock: vi.fn(async () => ({ acquired: true, pid: process.pid })),
  releaseLock: vi.fn(async () => {}),
  touchLock: vi.fn(async () => {}),
}));

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ev = (type: AgentEvent['type'], data = 'x'): AgentEvent => ({ type, timestamp: new Date().toISOString(), data } as AgentEvent);
const config = (scheduling: Partial<OrchestratorConfig['scheduling']> = {}): OrchestratorConfig =>
  ({ ...DEFAULT_CONFIG, scheduling: { ...DEFAULT_CONFIG.scheduling, poll_interval_ms: 50, ...scheduling } });

/** Output every 20ms until stopped; then optionally a final done event. */
async function* chatty(stop: { done: boolean }, endWithDone = false): AsyncGenerator<AgentEvent> {
  while (!stop.done) { yield ev('output'); await wait(20); }
  if (endWithDone) yield ev('done', 'late result');
}

let orch: Orchestrator | undefined;
afterEach(() => { if (orch) cleanupOrch(orch); orch = undefined; });

function registryWith(execute: () => ExecuteHandle) {
  const adapter = { ...createMockAdapter(), execute: vi.fn(execute) };
  const registry = new AdapterRegistry();
  registry.register(adapter);
  return { adapter, registry };
}

describe('retry backoff', () => {
  it('a retrying task does not run before its retry is due', async () => {
    const { adapter, registry } = registryWith(() => ({ pid: 99999, events: chatty({ done: true }, true) }));
    const stateStore = createMockStateStore({
      retry_queue: [{ task_id: 'tsk_r', attempt: 2, due_at: new Date(Date.now() + 3_600_000).toISOString(), error: 'temp' }],
    });
    orch = new Orchestrator(buildDeps({
      taskStore: createMockTaskStore([makeTask({ id: 'tsk_r', status: 'retrying', attempts: 1 })]),
      agentStore: createMockAgentStore([makeAgent({ id: 'agt_1', status: 'idle' })]),
      stateStore, adapterRegistry: registry, config: config(),
    }));
    await orch.startWatch({ skipAutonomousSeeding: true });
    await wait(200);
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it('runs it once the retry is due', async () => {
    const { adapter, registry } = registryWith(() => ({ pid: 99999, events: chatty({ done: true }, true) }));
    const stateStore = createMockStateStore({
      retry_queue: [{ task_id: 'tsk_r', attempt: 2, due_at: new Date(Date.now() + 150).toISOString(), error: 'temp' }],
    });
    orch = new Orchestrator(buildDeps({
      taskStore: createMockTaskStore([makeTask({ id: 'tsk_r', status: 'retrying', attempts: 1 })]),
      agentStore: createMockAgentStore([makeAgent({ id: 'agt_1', status: 'idle' })]),
      stateStore, adapterRegistry: registry, config: config(),
    }));
    await orch.startWatch({ skipAutonomousSeeding: true });
    await wait(60);
    expect(adapter.execute).not.toHaveBeenCalled();
    await wait(400);
    expect(adapter.execute).toHaveBeenCalledTimes(1);
  });
});

describe('run time limit and failed runs', () => {
  it('stops a run that keeps producing output at timeout_ms and keeps its worktree', async () => {
    const stop = { done: false };
    const { registry } = registryWith(() => ({ pid: 99999, events: chatty(stop) }));
    const taskStore = createMockTaskStore([makeTask({ id: 'tsk_t', status: 'todo', proof: { branch: 'orchestry/tsk_t/x', files_changed: [] } })]);
    const workspaceManager = createMockWorkspaceManager();
    const agent = makeAgent({ id: 'agt_1', status: 'idle' });
    agent.config = { ...agent.config, timeout_ms: 300, stall_timeout_ms: 60_000 };
    orch = new Orchestrator(buildDeps({
      taskStore, agentStore: createMockAgentStore([agent]), adapterRegistry: registry, workspaceManager,
      config: config({ retry_base_delay_ms: 60_000 }),
    }));
    await orch.startWatch({ skipAutonomousSeeding: true });
    await wait(900);
    stop.done = true;
    const task = (await taskStore.get('tsk_t'))!;
    expect(task.status).toBe('retrying');
    expect(workspaceManager.cleanup).not.toHaveBeenCalled();
  });

  it('stops a live run that produces no events at stall_timeout_ms', async () => {
    async function* hung(): AsyncGenerator<AgentEvent> { await new Promise(() => {}); }
    const { registry } = registryWith(() => ({ pid: 99999, events: hung() }));
    const taskStore = createMockTaskStore([makeTask({ id: 'tsk_h', status: 'todo' })]);
    const agent = makeAgent({ id: 'agt_1', status: 'idle' });
    agent.config = { ...agent.config, timeout_ms: 60_000, stall_timeout_ms: 200 };
    const deps = buildDeps({ taskStore, agentStore: createMockAgentStore([agent]), adapterRegistry: registry, config: config({ retry_base_delay_ms: 60_000 }) });
    orch = new Orchestrator(deps);
    await orch.startWatch({ skipAutonomousSeeding: true });
    await wait(700);
    expect((await taskStore.get('tsk_h'))!.status).toBe('retrying');
    expect(deps.processManager.killWithGrace).toHaveBeenCalledWith(99999, 5_000);
    expect((await deps.agentStore.get('agt_1'))!.status).toBe('idle');
  });

  it('a timed-out run that ends late does not complete the retry that replaced it', async () => {
    const first = { done: false };
    const second = { done: false };
    let calls = 0;
    const { adapter, registry } = registryWith(() => {
      calls++;
      return { pid: 99999, events: calls === 1 ? chatty(first, true) : chatty(second) };
    });
    const taskStore = createMockTaskStore([makeTask({ id: 'tsk_l', status: 'todo', max_attempts: 3 })]);
    const agents = [makeAgent({ id: 'agt_1', status: 'idle' }), makeAgent({ id: 'agt_2', status: 'idle' })];
    for (const a of agents) a.config = { ...a.config, timeout_ms: 300, stall_timeout_ms: 60_000 };
    orch = new Orchestrator(buildDeps({
      taskStore, agentStore: createMockAgentStore(agents), adapterRegistry: registry,
      config: config({ retry_base_delay_ms: 50, retry_max_delay_ms: 50 }),
    }));
    await orch.startWatch({ skipAutonomousSeeding: true });
    // Run 1 times out (~300ms) and is retried; run 2 starts.
    for (let i = 0; i < 40 && adapter.execute.mock.calls.length < 2; i++) await wait(25);
    expect(adapter.execute).toHaveBeenCalledTimes(2);
    // Run 1's stream now ends with a result — too late, it was replaced.
    first.done = true;
    await wait(150);
    expect((await taskStore.get('tsk_l'))!.status).toBe('in_progress');
    second.done = true;
  });
});
