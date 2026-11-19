/**
 * Planning tasks in the orchestrator: the planner gets the planning prompt,
 * its run is done once the plan is submitted (no commit/merge, worktree
 * removed), and a run that ends without a plan is a failure.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Orchestrator } from '../../../src/application/orchestrator.js';
import { DecisionService } from '../../../src/application/decision-service.js';
import { PlanService } from '../../../src/application/plan-service.js';
import { GoalService } from '../../../src/application/goal-service.js';
import { DEFAULT_CONFIG } from '../../../src/domain/config.js';
import { validateRole } from '../../../src/domain/role.js';
import type { Task } from '../../../src/domain/task.js';
import { MemoryDecisionStore } from '../../../src/infrastructure/storage/decision-store.js';
import { MemoryPlanStore } from '../../../src/infrastructure/storage/plan-store.js';
import type { IGoalStore, IRoleStore } from '../../../src/infrastructure/storage/interfaces.js';
import { AdapterRegistry } from '../../../src/infrastructure/adapters/registry.js';
import {
  buildDeps,
  makeAgent,
  makeRun,
  createMockTaskStore,
  createMockAgentStore,
  createMockRunStore,
  createMockStateStore,
  createMockWorkspaceManager,
  createMockAdapter,
} from './helpers.js';

vi.mock('../../../src/infrastructure/storage/lock.js', () => ({
  acquireLock: vi.fn(async () => ({ acquired: true, pid: process.pid })),
  releaseLock: vi.fn(async () => {}),
  touchLock: vi.fn(async () => {}),
}));

const roles = [validateRole({ name: 'planner', adapter: 'claude' }), validateRole({ name: 'backend', adapter: 'claude', description: 'Java' })];
const roleStore: IRoleStore = {
  save: async () => {}, delete: async () => {},
  get: async (n) => roles.find((r) => r.name === n) ?? null,
  load: async () => ({ roles, errors: [] }),
  list: async () => roles,
};
const goalStore: IGoalStore = { list: async () => [], get: async () => null, save: async () => {}, delete: async () => {} };

const draft = { goal: 'G', tasks: [{ key: 'a', title: 'A', role: 'backend', description: 'do A' }] };

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

const orchestrators: Orchestrator[] = [];
afterEach(() => {
  for (const o of orchestrators.splice(0)) {
    (o as any).shuttingDown = true;
    if ((o as any).intervalId) clearInterval((o as any).intervalId);
    if ((o as any).immediateDispatchTimer) clearTimeout((o as any).immediateDispatchTimer);
  }
});

/** A plan whose planning task is running in a worktree. */
async function setup() {
  const taskStore = createMockTaskStore();
  const deps0 = buildDeps({ taskStore });
  const decisions = new DecisionService(new MemoryDecisionStore(), taskStore, deps0.taskService, deps0.eventBus);
  const planService = new PlanService({
    store: new MemoryPlanStore(), taskStore, taskService: deps0.taskService,
    goalService: new GoalService(goalStore, deps0.eventBus, { enableAutonomous: vi.fn() } as any, deps0.taskService),
    decisionService: decisions, roleStore, eventBus: deps0.eventBus, config: DEFAULT_CONFIG,
  });
  // TaskService in buildDeps has no role store: create the plan's task by hand.
  vi.spyOn(deps0.taskService, 'create').mockImplementationOnce(async (input) => {
    const t: Task = {
      id: 'tsk_plan', title: input.title, description: input.description ?? '', status: 'in_progress', priority: 3,
      role: input.role, labels: input.labels ?? [], depends_on: [], created_at: '', updated_at: '', attempts: 1, max_attempts: 3,
      review_criteria: [], plan_id: input.plan_id,
      workspace: '/tmp/project/.orchestry/workspaces/tsk_plan', proof: { branch: 'orchestry/tsk_plan/plan', files_changed: [] },
    };
    await taskStore.save(t);
    return t;
  });
  const { plan } = await planService.start({ requirement: 'Order discounts' });

  const agent = makeAgent({ id: 'agt_p', name: 'planner-1', status: 'running', current_task: 'tsk_plan', role_id: 'planner' });
  const runStore = createMockRunStore();
  await runStore.save(makeRun({ id: 'run_p', task_id: 'tsk_plan', agent_id: 'agt_p', status: 'streaming' }));
  const entry = { run_id: 'run_p', task_id: 'tsk_plan', agent_id: 'agt_p', pid: 1, started_at: new Date().toISOString() };
  const wm = createMockWorkspaceManager();
  const deps = buildDeps({
    taskStore, runStore, workspaceManager: wm, agentStore: createMockAgentStore([agent]),
    stateStore: createMockStateStore({ running: { tsk_plan: entry as any } }),
    taskService: deps0.taskService, eventBus: deps0.eventBus,
  });
  deps.decisionService = decisions;
  deps.planService = planService;
  const orch = new Orchestrator(deps);
  orchestrators.push(orch);
  await (orch as any).loadState();
  return {
    orch, wm, plan, planService, decisions, taskStore,
    get: async () => (await taskStore.get('tsk_plan'))!,
    finish: () => (orch as any).handleRunSuccess('tsk_plan', 'run_p', 'agt_p', undefined, 'planned', []),
    fail: () => (orch as any).handleRunFailure('tsk_plan', entry, 'process exited with code 1'),
  };
}

