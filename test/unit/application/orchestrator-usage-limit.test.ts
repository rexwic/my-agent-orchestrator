/**
 * Orchestrator behaviour when an agent's account hits its usage limit.
 */
import { describe, it, expect, vi } from 'vitest';
import { Orchestrator } from '../../../src/application/orchestrator.js';
import { AdapterErrorKind } from '../../../src/domain/errors.js';
import { MemoryQuotaStore } from '../../../src/infrastructure/storage/quota-store.js';
import type { AgentEvent } from '../../../src/infrastructure/adapters/interface.js';
import type { Task } from '../../../src/domain/task.js';
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
} from './helpers.js';

const RESET = '2026-11-18T15:00:00.000Z';

async function setup(opts: { tasks?: Task[]; extraAgents?: ReturnType<typeof makeAgent>[] } = {}) {
  const taskId = 'tsk_ul';
  const agentId = 'agt_be';
  const runId = 'run_ul';

  const task = makeTask({
    id: taskId,
    status: 'in_progress',
    attempts: 1,
    max_attempts: 1, // a normal failure would be terminal
    assignee: agentId,
    workspace: '/tmp/project/.orchestry/workspaces/tsk_ul',
    proof: { branch: 'orchestry/tsk_ul/x', files_changed: [] },
  });
  const dependent = makeTask({ id: 'tsk_dep', status: 'todo', depends_on: [taskId] });
  const agent = makeAgent({ id: agentId, name: 'be', adapter: 'claude', status: 'running', current_task: taskId });

  const taskStore = createMockTaskStore([task, dependent, ...(opts.tasks ?? [])]);
  const agentStore = createMockAgentStore([agent, ...(opts.extraAgents ?? [])]);
  const runStore = createMockRunStore();
  await runStore.save(makeRun({ id: runId, task_id: taskId, agent_id: agentId, status: 'streaming' }));
  const entry = { run_id: runId, task_id: taskId, agent_id: agentId, pid: 4242, started_at: new Date().toISOString(), last_event_at: new Date().toISOString() };
  const stateStore = createMockStateStore({ running: { [taskId]: entry } as any });
  const workspaceManager = createMockWorkspaceManager();
  const quotaStore = new MemoryQuotaStore();

  const deps = buildDeps({ taskStore, agentStore, runStore, stateStore, workspaceManager, quotaStore });
  const events: any[] = [];
  deps.eventBus.onAny((e: any) => events.push(e));
  const orch = new Orchestrator(deps);
  await (orch as any).loadState();

  return { orch, deps, taskStore, agentStore, workspaceManager, quotaStore, events, taskId, agentId, runId, entry };
}

async function* stream(...events: AgentEvent[]): AsyncGenerator<AgentEvent> {
  for (const e of events) yield e;
}

const ts = () => new Date().toISOString();

