/**
 * Decision gate in the orchestrator: agents that ask a human wait for the
 * answer, loops past their limit escalate to a human, answers reach prompts,
 * and agents get `orch` on their PATH.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Orchestrator } from '../../../src/application/orchestrator.js';
import { DecisionService } from '../../../src/application/decision-service.js';
import { DEFAULT_CONFIG } from '../../../src/domain/config.js';
import type { ReviewCriterion, Task } from '../../../src/domain/task.js';
import type { IShellRunner, ShellRunResult } from '../../../src/infrastructure/process/shell-runner.js';
import type { SyncResult } from '../../../src/infrastructure/workspace/interface.js';
import { MemoryDecisionStore } from '../../../src/infrastructure/storage/decision-store.js';
import { AdapterRegistry } from '../../../src/infrastructure/adapters/registry.js';
import {
  buildDeps,
  makeTask,
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

const WORKTREE = '/tmp/project/.orchestry/workspaces/tsk_d';
const BRANCH = 'orchestry/tsk_d/order-api';

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

interface SetupOptions {
  criteria?: ReviewCriterion[];
  review?: ShellRunResult;
  sync?: SyncResult;
  task?: Partial<Task>;
}

async function setup(opts: SetupOptions = {}) {
  const taskId = 'tsk_d';
  const task = makeTask({
    id: taskId, title: 'Order API', status: 'in_progress', attempts: 1,
    review_criteria: opts.criteria ?? [], workspace: WORKTREE, proof: { branch: BRANCH, files_changed: [] },
    ...opts.task,
  });
  const agent = makeAgent({
    id: 'agt_d', name: 'backend-1', status: 'running', current_task: taskId,
    config: { approval_policy: 'auto', max_turns: 50, timeout_ms: 3_600_000, stall_timeout_ms: 300_000 },
  });
  const taskStore = createMockTaskStore([task]);
  const runStore = createMockRunStore();
  await runStore.save(makeRun({ id: 'run_d', task_id: taskId, agent_id: 'agt_d', status: 'streaming' }));
  const entry = { run_id: 'run_d', task_id: taskId, agent_id: 'agt_d', pid: 1, started_at: new Date().toISOString() };
  const stateStore = createMockStateStore({ running: task.status === 'in_progress' ? { [taskId]: entry as any } : {} });

  const wm = createMockWorkspaceManager();
  vi.mocked(wm.targetHead).mockResolvedValue({ sha: 'main1', name: 'main' });
  vi.mocked(wm.syncWorktree).mockResolvedValue(opts.sync ?? { status: 'merged' });
  const shellRunner: IShellRunner = { run: vi.fn(async () => opts.review ?? { exitCode: 0, output: 'ok', timedOut: false }) };

  const deps = buildDeps({ taskStore, agentStore: createMockAgentStore([agent]), runStore, stateStore, workspaceManager: wm, shellRunner, config: DEFAULT_CONFIG });
  const decisions = new DecisionService(new MemoryDecisionStore(), taskStore, deps.taskService, deps.eventBus);
  deps.decisionService = decisions;
  const events: any[] = [];
  deps.eventBus.onAny((e: any) => events.push(e));
  const orch = new Orchestrator(deps);
  orchestrators.push(orch);
  await (orch as any).loadState();
  const get = async () => (await taskStore.get(taskId))!;
  return {
    orch, deps, decisions, wm, events, get, taskId,
    finish: () => (orch as any).handleRunSuccess(taskId, 'run_d', 'agt_d', undefined, 'asked a question', []),
    fail: () => (orch as any).handleRunFailure(taskId, entry, 'process exited with code 1'),
  };
}

describe('agent asks a human', () => {
  it('after its run the task waits in waiting_decision: no commit, no review, no merge', async () => {
    const { finish, get, decisions, wm, taskId } = await setup({ criteria: ['test_pass'] });
    await decisions.request({ task_id: taskId, source: 'agent', question: 'BigDecimal or long?', options: ['BigDecimal', 'long'], requested_by: 'backend-1' });

    await finish();

    expect((await get()).status).toBe('waiting_decision');
    expect(wm.commitAll).not.toHaveBeenCalled();
    expect(wm.mergeBack).not.toHaveBeenCalled();
  });

  it('a run that exits non-zero after asking is not a failure: attempt refunded, worktree kept', async () => {
    const { fail, get, decisions, wm, taskId } = await setup();
    await decisions.request({ task_id: taskId, source: 'agent', question: 'Which table?' });

    await fail();

    expect(await get()).toMatchObject({ status: 'waiting_decision', attempts: 0 });
    expect(wm.cleanup).not.toHaveBeenCalled();
  });

  it('once answered, the task is queued again with the answer as feedback', async () => {
    const { finish, get, decisions, taskId } = await setup();
    const d = await decisions.request({ task_id: taskId, source: 'agent', question: 'BigDecimal or long?', options: ['BigDecimal', 'long'] });
    await finish();

    await decisions.answer(d.id, { choice: 'BigDecimal' });

    const task = await get();
    expect(task.status).toBe('todo');
    expect(task.feedback).toContain('Answer: BigDecimal');
  });
});

describe('loop limit → escalated to a human', () => {
  it('a conflict past max_send_backs opens a decision carrying the agent instructions', async () => {
    const { finish, get, decisions, events, taskId } = await setup({
      task: { send_backs: 3 },
      sync: { status: 'conflict', files: ['Order.java'], output: 'CONFLICT' },
    });

    await finish();

    expect((await get()).status).toBe('waiting_decision');
    const [d] = await decisions.pendingFor(taskId);
    expect(d).toMatchObject({ source: 'escalation', requested_by: 'orch' });
    expect(d!.question).toMatch(/still conflicts with main after 3 send-back/);
    expect(d!.context).toContain('Order.java');
    expect(events).toContainEqual(expect.objectContaining({ type: 'decision:requested', source: 'escalation', taskId }));

    // "continue" resumes the agent with the human's instructions and the conflict instructions.
    await decisions.answer(d!.id, { message: 'Keep BigDecimal from main; drop the long field' });
    const task = await get();
    expect(task).toMatchObject({ status: 'todo', send_backs: 0 });
    expect(task.feedback).toContain('Keep BigDecimal from main');
    expect(task.feedback).toContain('merge is still in progress');
    expect(task.proof?.conflict_files).toEqual(['Order.java']);
  });

  it('a failing review past the limit, answered with approve, is merged by the orchestrator (human override)', async () => {
    const { orch, finish, get, decisions, wm, taskId } = await setup({
      criteria: ['test_pass'],
      review: { exitCode: 1, output: 'flaky IT failed', timedOut: false },
      task: { send_backs: 3 },
    });
    await finish();
    const [d] = await decisions.pendingFor(taskId);
    expect(d!.question).toMatch(/Review keeps failing/);

    await decisions.answer(d!.id, { action: 'approve', message: 'flaky integration test, merge it' });
    expect(await get()).toMatchObject({ status: 'review', approved: true });

    (orch as any).lockAcquired = true;
    await (orch as any).tick();
    await waitFor(async () => (await get()).status === 'done');
    expect(wm.mergeBack).toHaveBeenCalledWith(BRANCH);
  });
});

describe('dispatch', () => {
  it('puts binding decisions in the prompt and the orch launcher first on the agent PATH', async () => {
    const task = makeTask({ id: 'tsk_n', status: 'todo' });
    const taskStore = createMockTaskStore([task]);
    const agentStore = createMockAgentStore([makeAgent({ id: 'agt_n', name: 'backend-1', status: 'idle' })]);
    const adapterRegistry = new AdapterRegistry();
    const adapter = createMockAdapter([{ type: 'done', timestamp: new Date().toISOString(), data: { result: 'ok' } }]);
    adapterRegistry.register(adapter);
    const deps = buildDeps({ taskStore, agentStore, adapterRegistry, prepareAgentBin: async () => '/agent-bin' });
    const decisions = new DecisionService(new MemoryDecisionStore(), taskStore, deps.taskService, deps.eventBus);
    deps.decisionService = decisions;
    const rule = await decisions.request({ source: 'gate', question: 'Money type?' });
    await decisions.answer(rule.id, { message: 'BigDecimal', scope: 'project' });
    const orch = new Orchestrator(deps);
    orchestrators.push(orch);
    await (orch as any).loadState();
    (orch as any).lockAcquired = true;

    await (orch as any).tick();
    await waitFor(() => vi.mocked(adapter.execute).mock.calls.length > 0);

    const renderContexts = vi.mocked(deps.templateEngine.render).mock.calls.map(([, ctx]) => ctx as any);
    expect(renderContexts.some((c) => c.decisions?.[0]?.question === 'Money type?' && c.decisions[0].answer === 'BigDecimal' && c.decisions[0].project_wide)).toBe(true);
    const env = vi.mocked(adapter.execute).mock.calls[0]![0].env!;
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')!;
    expect(env[pathKey]!.startsWith('/agent-bin')).toBe(true);
    expect(env.ORCH_TASK_ID).toBe('tsk_n');
  });

  it('a task waiting for a decision keeps its scope locked', async () => {
    const waiting = makeTask({ id: 'tsk_w', status: 'waiting_decision', scope: ['src/order/**'] });
    const overlapping = makeTask({ id: 'tsk_o', status: 'todo', scope: ['src/order/Order.java'] });
    const deps = buildDeps({ taskStore: createMockTaskStore([waiting, overlapping]) });
    const orch = new Orchestrator(deps);
    orchestrators.push(orch);
    await (orch as any).loadState();
    const dispatched: string[] = [];
    vi.spyOn(orch as any, 'dispatchTask').mockImplementation(async (id: unknown) => { dispatched.push(id as string); });

    await (orch as any).dispatchAll();

    expect(dispatched).toEqual([]);
  });
});