describe('planning task runs', () => {
  it('done once the plan is submitted: nothing committed or merged, worktree removed', async () => {
    const { finish, get, wm, planService } = await setup();
    await planService.submit({ taskId: 'tsk_plan', raw: draft });

    await finish();

    expect((await get()).status).toBe('done');
    expect(wm.commitAll).not.toHaveBeenCalled();
    expect(wm.syncWorktree).not.toHaveBeenCalled();
    expect(wm.mergeBack).not.toHaveBeenCalled();
    expect(wm.cleanup).toHaveBeenCalledWith('tsk_plan', 'orchestry/tsk_plan/plan');
  });

  it('a run that ends without submitting a plan fails (and is retried with the reason)', async () => {
    const { finish, get, orch } = await setup();

    await finish();

    expect((await get()).status).toBe('retrying');
    expect((orch as any).state.retry_queue).toContainEqual(expect.objectContaining({
      task_id: 'tsk_plan', error: expect.stringMatching(/without submitting a plan.*orch plan submit/),
    }));
  });

  it('a run that crashes after submitting still counts as done', async () => {
    const { fail, get, planService } = await setup();
    await planService.submit({ taskId: 'tsk_plan', raw: draft });

    await fail();

    expect((await get()).status).toBe('done');
  });

  it('a planner that asked a question waits for the answer', async () => {
    const { finish, get, decisions } = await setup();
    await decisions.request({ task_id: 'tsk_plan', source: 'agent', question: 'Percent or fixed discounts?' });

    await finish();

    expect((await get()).status).toBe('waiting_decision');
  });
});

describe('planning prompt', () => {
  it('a planning task is dispatched with the roles it can plan with', async () => {
    const taskStore = createMockTaskStore([{
      id: 'tsk_p2', title: 'Plan: x', description: 'Order discounts', status: 'todo', priority: 3, role: 'planner',
      labels: ['planning'], depends_on: [], created_at: '', updated_at: '', attempts: 0, max_attempts: 3, plan_id: 'pln_x',
    }]);
    const adapterRegistry = new AdapterRegistry();
    const adapter = createMockAdapter([{ type: 'done', timestamp: new Date().toISOString(), data: { result: 'ok' } }]);
    adapterRegistry.register(adapter);
    const deps = buildDeps({ taskStore, adapterRegistry, agentStore: createMockAgentStore([makeAgent({ id: 'agt_n', name: 'planner-1', status: 'idle', role_id: 'planner' })]) });
    deps.planService = { promptContext: vi.fn(async () => ({ plan_id: 'pln_x', revision: 1, max_tasks: 30, roles: [{ name: 'backend', description: 'Java', agents: 2 }] })), planningRunOutcome: vi.fn(async () => 'missing') } as any;
    const orch = new Orchestrator(deps);
    orchestrators.push(orch);
    await (orch as any).loadState();
    (orch as any).lockAcquired = true;

    await (orch as any).tick();
    await waitFor(() => vi.mocked(deps.templateEngine.render).mock.calls.length > 0);

    const ctx = vi.mocked(deps.templateEngine.render).mock.calls.map(([, c]) => c as any).find((c) => c.planning);
    expect(ctx.planning).toMatchObject({ plan_id: 'pln_x', roles: [{ name: 'backend', agents: 2 }] });
  });
});