describe('Orchestrator — usage limits', () => {
  it('pauses the account, refunds the attempt and requeues the task with its worktree', async () => {
    const { orch, taskStore, workspaceManager, quotaStore, events, taskId, entry } = await setup();

    await (orch as any).handleRunFailure(taskId, entry, "Claude five_hour usage limit reached", AdapterErrorKind.RATE_LIMIT, RESET);

    const task = await taskStore.get(taskId);
    expect(task!.status).toBe('retrying');
    expect(task!.attempts).toBe(0);
    expect(workspaceManager.cleanup).not.toHaveBeenCalled();
    expect((await taskStore.get('tsk_dep'))!.status).toBe('todo'); // no cascade failure
    const pause = (await quotaStore.read())['claude:subscription'];
    expect(pause).toMatchObject({ reset_known: true, agent_id: 'agt_be' });
    expect(Date.parse(pause!.until)).toBeGreaterThan(Date.parse(RESET));
    expect(events).toContainEqual(expect.objectContaining({ type: 'quota:paused', group: 'claude:subscription', taskId }));
    expect(events.some((e) => e.type === 'run:retry')).toBe(false);
  });

  it('records the pause on the agent for the UI', async () => {
    const { orch, agentStore, taskId, agentId, entry } = await setup();

    await (orch as any).handleRunFailure(taskId, entry, 'limit', AdapterErrorKind.RATE_LIMIT, RESET);

    const agent = await agentStore.get(agentId);
    expect(agent!.status).toBe('idle');
    expect(agent!.current_task).toBeUndefined();
    expect(agent!.last_error).toMatchObject({ kind: AdapterErrorKind.RATE_LIMIT });
    expect(agent!.last_error!.message).toContain('paused until');
  });

  it('a non-limit failure still follows the normal retry/fail path', async () => {
    const { orch, taskStore, quotaStore, taskId, entry } = await setup();

    await (orch as any).handleRunFailure(taskId, entry, 'segfault', AdapterErrorKind.PROCESS_CRASH);

    expect((await taskStore.get(taskId))!.status).toBe('failed');
    expect(await quotaStore.read()).toEqual({});
  });

  it('a fatal error event fails the run even when the process exits 0 (Claude is_error)', async () => {
    const { orch, taskStore, taskId, agentId, runId } = await setup();

    await (orch as any).collectEvents(
      stream(
        { type: 'output', timestamp: ts(), data: { text: 'working' } },
        { type: 'error', timestamp: ts(), data: { message: 'Claude stopped: reached max turns (error_max_turns)' }, fatal: true, errorKind: AdapterErrorKind.UNKNOWN },
      ),
      runId, taskId, agentId,
    );

    const task = await taskStore.get(taskId);
    expect(task!.status).toBe('failed'); // max_attempts 1, not success/review
  });

  it('a fatal RATE_LIMIT event pauses with the reset time from the event', async () => {
    const { orch, taskStore, quotaStore, taskId, agentId, runId } = await setup();

    await (orch as any).collectEvents(
      stream({ type: 'error', timestamp: ts(), data: { message: 'usage limit' }, fatal: true, errorKind: AdapterErrorKind.RATE_LIMIT, resetAt: RESET }),
      runId, taskId, agentId,
    );

    expect((await taskStore.get(taskId))!.status).toBe('retrying');
    expect((await quotaStore.read())['claude:subscription']?.reset_known).toBe(true);
  });

  it('a limit reported only via stderr (thrown exit error) is still recognised', async () => {
    const { orch, quotaStore, taskId, agentId, runId } = await setup();
    async function* failing(): AsyncGenerator<AgentEvent> {
      throw Object.assign(new Error('Codex process exited with code 1\n--- stderr ---\nusage limit, try again in 2 hours'), {
        errorKind: AdapterErrorKind.RATE_LIMIT,
        resetAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
      });
    }

    await (orch as any).collectEvents(failing(), runId, taskId, agentId);

    expect((await quotaStore.read())['claude:subscription']?.reset_known).toBe(true);
  });

  it('skips paused agents when dispatching and does not let their tasks take the free slots', async () => {
    const other = makeAgent({ id: 'agt_fe', name: 'fe', adapter: 'codex' });
    const blocked = makeTask({ id: 'tsk_paused', status: 'todo', priority: 1, assignee: 'agt_be' });
    const free = makeTask({ id: 'tsk_free', status: 'todo', priority: 4, assignee: 'agt_fe' });
    const { orch, deps, quotaStore } = await setup({ tasks: [blocked, free], extraAgents: [other] });
    await quotaStore.write({
      'claude:subscription': { until: new Date(Date.now() + 3_600_000).toISOString(), since: ts(), reason: 'limit', strikes: 0, reset_known: true },
    });
    (deps.config.scheduling as { max_concurrent_agents: number }).max_concurrent_agents = 2; // one slot left (tsk_ul is running)
    const dispatched: string[] = [];
    vi.spyOn(orch as any, 'dispatchTask').mockImplementation(async (id: unknown) => { dispatched.push(id as string); });

    await (orch as any).dispatchAll();

    expect(dispatched).toEqual(['tsk_free']);
  });

  it('a successful run clears the account\'s limit history', async () => {
    const { orch, quotaStore, taskId, agentId, runId } = await setup();
    await quotaStore.write({
      'claude:subscription': { until: new Date(Date.now() - 1_000).toISOString(), since: ts(), reason: 'limit', strikes: 2, reset_known: false, resumed: true },
    });

    await (orch as any)._handleRunSuccess(taskId, runId, agentId, undefined, 'done', []);

    expect(await quotaStore.read()).toEqual({});
  });
});
