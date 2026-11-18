/**
 * Orchestrator: roles, scope locks during review, dependency cycles, and
 * review criteria running outside the state lock.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Orchestrator } from '../../../src/application/orchestrator.js';
import { RoleService } from '../../../src/application/role-service.js';
import { DEFAULT_CONFIG, type OrchestratorConfig } from '../../../src/domain/config.js';
import { validateRole, type Role } from '../../../src/domain/role.js';
import { AdapterRegistry } from '../../../src/infrastructure/adapters/registry.js';
import type { IRoleStore } from '../../../src/infrastructure/storage/interfaces.js';
import type { IShellRunner, ShellRunResult } from '../../../src/infrastructure/process/shell-runner.js';
import {
  buildDeps,
  makeTask,
  makeAgent,
  makeRun,
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

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

class MemoryRoleStore implements IRoleStore {
  constructor(private readonly roles: Role[] = []) {}
  async save(role: Role) { this.roles.push(role); }
  async get(name: string) { return this.roles.find((r) => r.name === name) ?? null; }
  async load() { return { roles: [...this.roles], errors: [] }; }
  async list() { return [...this.roles]; }
  async delete() {}
}

/** Shell runner whose runs stay pending until released; tracks concurrency. */
function gatedShell() {
  const pending: Array<(r: ShellRunResult) => void> = [];
  let active = 0;
  let maxActive = 0;
  const shell: IShellRunner = {
    run: vi.fn(() => {
      active++;
      maxActive = Math.max(maxActive, active);
      return new Promise<ShellRunResult>((resolve) => pending.push((r) => { active--; resolve(r); }));
    }),
  };
  return {
    shell,
    pending,
    get maxActive() { return maxActive; },
    releaseAll: () => { while (pending.length) pending.shift()!({ exitCode: 0, output: 'ok', timedOut: false }); },
  };
}

const orchestrators: Orchestrator[] = [];
afterEach(() => {
  for (const o of orchestrators.splice(0)) {
    (o as any).shuttingDown = true;
    if ((o as any).intervalId) clearInterval((o as any).intervalId);
    if ((o as any).immediateDispatchTimer) clearTimeout((o as any).immediateDispatchTimer);
  }
});

function track(o: Orchestrator): Orchestrator {
  orchestrators.push(o);
  return o;
}

/** A task that just finished running, with review criteria. */
async function finishedTaskSetup(ids: string[], config: OrchestratorConfig = DEFAULT_CONFIG) {
  const tasks = ids.map((id) => makeTask({ id, status: 'in_progress', attempts: 1, review_criteria: ['test_pass'] }));
  const agents = ids.map((id, i) => makeAgent({ id: `agt_${i}`, name: `a${i}`, status: 'running', current_task: id }));
  const taskStore = createMockTaskStore(tasks);
  const agentStore = createMockAgentStore(agents);
  const runStore = createMockRunStore();
  const running: Record<string, any> = {};
  for (const [i, id] of ids.entries()) {
    await runStore.save(makeRun({ id: `run_${i}`, task_id: id, agent_id: `agt_${i}`, status: 'streaming' }));
    running[id] = { run_id: `run_${i}`, task_id: id, agent_id: `agt_${i}`, pid: 1000 + i, started_at: new Date().toISOString(), last_event_at: new Date().toISOString() };
  }
  const gate = gatedShell();
  const deps = buildDeps({ taskStore, agentStore, runStore, stateStore: createMockStateStore({ running }), shellRunner: gate.shell, config });
  const orch = track(new Orchestrator(deps));
  await (orch as any).loadState();
  return { orch, taskStore, agentStore, gate };
}

describe('Orchestrator — review outside the state lock', () => {
  it('releases the state lock while review criteria run, then approves', async () => {
    const { orch, taskStore, agentStore, gate } = await finishedTaskSetup(['tsk_a']);

    const finishing = (orch as any).handleRunSuccess('tsk_a', 'run_0', 'agt_0', undefined, 'done', []);
    await waitFor(() => gate.pending.length === 1);

    // While `mvn test` runs: the lock is free, the agent is already idle, the task waits in review.
    await expect(Promise.race([
      (orch as any).withStateLock(async () => 'lock acquired'),
      new Promise((r) => setTimeout(() => r('lock blocked'), 500)),
    ])).resolves.toBe('lock acquired');
    expect((await agentStore.get('agt_0'))!.status).toBe('idle');
    expect((await taskStore.get('tsk_a'))!.status).toBe('review');

    gate.releaseAll();
    await finishing;
    expect((await taskStore.get('tsk_a'))!.status).toBe('done');
  });

  it('runs at most review.max_parallel reviews at once (default 1)', async () => {
    const { orch, taskStore, gate } = await finishedTaskSetup(['tsk_a', 'tsk_b']);

    const done = Promise.all([
      (orch as any).handleRunSuccess('tsk_a', 'run_0', 'agt_0', undefined, 'done', []),
      (orch as any).handleRunSuccess('tsk_b', 'run_1', 'agt_1', undefined, 'done', []),
    ]);
    await waitFor(() => gate.pending.length === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(gate.pending.length).toBe(1); // second review queued

    gate.releaseAll();
    await waitFor(() => gate.pending.length === 1);
    gate.releaseAll();
    await done;

    expect(gate.maxActive).toBe(1);
    expect((await taskStore.get('tsk_b'))!.status).toBe('done');
  });

  it('allows parallel reviews when configured', async () => {
    const config = { ...DEFAULT_CONFIG, review: { ...DEFAULT_CONFIG.review!, max_parallel: 2 } };
    const { orch, gate } = await finishedTaskSetup(['tsk_a', 'tsk_b'], config);

    const done = Promise.all([
      (orch as any).handleRunSuccess('tsk_a', 'run_0', 'agt_0', undefined, 'done', []),
      (orch as any).handleRunSuccess('tsk_b', 'run_1', 'agt_1', undefined, 'done', []),
    ]);
    await waitFor(() => gate.pending.length === 2);
    gate.releaseAll();
    await done;
    expect(gate.maxActive).toBe(2);
  });
});

describe('Orchestrator — scheduling safeguards', () => {
  it('keeps a scope locked while its task waits in review (changes not merged yet)', async () => {
    const reviewing = makeTask({ id: 'tsk_review', status: 'review', scope: ['src/main/java/order/**'] });
    const overlapping = makeTask({ id: 'tsk_overlap', status: 'todo', scope: ['src/main/java/order/OrderService.java'] });
    const disjoint = makeTask({ id: 'tsk_disjoint', status: 'todo', scope: ['src/main/java/user/**'] });
    const deps = buildDeps({ taskStore: createMockTaskStore([reviewing, overlapping, disjoint]) });
    const orch = track(new Orchestrator(deps));
    await (orch as any).loadState();
    const dispatched: string[] = [];
    vi.spyOn(orch as any, 'dispatchTask').mockImplementation(async (id: unknown) => { dispatched.push(id as string); });

    await (orch as any).dispatchAll();

    expect(dispatched).toEqual(['tsk_disjoint']);
  });

  it('reports a dependency cycle once instead of waiting silently', async () => {
    const a = makeTask({ id: 'tsk_a', status: 'todo', depends_on: ['tsk_b'] });
    const b = makeTask({ id: 'tsk_b', status: 'todo', depends_on: ['tsk_a'] });
    const deps = buildDeps({ taskStore: createMockTaskStore([a, b]) });
    const events: any[] = [];
    deps.eventBus.onAny((e: any) => events.push(e));
    const orch = track(new Orchestrator(deps));
    await (orch as any).loadState();

    await (orch as any).dispatchAll();
    await (orch as any).dispatchAll();

    const errors = events.filter((e) => e.type === 'orchestrator:error' && /Dependency cycle/.test(e.error));
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toMatch(/tsk_a → tsk_b → tsk_a|tsk_b → tsk_a → tsk_b/);
    expect(events.filter((e) => e.type === 'task:dependency_cycle')).toHaveLength(1);
  });
});

describe('Orchestrator — roles', () => {
  it('syncs roles every tick and dispatches a role task to an instance, recording what ran', async () => {
    const role = validateRole({ name: 'backend', adapter: 'shell', command: 'echo hi', replicas: 1, description: 'Backend' });
    const task = makeTask({ id: 'tsk_r', status: 'todo', role: 'backend' });
    const taskStore = createMockTaskStore([task]);
    const agentStore = createMockAgentStore([]);
    const runStore = createMockRunStore();
    const adapterRegistry = new AdapterRegistry();
    adapterRegistry.register(createMockAdapter([{ type: 'done', timestamp: new Date().toISOString(), data: { result: 'ok' } }]));
    const deps = buildDeps({ taskStore, agentStore, runStore, adapterRegistry });
    deps.roleService = new RoleService(new MemoryRoleStore([role]), agentStore, deps.eventBus, deps.config);
    const orch = track(new Orchestrator(deps));
    await (orch as any).loadState();
    (orch as any).lockAcquired = true;

    await (orch as any).tick();
    await waitFor(async () => (await taskStore.get('tsk_r'))?.status === 'done');

    const instance = (await agentStore.list()).find((a) => a.role_id === 'backend');
    expect(instance?.name).toBe('backend-1');
    const [run] = await runStore.listAll();
    expect(run!.agent_id).toBe(instance!.id);
    expect(run!.executed).toEqual({ adapter: 'shell', role: 'backend' });
  });

  it('does not give a role task to an agent of another role', async () => {
    const task = makeTask({ id: 'tsk_r', status: 'todo', role: 'backend' });
    const qa = makeAgent({ id: 'agt_qa', name: 'qa-1', role_id: 'qa', status: 'idle' });
    const deps = buildDeps({ taskStore: createMockTaskStore([task]), agentStore: createMockAgentStore([qa]) });
    const orch = track(new Orchestrator(deps));

    await expect(deps.agentService.findBestAgent(task)).resolves.toBeNull();
    void orch;
  });
});
