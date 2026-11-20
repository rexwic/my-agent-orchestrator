/**
 * Orchestrator — the core state machine.
 *
 * Tick loop: Reconcile → Dispatch → Collect
 *
 * Reconcile: check PID liveness, detect stalls, process retry queue
 * Dispatch: claim tasks, assign to agents, launch adapters
 * Collect: process completed runs, update stats
 */

import type { OrchestratorConfig } from '../domain/config.js';
import type { OrchestratorState, RunningEntry } from '../domain/state.js';
import type { Task, TaskStatus } from '../domain/task.js';
import { AUTONOMOUS_LABEL } from '../domain/task.js';
import { type RunEvent, createTokenUsage } from '../domain/run.js';
import {
  isDispatchable,
  isBlocked,
  findDependencyCycles,
  isTerminal,
  resolveCompletionStatus,
  resolveFailureStatus,
  calculateRetryDelay,
} from '../domain/transitions.js';
import { NoAgentsError, TaskAlreadyRunningError, LockConflictError, WorkspaceError, InvalidTransitionError, classifyAdapterError, extractErrorMessage, AdapterErrorKind } from '../domain/errors.js';
import { scopesOverlap, ScopeIndex } from '../domain/scope.js';
import { acquireLock, releaseLock, touchLock } from '../infrastructure/storage/lock.js';
import type { ITaskStore, IAgentStore, IRunStore, IStateStore, IContextStore, IGoalStore } from '../infrastructure/storage/interfaces.js';
import { CachedTaskStore, CachedAgentStore, CachedGoalStore } from '../infrastructure/storage/cached-stores.js';
import type { AdapterRegistry } from '../infrastructure/adapters/registry.js';
import type { IWorkspaceManager } from '../infrastructure/workspace/interface.js';
import type { ITemplateEngine } from '../infrastructure/template/template-engine.js';
import { buildPromptContext, DEFAULT_SYSTEM_TEMPLATE, DEFAULT_USER_TEMPLATE, type RetryContext, type GoalContext } from '../infrastructure/template/template-engine.js';
import type { IProcessManager } from '../infrastructure/process/process-manager.js';
import type { AgentEvent } from '../infrastructure/adapters/interface.js';
import type { ISkillLoader } from '../infrastructure/skills/skill-loader.js';
import type { EventBus } from './event-bus.js';
import type { TaskService } from './task-service.js';
import type { AgentService } from './agent-service.js';
import type { RunService } from './run-service.js';
import { ReviewGate } from './review-gate.js';
import { IntegrationService, type IntegrationOutcome } from './integration-service.js';
import { QuotaService } from './quota-service.js';
import { Semaphore } from './semaphore.js';
import type { RoleService } from './role-service.js';
import type { DecisionService } from './decision-service.js';
import { describeAnswer, MAX_CONTEXT_LENGTH } from '../domain/decision.js';
import type { DeliverableService } from './deliverable-service.js';
import { readContractFiles } from '../infrastructure/workspace/contract-files.js';
import { prependPath } from '../infrastructure/process/cli-shim.js';
import { MemoryQuotaStore } from '../infrastructure/storage/quota-store.js';
import type { IQuotaStore } from '../infrastructure/storage/interfaces.js';
import type { QuotaState } from '../domain/quota.js';
import { ShellRunner, type IShellRunner } from '../infrastructure/process/shell-runner.js';

/** Max serialized event data written to JSONL (8 KB) */
const MAX_EVENT_DATA_LEN = 8192;
/** Max event data sent to TUI via event bus (4 KB) */
const MAX_BUS_DATA_LEN = 4096;

export interface OrchestratorDeps {
  taskStore: ITaskStore;
  agentStore: IAgentStore;
  runStore: IRunStore;
  stateStore: IStateStore;
  adapterRegistry: AdapterRegistry;
  workspaceManager: IWorkspaceManager;
  templateEngine: ITemplateEngine;
  processManager: IProcessManager;
  eventBus: EventBus;
  taskService: TaskService;
  agentService: AgentService;
  runService: RunService;
  contextStore?: IContextStore;
  messageService?: import('./message-service.js').MessageService;
  goalStore?: IGoalStore;
  skillLoader?: ISkillLoader;
  /** Runs review_criteria commands. Defaults to a ShellRunner on processManager. */
  shellRunner?: IShellRunner;
  /** Usage-limit pauses (.orchestry/quota.json). Defaults to in-memory. */
  quotaStore?: IQuotaStore;
  /** Roles → agent instances; synced at the start of every tick. */
  roleService?: RoleService;
  /** Human decisions: escalations, agent questions, binding answers in prompts. */
  decisionService?: DecisionService;
  /** Plans: planner prompts, and how a planning task's run ends. */
  planService?: import('./plan-service.js').PlanService;
  /** Delivery reports: required at the end of a run, shown to dependent tasks. */
  deliverableService?: DeliverableService;
  /** PRDs: drafting tasks, the PRD in prompts, planning a drafted PRD. */
  prdService?: import('./prd-service.js').PrdService;
  /** PM answering agents' questions: the PM's task prompt and how it ends. */
  pmService?: import('./pm-service.js').PmService;
  /** Review by a reviewer role before merging: the gate, the reviewer's prompt, how a review task ends. */
  reviewService?: import('./review-service.js').ReviewService;
  /** Bugs: hand-offs between owners, re-verification tasks, the verifier's prompt. */
  bugService?: import('./bug-service.js').BugService;
  /** Prepares a directory with an `orch` launcher to put first on agents' PATH. */
  prepareAgentBin?: () => Promise<string | undefined>;
  config: OrchestratorConfig;
  projectRoot: string;
  lockPath: string;
}

/** Result of `approveTask`: `queued` means an orchestrator integrates it in the background. */
export type ApproveTaskOutcome = IntegrationOutcome | { status: 'queued' };

/** A run time limit for messages: "45s", "10 min". */
function describeLimit(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)} min`;
}

/** Work left for after the state lock is released when a run succeeds. */
type PendingCompletion =
  | { kind: 'integrate'; autoApprove: boolean }
  | { kind: 'review'; criteria: import('../domain/task.js').ReviewCriterion[]; cwd: string };

export class Orchestrator {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;
  private state: OrchestratorState | null = null;
  private abortControllers = new Map<string, AbortController>();
  private readonly cachedTaskStore: CachedTaskStore;
  private readonly cachedAgentStore: CachedAgentStore;
  private readonly cachedGoalStore: CachedGoalStore | null;
  private saveStateTimer: ReturnType<typeof setTimeout> | null = null;
  private saveStateDirty = false;
  private lockAcquired = false;
  private consecutiveTickFailures = 0;
  private readonly maxConsecutiveTickFailures = 5;
  private readonly maxRetryQueueSize = 100;
  private signalHandlers: Array<[NodeJS.Signals, () => void]> = [];
  private immediateDispatchTimer: ReturnType<typeof setTimeout> | null = null;
  private taskCreatedUnsub: (() => void) | null = null;
  private tickInProgress = false;
  private stoppedResolvers: Array<() => void> = [];

  /**
   * Track taskIds with an active collectEvents() background promise.
   * Reconcile skips PID-liveness and stall checks for these tasks because
   * the process may have exited cleanly but handleRunSuccess hasn't acquired
   * the mutex yet — false-positive "crash" / "stall" detection.
   */
  private readonly activeCollectors = new Set<string>();

  /** When true, `tick()` skips `seedAutonomousTasks()`. Set via `startWatch()` options. */
  private skipAutonomousSeeding = false;
  /** Task IDs started via runTask; these must not trigger reactive dispatch of other tasks. */
  private readonly singleTaskRunIds = new Set<string>();
  /** Cooldown: track last auto-seed time per agent to prevent re-seed spam. */
  private readonly lastAutoSeedAt = new Map<string, number>();
  /** Minimum interval between auto-seed tasks for the same agent (30 seconds). */
  private static readonly AUTO_SEED_COOLDOWN_MS = 30_000;

  /** Promise-chain mutex to serialize critical state mutations. */
  private stateMutex: Promise<void> = Promise.resolve();

  private readonly reviewGate: ReviewGate;
  private readonly shellRunner: IShellRunner;
  private readonly quota: QuotaService;
  /** Limits concurrent review_criteria runs (review.max_parallel). */
  private readonly reviewSlots: Semaphore;
  /** Worktree tasks: sync main → review → merge queue, and send-backs. */
  private readonly integration: IntegrationService;
  /** Background integrations started by the tick (approved tasks). */
  private readonly integrations = new Set<Promise<unknown>>();
  /** Problems already reported (invalid role files, dependency cycles) — report each once. */
  private readonly reportedProblems = new Set<string>();

  constructor(private readonly deps: OrchestratorDeps) {
    this.reviewGate = new ReviewGate({
      taskStore: deps.taskStore,
      taskService: deps.taskService,
      workspaceManager: deps.workspaceManager,
      eventBus: deps.eventBus,
    });
    this.shellRunner = deps.shellRunner ?? new ShellRunner(deps.processManager);
    this.quota = new QuotaService(deps.quotaStore ?? new MemoryQuotaStore(), deps.eventBus);
    this.reviewSlots = new Semaphore(Math.max(1, Math.floor(deps.config.review?.max_parallel ?? 1)));
    this.integration = new IntegrationService({
      taskStore: deps.taskStore,
      taskService: deps.taskService,
      workspaceManager: deps.workspaceManager,
      eventBus: deps.eventBus,
      reviewGate: this.reviewGate,
      shellRunner: this.shellRunner,
      config: deps.config,
      reviewSlots: this.reviewSlots,
      withLock: (fn) => this.withStateLock(fn),
      isStopping: () => this.shuttingDown,
      ...(deps.decisionService ? { decisions: deps.decisionService } : {}),
      ...(deps.reviewService ? { agentReview: deps.reviewService } : {}),
    });
    this.cachedTaskStore = new CachedTaskStore(deps.taskStore);
    this.cachedAgentStore = new CachedAgentStore(deps.agentStore);
    this.cachedGoalStore = deps.goalStore ? new CachedGoalStore(deps.goalStore) : null;
  }

  /**
   * Check if this instance owns the lock (can mutate state).
   */
  get isOwner(): boolean {
    return this.lockAcquired;
  }

  /**
   * Serialize access to state mutations via a Promise-chain mutex.
   * Prevents concurrent tick/stop/reconcile from reading stale state.
   */
  private withStateLock<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const prev = this.stateMutex;
    this.stateMutex = next;
    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        release!();
      }
    });
  }

  /**
   * Run a single task by ID.
   * If watch mode is active (lock already held), dispatches inline via stateMutex.
   * Otherwise acquires a temporary lock for the duration of the run.
   */
  async runTask(taskId: string): Promise<void> {
    if (this.lockAcquired) {
      await this.freshDispatch(() => this.dispatchOnlyTask(taskId));
      return;
    }
    await this.withTemporaryLock(() => this.freshDispatch(() => this.dispatchOnlyTask(taskId)));
  }

  /**
   * Run all dispatchable tasks.
   * If watch mode is active (lock already held), dispatches inline via stateMutex.
   * Otherwise acquires a temporary lock for the duration of the run.
   */
  async runAll(): Promise<void> {
    if (this.lockAcquired) {
      await this.freshDispatch(() => this.dispatchAll());
      return;
    }
    await this.withTemporaryLock(() => this.freshDispatch(() => this.dispatchAll()));
  }

  /**
   * Invalidate caches → loadState → run dispatch fn → saveState.
   * Shared by runTask, runAll, and immediateDispatch.
   */
  private async freshDispatch(fn: () => Promise<void>): Promise<void> {
    await this.withStateLock(async () => {
      this.cachedTaskStore.invalidate();
      this.cachedAgentStore.invalidate();
      await this.loadState();
      await fn();
      await this.saveState();
    });
  }

  /**
   * Acquire lock, run fn, then release lock.
   * Used by single-shot commands (runTask, runAll) that don't go through startWatch.
   */
  private async withTemporaryLock(fn: () => Promise<void>): Promise<void> {
    const lockResult = await acquireLock(this.deps.lockPath);
    if (!lockResult.acquired) {
      throw new LockConflictError(lockResult.pid!);
    }
    this.lockAcquired = true;
    try {
      await fn();
    } finally {
      this.lockAcquired = false;
      await releaseLock(this.deps.lockPath);
    }
  }

  /**
   * Start watch mode — continuous tick loop.
   * Acquires a PID lock to prevent multiple orchestrators.
   */
  async startWatch(opts?: { skipAutonomousSeeding?: boolean }): Promise<void> {
    this.skipAutonomousSeeding = opts?.skipAutonomousSeeding ?? false;

    // Acquire lock — only one orchestrator per project
    const lockResult = await acquireLock(this.deps.lockPath);
    if (!lockResult.acquired) {
      throw new LockConflictError(lockResult.pid!);
    }
    this.lockAcquired = true;

    await this.loadState();

    // Clean up stale running entries from a previous process (crash/restart).
    // Tasks that were in_progress are NOT retried — they go to 'cancelled' so
    // agents don't redo already-committed work after a restart.
    await this.cleanupStaleRunningEntries();
    await this.discardCancelledWork();

    this.state!.pid = process.pid;
    this.state!.started_at = new Date().toISOString();
    await this.saveState();

    // Register signal handlers for graceful shutdown
    this.registerSignalHandlers();

    // Subscribe to task:created for reactive dispatch
    this.taskCreatedUnsub = this.deps.eventBus.on('task:created', () => {
      this.scheduleImmediateDispatch();
    });

    // Initial tick
    await this.tick();

    // Start polling
    this.intervalId = setInterval(
      () => this.tick().then(
        () => { this.consecutiveTickFailures = 0; },
        (err) => {
          this.consecutiveTickFailures++;
          const error = err instanceof Error ? err.message : String(err);
          this.deps.eventBus.emit({
            type: 'orchestrator:error',
            error,
            context: 'tick',
            fatal: this.consecutiveTickFailures >= this.maxConsecutiveTickFailures,
          });
          if (this.consecutiveTickFailures >= this.maxConsecutiveTickFailures) {
            this.deps.eventBus.emit({
              type: 'orchestrator:shutdown',
              reason: `${this.consecutiveTickFailures} consecutive tick failures`,
            });
            this.stop().catch((err) => {
              this.deps.eventBus.emit({ type: 'orchestrator:error', error: err instanceof Error ? err.message : String(err), context: 'stop after consecutive tick failures', fatal: false });
            });
          }
        },
      ),
      this.deps.config.scheduling.poll_interval_ms,
    );
  }

  /**
   * Returns a promise that resolves when stop() completes.
   * Use in long-running modes (serve, run --watch) to keep the process alive.
   */
  waitForStop(): Promise<void> {
    if (this.shuttingDown) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.stoppedResolvers.push(resolve);
    });
  }

  /**
   * Register SIGINT/SIGTERM handlers for graceful shutdown.
   */
  private registerSignalHandlers(): void {
    const handler = (signal: string) => {
      this.deps.eventBus.emit({
        type: 'orchestrator:shutdown',
        reason: `Received ${signal}`,
      });
      this.stop().catch((err) => {
        this.deps.eventBus.emit({ type: 'orchestrator:error', error: err instanceof Error ? err.message : String(err), context: `stop after ${signal} signal`, fatal: false });
      });
    };

    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      const bound = () => handler(sig);
      this.signalHandlers.push([sig, bound]);
      process.on(sig, bound);
    }
  }

  /**
   * Remove signal handlers to avoid listener leaks.
   */
  private removeSignalHandlers(): void {
    for (const [sig, handler] of this.signalHandlers) {
      process.removeListener(sig, handler);
    }
    this.signalHandlers = [];
  }

  /**
   * Stop the watch loop and clean up.
   */
  async stop(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    // Stop polling
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    // Unsubscribe from task:created and clear debounce timer
    if (this.taskCreatedUnsub) {
      this.taskCreatedUnsub();
      this.taskCreatedUnsub = null;
    }
    if (this.immediateDispatchTimer) {
      clearTimeout(this.immediateDispatchTimer);
      this.immediateDispatchTimer = null;
    }

    // Flush any pending debounced writes before shutdown
    await this.flushStateLazy();

    // Graceful shutdown of running agents — serialized via mutex
    await this.withStateLock(async () => {
      if (this.state) {
        for (const [taskId, entry] of Object.entries(this.state.running)) {
          this.abortControllers.get(taskId)?.abort();
          this.abortControllers.delete(taskId);
          await this.deps.processManager.killWithGrace(entry.pid);

          // Mark run as cancelled
          await this.deps.runService.finish(entry.run_id, 'cancelled');

          // Mark task for retry if possible
          const task = await this.deps.taskStore.get(taskId);
          if (task) {
            await this.deps.taskService.updateStatus(taskId, resolveFailureStatus(task));
          }

          // Release agent
          await this.deps.agentService.setStatus(entry.agent_id, 'idle');
        }

        this.state.running = {};
        this.state.claimed = new Set<string>();
        this.state.pid = undefined;
        this.state.started_at = undefined;
        await this.saveState();
      }
    });

    // Release lock
    if (this.lockAcquired) {
      await releaseLock(this.deps.lockPath);
      this.lockAcquired = false;
    }

    // Remove signal handlers
    this.removeSignalHandlers();

    // Resolve all stopped promises so waitForStop() callers unblock
    for (const resolve of this.stoppedResolvers) resolve();
    this.stoppedResolvers = [];
  }

  /**
   * Cancel a running task: kill agent process, clean state, mark cancelled.
   * Acquires lock if not already owned (standalone CLI invocation).
   */
  async cancelTask(taskId: string): Promise<void> {
    if (!this.lockAcquired) {
      return this.withTemporaryLock(() => this.cancelTask(taskId));
    }

    await this.withStateLock(async () => {
      await this.loadState();
      const state = this.state!;
      const entry = state.running[taskId];

      if (entry) {
        this.abortControllers.get(taskId)?.abort();
        this.abortControllers.delete(taskId);
        await this.deps.processManager.killWithGrace(entry.pid, 3_000).catch((err) => {
          this.deps.eventBus.emit({ type: 'orchestrator:error', error: err instanceof Error ? err.message : String(err), context: `cancelTask kill process ${entry.pid} for task ${taskId}`, fatal: false });
        });
        await this.deps.runService.finish(entry.run_id, 'cancelled').catch((err) => {
          this.deps.eventBus.emit({ type: 'orchestrator:error', error: err instanceof Error ? err.message : String(err), context: `cancelTask finish run ${entry.run_id}`, fatal: false });
        });
        await this.deps.agentService.setStatus(entry.agent_id, 'idle').catch((err) => {
          this.deps.eventBus.emit({ type: 'orchestrator:error', error: err instanceof Error ? err.message : String(err), context: `cancelTask setStatus idle for agent ${entry.agent_id}`, fatal: false });
        });

        delete state.running[taskId];
        await this.saveState();
      }

      state.retry_queue = state.retry_queue.filter((r) => r.task_id !== taskId);

      try {
        await this.deps.taskService.cancel(taskId);
      } catch {
        try {
          await this.deps.taskService.updateStatus(taskId, 'cancelled');
        } catch {
          // Already terminal — ignore
        }
      }

      await this.saveState();
    });
    await this.discardCancelledWork(taskId);
  }

  /**
   * Remove the worktrees and branches of tasks a human cancelled (all of them,
   * or one). Runs at start, after every reconcile and right after a cancel;
   * a task whose agent still runs is left for a later pass.
   */
  async discardCancelledWork(taskId?: string): Promise<void> {
    const tasks = taskId
      ? [await this.deps.taskStore.get(taskId).catch(() => null)].filter((t): t is Task => t !== null)
      : await this.cachedTaskStore.list().catch(() => [] as Task[]);
    for (const task of tasks) {
      if (task.status !== 'cancelled' || !task.discard_work || !task.workspace || this.state?.running[task.id]) continue;
      try {
        await this.deps.workspaceManager.cleanup(task.id, task.proof?.branch);
      } catch (err) {
        this.reportOnce(`discard-${task.id}`, {
          error: err instanceof Error ? err.message : String(err),
          context: `removing the worktree of cancelled task ${task.id}`,
        });
        continue;
      }
      const fresh = await this.deps.taskStore.get(task.id);
      if (fresh?.status === 'cancelled') {
        delete fresh.workspace;
        await this.deps.taskStore.save(fresh);
      }
    }
  }

  /**
   * Force-stop a specific agent: kill process, clean state, release agent.
   * Acquires lock if not already owned (standalone CLI invocation).
   */
  async forceStopAgent(agentId: string): Promise<void> {
    if (!this.lockAcquired) {
      return this.withTemporaryLock(() => this.forceStopAgent(agentId));
    }

    await this.withStateLock(async () => {
      await this.loadState();
      const state = this.state!;

      for (const [taskId, entry] of Object.entries(state.running)) {
        if (entry.agent_id === agentId) {
          this.abortControllers.get(taskId)?.abort();
          this.abortControllers.delete(taskId);
          await this.deps.processManager.killWithGrace(entry.pid, 3_000);
          await this.deps.runService.finish(entry.run_id, 'cancelled');

          try {
            await this.deps.taskService.updateStatus(taskId, 'failed');
          } catch {
            // Transition may not be valid — ignore
          }

          delete state.running[taskId];
        }
      }

      await this.deps.agentService.setStatus(agentId, 'idle');
      await this.saveState();
    });
  }

  /**
   * Single tick: Reconcile → Dispatch → Collect
   * Serialized via mutex to prevent concurrent ticks from racing on state.
   */
  private async tick(): Promise<void> {
    if (this.shuttingDown) return;

    this.tickInProgress = true;
    let approved: string[] = [];
    try {
      await this.withStateLock(async () => {
        if (this.shuttingDown) return;

        this.cachedTaskStore.invalidate();
        this.cachedAgentStore.invalidate();
        this.cachedGoalStore?.invalidate();

        await this.loadState();
        await this.syncRoles();
        await this.reconcile();
        await this.discardCancelledWork();
        if (!this.skipAutonomousSeeding) {
          await this.seedAutonomousTasks();
        }
        await this.dispatchAll();

        const tasks = await this.cachedTaskStore.list();
        const running = Object.keys(this.state!.running).length;
        const queued = tasks.filter((t) => isDispatchable(t.status)).length;
        // Approved worktree tasks waiting to merge (approved from the CLI, or left over from a restart).
        approved = tasks
          .filter((t) => t.status === 'review' && t.approved && t.proof?.branch && !this.integration.isBusy(t.id))
          .map((t) => t.id);

        this.deps.eventBus.emit({
          type: 'orchestrator:tick',
          running,
          queued,
        });
      });
      // Touch lock file to prove we're alive (prevents stale-lock false positives from PID recycling)
      await touchLock(this.deps.lockPath);
    } finally {
      this.tickInProgress = false;
    }
    for (const id of approved) this.startIntegration(id);
  }

  /** Integrate an approved task in the background (outside the state lock). */
  private startIntegration(taskId: string): void {
    if (this.shuttingDown || this.integration.isBusy(taskId)) return;
    const job: Promise<void> = this.integration.process(taskId, { trigger: 'approved' })
      .then((outcome) => {
        if (outcome.status === 'done' || outcome.status === 'sent_back') this.scheduleImmediateDispatch();
      })
      .catch((err: unknown) => {
        this.deps.eventBus.emit({
          type: 'orchestrator:error',
          error: err instanceof Error ? err.message : String(err),
          context: `integrate approved task ${taskId}`,
          fatal: false,
        });
      })
      .finally(() => { this.integrations.delete(job); });
    this.integrations.add(job);
  }

  /**
   * Approve a task in review (CLI `task approve`, TUI).
   *
   * Without a worktree it is marked done right away. A worktree task is marked
   * approved and integrated in order — merge main in, re-review if main moved,
   * merge back: in the background when this process runs the orchestrator, by
   * the orchestrator of another process if one is running (`queued`), or
   * here and now otherwise.
   */
  async approveTask(taskId: string): Promise<ApproveTaskOutcome> {
    const task = await this.deps.taskService.get(taskId);
    if (task.status !== 'review') {
      throw new InvalidTransitionError(taskId, task.status, 'done');
    }

    if (!task.proof?.branch || !task.workspace) {
      const result = await this.reviewGate.approve(taskId);
      return result.ok ? { status: 'done' } : { status: 'review', detail: result.detail };
    }

    task.approved = true;
    task.updated_at = new Date().toISOString();
    await this.deps.taskStore.save(task);
    this.deps.eventBus.emit({ type: 'task:approved', taskId });

    if (this.lockAcquired) {
      this.startIntegration(taskId);
      return { status: 'queued' };
    }

    const lock = await acquireLock(this.deps.lockPath);
    if (!lock.acquired) return { status: 'queued' }; // the running orchestrator picks it up
    this.lockAcquired = true;
    try {
      return await this.integration.process(taskId, { trigger: 'approved' });
    } finally {
      this.lockAcquired = false;
      await releaseLock(this.deps.lockPath);
    }
  }

  /**
   * Schedule an immediate dispatch with 500ms debounce.
   * Called on task:created to avoid waiting for the next 30s tick.
   * Retries up to 10 times (5s) if a tick is in progress.
   */
  private scheduleImmediateDispatch(retries = 0): void {
    if (this.shuttingDown) return;
    if (this.immediateDispatchTimer) return; // already scheduled

    this.immediateDispatchTimer = setTimeout(() => {
      this.immediateDispatchTimer = null;
      if (this.shuttingDown) return;
      if (this.tickInProgress) {
        if (retries < 10) this.scheduleImmediateDispatch(retries + 1);
        return;
      }
      this.immediateDispatch().catch((err) => {
        this.deps.eventBus.emit({
          type: 'orchestrator:error',
          error: err instanceof Error ? err.message : String(err),
          context: 'immediate dispatch on task:created',
          fatal: false,
        });
      });
    }, 500);
  }

  /**
   * Mini-tick: invalidate caches → loadState → dispatchAll → saveState.
   * Skips reconcile/collect — only dispatches new tasks immediately.
   */
  private async immediateDispatch(): Promise<void> {
    if (this.shuttingDown) return;
    if (this.singleTaskRunIds.size > 0) return;
    await this.freshDispatch(() => this.shuttingDown ? Promise.resolve() : this.dispatchAll());
  }

  /**
   * Reconcile: check PID liveness, detect stalls, process retry queue.
   */
  private async reconcile(): Promise<void> {
    const state = this.state!;
    const now = Date.now();

    // Pre-fetch all running task and agent data in parallel
    const runningEntries = Object.entries(state.running);
    const [runningTaskData, runningAgentData] = await Promise.all([
      Promise.all(runningEntries.map(([taskId]) => this.deps.taskStore.get(taskId))),
      Promise.all(runningEntries.map(([, entry]) => this.deps.agentStore.get(entry.agent_id))),
    ]);

    // Check running processes
    for (let i = 0; i < runningEntries.length; i++) {
      const [taskId, entry] = runningEntries[i]!;
      // If task is already terminal (done/failed/cancelled), just clean up the stale entry
      const taskData = runningTaskData[i];
      if (!taskData || isTerminal(taskData.status)) {
        this.abortControllers.delete(taskId);
        delete state.running[taskId];
        await this.deps.agentService.setStatus(entry.agent_id, 'idle').catch((err) => {
          this.deps.eventBus.emit({ type: 'orchestrator:error', error: err instanceof Error ? err.message : String(err), context: `reconcile setStatus idle for stale agent ${entry.agent_id} (task ${taskId})`, fatal: false });
        });
        continue;
      }

      // Skip PID and stall checks for tasks with an active collector —
      // the process may have exited cleanly but handleRunSuccess/Failure
      // hasn't acquired the mutex yet. Without this guard, reconcile
      // would false-positive mark successfully completed runs as "crashed".
      if (this.activeCollectors.has(taskId)) {
        continue;
      }

      // PID check
      if (!this.deps.processManager.isAlive(entry.pid)) {
        // Process crashed — wrap in try/catch to ensure running entry is always cleaned
        try {
          await this._handleRunFailure(taskId, entry, 'Process crashed unexpectedly');
        } catch {
          // Cleanup even if _handleRunFailure fails (e.g. invalid transition)
          delete state.running[taskId];
          await this.deps.agentService.setStatus(entry.agent_id, 'idle').catch((err) => {
            this.deps.eventBus.emit({ type: 'orchestrator:error', error: err instanceof Error ? err.message : String(err), context: `reconcile crash fallback setStatus idle for agent ${entry.agent_id} (task ${taskId})`, fatal: false });
          });
        }
        continue;
      }

      // Stall detection — use per-agent timeout if configured, fallback to global
      const lastEventAt = new Date(entry.last_event_at).getTime();
      const agentForStall = runningAgentData[i];
      const stallTimeout = agentForStall?.config.stall_timeout_ms ?? this.deps.config.defaults.agent.stall_timeout_ms;
      // Total run time limit: an agent that keeps producing output is never "stalled".
      const runTimeout = agentForStall?.config.timeout_ms ?? this.deps.config.defaults.agent.timeout_ms;
      const stalled = now - lastEventAt > stallTimeout;
      const timedOut = now - new Date(entry.started_at).getTime() > runTimeout;

      if (stalled || timedOut) {
        if (stalled) {
          this.deps.eventBus.emit({
            type: 'orchestrator:stall_detected',
            runId: entry.run_id,
          });
        }

        this.abortControllers.get(taskId)?.abort();
        await this.deps.processManager.killWithGrace(entry.pid, 5_000);
        try {
          await this._handleRunFailure(taskId, entry, stalled
            ? 'Agent stalled (no events)'
            : `Agent execution timed out (${describeLimit(runTimeout)} limit)`);
        } catch {
          delete state.running[taskId];
          await this.deps.agentService.setStatus(entry.agent_id, 'idle').catch((err) => {
            this.deps.eventBus.emit({ type: 'orchestrator:error', error: err instanceof Error ? err.message : String(err), context: `reconcile stall fallback setStatus idle for agent ${entry.agent_id} (task ${taskId})`, fatal: false });
          });
        }
      }
    }

    // Fetch agents and tasks in parallel for stale/orphan detection
    const runningAgentIds = new Set(Object.values(state.running).map((e) => e.agent_id));
    const [allAgents, allTasks] = await Promise.all([
      this.cachedAgentStore.list(),
      this.cachedTaskStore.list(),
    ]);

    // Fix stale agent statuses — agents stuck in 'running' with no running entry (parallel)
    const staleAgents = allAgents.filter(
      (a) => a.status === 'running' && !runningAgentIds.has(a.id),
    );
    if (staleAgents.length > 0) {
      await Promise.all(
        staleAgents.map((agent) => this.deps.agentService.setStatus(agent.id, 'idle')),
      );
    }

    // Fix orphaned tasks — stuck in 'in_progress' with no running entry (parallel)
    const orphanedTasks = allTasks.filter(
      (t) => t.status === 'in_progress' && !state.running[t.id],
    );
    if (orphanedTasks.length > 0) {
      await Promise.all(
        orphanedTasks.map(async (task) => {
          try {
            await this.deps.taskService.updateStatus(task.id, 'failed');
          } catch {
            // If 'failed' transition is invalid, force-write via store
            task.status = 'failed';
            task.updated_at = new Date().toISOString();
            await this.deps.taskStore.save(task).catch((err) => {
              this.deps.eventBus.emit({
                type: 'orchestrator:error',
                error: err instanceof Error ? err.message : String(err),
                context: `force-write orphaned task ${task.id}`,
                fatal: false,
              });
            });
          }
          this.deps.eventBus.emit({
            type: 'task:orphaned',
            taskId: task.id,
          });
        }),
      );
    }

    // Retry queue: a due retry leaves the queue and competes in the normal dispatch
    // (capacity, scopes, dependencies); a retry not yet due keeps its task waiting.
    state.retry_queue = state.retry_queue.filter((retry) => new Date(retry.due_at).getTime() > now);

    await this.saveState();
  }

  /**
   * Create tasks for autonomous agents that have no active work.
   *
   * Priority: active Goals assigned to the agent come first.
   * If no goals, falls back to role-based autonomous work.
   */
  private async seedAutonomousTasks(): Promise<void> {
    const agents = await this.cachedAgentStore.list();
    const autonomousAgents = agents.filter(
      (a) => a.autonomous && a.status === 'idle',
    );
    if (autonomousAgents.length === 0) return;

    const allTasks = await this.cachedTaskStore.list();
    const activeGoals = this.cachedGoalStore
      ? await this.cachedGoalStore.list({ status: 'active' })
      : [];

    let anyCreated = false;
    const claimedGoalIds = new Set<string>();
    for (const agent of autonomousAgents) {
      // Skip if agent already has a non-terminal task assigned
      const hasActiveTask = allTasks.some(
        (t) => t.assignee === agent.id && !isTerminal(t.status),
      );
      if (hasActiveTask) continue;

      // Cooldown: prevent re-seeding the same agent too quickly
      const lastSeed = this.lastAutoSeedAt.get(agent.id) ?? 0;
      if (Date.now() - lastSeed < Orchestrator.AUTO_SEED_COOLDOWN_MS) continue;

      // Find goal: prefer assigned to this agent, then unassigned (not yet claimed)
      const goal = activeGoals.find(
        (g) => g.assignee === agent.id && !claimedGoalIds.has(g.id),
      ) ?? activeGoals.find(
        (g) => !g.assignee && !claimedGoalIds.has(g.id),
      );
      if (goal) claimedGoalIds.add(goal.id);
      const role = agent.role ?? 'general assistant';

      const title = goal
        ? `[auto] ${agent.name}: ${goal.title.slice(0, 60)}`
        : `[auto] ${agent.name}: ${role.slice(0, 60)}`;
      const description = goal
        ? `## GOAL (highest priority)\n\n${goal.description || goal.title}\n\n---\nAgent role: ${role}`
        : `Autonomous work cycle. Agent role: ${role}`;

      try {
        await this.deps.taskService.create({
          title,
          description,
          assignee: agent.id,
          labels: [AUTONOMOUS_LABEL],
          priority: 3,
          goalId: goal?.id,
        });
        this.lastAutoSeedAt.set(agent.id, Date.now());
        anyCreated = true;
      } catch (err) {
        this.deps.eventBus.emit({
          type: 'orchestrator:error',
          error: err instanceof Error ? err.message : String(err),
          context: `autonomous task for agent ${agent.id}`,
          fatal: false,
        });
      }
    }
    if (anyCreated) this.cachedTaskStore.invalidate();
  }

  /**
   * Dispatch all dispatchable tasks up to max_concurrent_agents.
   */
  private async dispatchAll(): Promise<void> {
    const state = this.state!;
    const maxConcurrent = this.deps.config.scheduling.max_concurrent_agents;
    const currentRunning = Object.keys(state.running).length;
    const availableSlots = maxConcurrent - currentRunning;

    if (availableSlots <= 0) return;

    const allTasks = await this.cachedTaskStore.list();
    const taskMap = new Map(allTasks.map((t) => [t.id, t]));
    // Tasks pinned to a usage-limit-paused agent wait without taking a slot,
    // so work for other accounts/providers keeps flowing.
    const pausedAgentIds = await this.pausedAgentIds();
    // A retrying task waits out its backoff (calculateRetryDelay) before it runs again.
    const now = Date.now();
    const backingOff = new Set(state.retry_queue.filter((r) => new Date(r.due_at).getTime() > now).map((r) => r.task_id));
    const candidates = allTasks
      .filter(
        (t) =>
          isDispatchable(t.status) &&
          !backingOff.has(t.id) &&
          !isBlocked(t, taskMap) &&
          !state.running[t.id] &&
          !state.claimed.has(t.id) &&
          !(t.assignee && pausedAgentIds.has(t.assignee)),
      )
      .sort((a, b) => {
        // 1. Priority: lower number = higher urgency (P1 before P4)
        const priDiff = (a.priority ?? 3) - (b.priority ?? 3);
        if (priDiff !== 0) return priDiff;
        // 2. Goal-linked tasks first (goalId present beats absent)
        const goalDiff = (a.goalId ? 0 : 1) - (b.goalId ? 0 : 1);
        if (goalDiff !== 0) return goalDiff;
        // 3. Recency tiebreaker: most recently updated first
        const bTime = b.updated_at ?? '';
        const aTime = a.updated_at ?? '';
        return bTime < aTime ? -1 : bTime > aTime ? 1 : 0;
      })
      .slice(0, availableSlots);

    // Dependency cycles never unblock — report them once instead of waiting silently.
    const openTasks = allTasks.filter((t) => !isTerminal(t.status));
    for (const cycle of findDependencyCycles(openTasks)) {
      const key = `cycle:${[...cycle].sort().join(',')}`;
      if (this.reportedProblems.has(key)) continue;
      this.reportOnce(key, {
        error: `Dependency cycle: ${[...cycle, cycle[0]].join(' → ')} — these tasks can never start. Fix depends_on.`,
        context: 'dependency check',
      });
      this.deps.eventBus.emit({ type: 'task:dependency_cycle', taskIds: cycle });
    }

    // Scope overlap check — pre-compute index of held scopes, then check candidates.
    // A scope is held while the task runs AND while it waits in review or for a
    // decision: its changes are not merged yet, so another agent editing the same
    // files would conflict.
    const blockedIds = new Set<string>();
    const inProgressScoped = allTasks.filter((t) => (t.status === 'in_progress' || t.status === 'review' || t.status === 'waiting_decision') && t.scope?.length);
    const scopeIndex = new ScopeIndex(inProgressScoped.map((t) => t.scope));
    for (const candidate of candidates) {
      if (!candidate.scope?.length) continue;
      if (scopeIndex.overlapsAny(candidate.scope)) {
        // Find first overlapping task for the event (check in-progress first, then peers)
        const overlapper = inProgressScoped.find((t) => scopesOverlap(candidate.scope, t.scope));
        this.deps.eventBus.emit({
          type: 'task:scope_overlap',
          taskId: candidate.id,
          overlappingTaskId: overlapper?.id ?? candidate.id,
          patterns: candidate.scope,
        });
        blockedIds.add(candidate.id);
      } else {
        // Approved — add to index so later candidates check against it
        scopeIndex.add(candidate.scope);
      }
    }

    for (const task of candidates) {
      if (blockedIds.has(task.id)) continue;
      try {
        await this.dispatchTask(task.id);
      } catch (err) {
        // Dispatch failed before agent started — handle workspace and other errors.
        // Respect max_attempts: retry if budget remains, fail only when exhausted.
        if (err instanceof WorkspaceError) {
          try {
            const t = await this.deps.taskStore.get(task.id);
            if (t && !isTerminal(t.status)) {
              const withAttempt = { ...t, attempts: (t.attempts ?? 0) + 1, updated_at: new Date().toISOString() };
              const nextStatus = resolveFailureStatus(withAttempt);
              const updated = { ...withAttempt, status: nextStatus };
              await this.deps.taskStore.save(updated);

              if (nextStatus === 'failed') {
                // Patch allTasks in-memory to avoid disk re-read
                const patchedTasks = allTasks.map((at) => at.id === updated.id ? updated : at);
                this.cachedTaskStore.invalidate();
                await this.cascadeFailDependents(updated.id, patchedTasks, `dependency ${updated.id} failed: ${err.message}`);
              } else {
                const delay = calculateRetryDelay(
                  updated.attempts - 1,
                  this.deps.config.scheduling.retry_base_delay_ms,
                  this.deps.config.scheduling.retry_max_delay_ms,
                );
                this.enqueueRetry(state, updated.id, updated.attempts, delay, err.message);
                await this.saveState();
              }
            }
          } catch {
            // Non-fatal: failure to record dispatch error should not stop remaining dispatches
          }
        }

        // Log but don't stop dispatching other tasks
        this.deps.eventBus.emit({
          type: 'orchestrator:error',
          error: err instanceof Error ? err.message : String(err),
          context: `dispatch task ${task.id}`,
          fatal: false,
        });
      }
    }
  }

  /**
   * Dispatch exactly one requested task.
   *
   * A single-shot CLI command (`orch run <task-id>`) should not opportunistically
   * consume other ready tasks while the requested run is being collected.
   * Temporarily claiming other dispatchable tasks keeps the shared dispatch path
   * focused without changing watch/run-all semantics.
   */
  private async dispatchOnlyTask(taskId: string): Promise<void> {
    const state = this.state!;
    const originalClaimed = new Set(state.claimed);
    const allTasks = await this.cachedTaskStore.list();
    this.singleTaskRunIds.add(taskId);

    for (const task of allTasks) {
      if (task.id !== taskId && isDispatchable(task.status)) {
        state.claimed.add(task.id);
      }
    }

    try {
      await this.dispatchTask(taskId);
    } finally {
      state.claimed = originalClaimed;
      if (!state.running[taskId]) {
        this.singleTaskRunIds.delete(taskId);
      }
      await this.saveState();
    }
  }

  /** Dedup + bounded push onto the retry queue. */
  private enqueueRetry(
    state: OrchestratorState,
    taskId: string,
    attempt: number,
    delay: number,
    error: string,
  ): void {
    if (state.retry_queue.some((r) => r.task_id === taskId)) return;
    if (state.retry_queue.length >= this.maxRetryQueueSize) {
      state.retry_queue.shift();
    }
    state.retry_queue.push({
      task_id: taskId,
      attempt,
      due_at: new Date(Date.now() + delay).toISOString(),
      error,
    });
  }

  /** Make agent instances match .orchestry/roles/*.yml (create, reconfigure, remove idle surplus). */
  private async syncRoles(): Promise<void> {
    if (!this.deps.roleService) return;
    try {
      const result = await this.deps.roleService.sync();
      for (const { file, message } of result.errors) {
        this.reportOnce(`role:${file}:${message}`, { error: message, context: `role file ${file} ignored` });
      }
      if (result.created.length || result.updated.length || result.removed.length) {
        this.cachedAgentStore.invalidate();
      }
    } catch (err) {
      this.reportOnce(`role-sync:${err instanceof Error ? err.message : String(err)}`, {
        error: err instanceof Error ? err.message : String(err),
        context: 'role sync',
      });
    }
  }

  /** Emit a non-fatal orchestrator error once per key (avoids repeating it every tick). */
  private reportOnce(key: string, payload: { error: string; context: string }): void {
    if (this.reportedProblems.has(key)) return;
    this.reportedProblems.add(key);
    this.deps.eventBus.emit({ type: 'orchestrator:error', ...payload, fatal: false });
  }

  /** IDs and names of agents whose quota group is paused (an assignee may be either). */
  private async pausedAgentIds(): Promise<Set<string>> {
    const pauses: QuotaState = await this.quota.activePauses();
    const ids = new Set<string>();
    if (Object.keys(pauses).length === 0) return ids;
    for (const agent of await this.cachedAgentStore.list()) {
      if (this.quota.isPaused(agent, pauses)) {
        ids.add(agent.id);
        ids.add(agent.name);
      }
    }
    return ids;
  }

  /**
   * When a task permanently fails, cascade-fail all tasks that depend on it
   * (directly or transitively). Prevents dependent tasks from hanging as TODO forever.
   */
  private async cascadeFailDependents(
    failedTaskId: string,
    allTasks: Task[],
    reason: string,
  ): Promise<void> {
    // Build reverse-dependency index: parentId → tasks that depend on it
    const reverseDeps = new Map<string, Task[]>();
    for (const t of allTasks) {
      for (const dep of t.depends_on) {
        let arr = reverseDeps.get(dep);
        if (!arr) { arr = []; reverseDeps.set(dep, arr); }
        arr.push(t);
      }
    }

    const queue = [failedTaskId];
    let head = 0;
    const visited = new Set<string>();
    let cascadedAny = false;

    while (head < queue.length) {
      const parentId = queue[head++]!;
      if (visited.has(parentId)) continue;
      visited.add(parentId);

      const dependents = reverseDeps.get(parentId);
      if (!dependents) continue;

      const toFail: Array<{ task: Task; previousStatus: TaskStatus }> = [];
      for (const t of dependents) {
        if (isTerminal(t.status) || visited.has(t.id)) continue;
        toFail.push({ task: t, previousStatus: t.status });
        queue.push(t.id);
      }

      if (toFail.length === 0) continue;

      const now = new Date().toISOString();
      await Promise.all(toFail.map(({ task }) =>
        this.deps.taskStore.save({ ...task, status: 'failed', updated_at: now }),
      ));

      for (const { task, previousStatus } of toFail) {
        this.deps.eventBus.emit({
          type: 'task:status_changed',
          taskId: task.id,
          from: previousStatus,
          to: 'failed',
        });
        this.deps.eventBus.emit({
          type: 'task:cascade_failed',
          taskId: task.id,
          failedDependencyId: failedTaskId,
          reason,
        });
      }
      cascadedAny = true;
    }

    if (cascadedAny) {
      this.cachedTaskStore.invalidate();
    }
  }

  /**
   * Dispatch a single task: claim → assign → execute.
   */
  private async dispatchTask(taskId: string, prefetched?: Task): Promise<void> {
    const state = this.state!;

    // Validate
    if (state.running[taskId]) {
      const entry = state.running[taskId]!;
      throw new TaskAlreadyRunningError(taskId, entry.run_id, entry.agent_id);
    }

    const task = prefetched ?? await this.deps.taskService.get(taskId);

    // Guard: skip tasks that are no longer dispatchable (e.g. already done via race)
    if (!isDispatchable(task.status)) {
      return;
    }

    // Claim (persist before spawning)
    state.claimed.add(taskId);
    await this.saveState();

    try {
      // Find agent
      const allAgents = await this.cachedAgentStore.list();
      const pauses = await this.quota.activePauses();
      const agent = await this.deps.agentService.findBestAgent(task, {
        isAvailable: (a) => !this.quota.isPaused(a, pauses),
      });
      if (!agent) {
        if (allAgents.length === 0) {
          throw new NoAgentsError();
        }
        // No idle agents — unclaim and return
        this.unclaim(taskId);
        await this.saveState();
        return;
      }

      // Prepare workspace
      const { path: workspacePath, branch: worktreeBranch } = await this.deps.workspaceManager.prepare(
        task,
        agent,
        this.deps.config,
      );

      // Build prompt — split into system (cached) and user (dynamic) parts
      const systemTemplate = this.deps.config.prompt?.system_template ?? DEFAULT_SYSTEM_TEMPLATE;
      const userTemplate = this.deps.config.prompt?.user_template ?? DEFAULT_USER_TEMPLATE;
      // Legacy: if user set a single template, use it as combined (no split)
      const legacyTemplate = this.deps.config.prompt?.template;
      const attempt = task.attempts + 1;

      let retryContext: RetryContext | undefined;
      if (attempt > 1) {
        const failedData = await this.deps.runService.getLastFailedRunContext(task.id);
        if (failedData) {
          retryContext = {
            previous_error: failedData.error,
            previous_output: failedData.output,
          };
        }
      }

      // Fetch shared context, messages, and goal context in parallel
      const goalId = task.goalId;
      const [sharedContext, pendingMessages, goalRaw] = await Promise.all([
        this.deps.contextStore?.getAll(),
        this.deps.messageService
          ? this.deps.messageService.drainMailbox(agent.id, task.id)
          : [] as import('../domain/message.js').Message[],
        goalId && this.cachedGoalStore
          ? this.cachedGoalStore.get(goalId).catch(() => null)
          : null,
      ]);

      let goalContext: GoalContext | undefined;
      if (goalRaw) {
        // Cache hit — allTasks was already loaded this tick by dispatchAll/reconcile
        const allTasks = await this.cachedTaskStore.list();
        const goalTasks = allTasks.filter((t) => t.goalId === goalId);
        const progressEntry = await this.deps.contextStore?.get(`${goalId}-progress`);
        const taskNames = goalTasks.map((t) => `[${t.status}] ${t.title}`);
        goalContext = {
          id: goalRaw.id,
          title: goalRaw.title,
          description: goalRaw.description,
          status: goalRaw.status,
          task_names: taskNames,
          progress: progressEntry?.value,
        };
      }

      const decisions = await this.bindingDecisions(task);
      const planning = task.plan_id && this.deps.planService
        ? await this.deps.planService.promptContext(task).catch(() => undefined)
        : undefined;
      const deliverables = this.deps.deliverableService;
      const [delivery, upstream] = deliverables
        ? await Promise.all([
          deliverables.requiresReport(task, agent.adapter).then((yes) => (yes ? deliverables.contractFor(task) : undefined)).catch(() => undefined),
          task.depends_on.length ? deliverables.upstreamFor(task).catch(() => []) : [],
        ])
        : [undefined, []];
      const contracts = task.uses?.length ? await readContractFiles(workspacePath, task.uses).catch(() => []) : [];
      const [prd, triage, review, bugs] = await Promise.all([
        this.deps.prdService ? this.deps.prdService.promptContext(task).catch(() => undefined) : undefined,
        this.deps.pmService ? this.deps.pmService.promptContext(task).catch(() => undefined) : undefined,
        this.deps.reviewService && task.review_of ? this.deps.reviewService.promptContext(task).catch(() => undefined) : undefined,
        this.deps.bugService ? this.deps.bugService.promptContext(task).catch(() => undefined) : undefined,
      ]);
      const context = buildPromptContext(
        task,
        agent,
        attempt,
        workspacePath,
        this.deps.config,
        { allAgents, retryContext, sharedContext, feedback: task.feedback, messages: pendingMessages.length ? pendingMessages : undefined, goal: goalContext, decisions, planning, delivery, upstream, contracts, prd, triage, review, bugs },
      );

      // Render prompt(s) — split mode for caching, legacy mode for backward compat
      let prompt: string;
      let systemPrompt: string | undefined;
      if (legacyTemplate) {
        // Legacy: single combined template
        prompt = await this.deps.templateEngine.render(legacyTemplate, context);
      } else {
        // Split mode: system prompt (cacheable) + user prompt (dynamic)
        systemPrompt = await this.deps.templateEngine.render(systemTemplate, context);
        prompt = await this.deps.templateEngine.render(userTemplate, context);
      }

      // The agent's own instructions (its role's system_prompt). Adapters prefer the
      // rendered system prompt over config.system_prompt, so it must be part of it.
      const roleInstructions = agent.config.system_prompt?.trim();
      if (roleInstructions) {
        const block = `## Your role\n${roleInstructions}`;
        if (systemPrompt !== undefined) systemPrompt = `${systemPrompt}\n\n${block}`;
        else prompt = `${block}\n\n${prompt}`;
      }

      // Augment prompt with library skill content
      if (this.deps.skillLoader && agent.config.skills?.length) {
        const skillBlock = await this.deps.skillLoader.loadSkills(agent.config.skills);
        if (skillBlock) {
          if (systemPrompt !== undefined) {
            systemPrompt = systemPrompt + '\n\n' + skillBlock;
          } else {
            // Legacy single-template path — append to combined prompt
            prompt = prompt + '\n\n' + skillBlock;
          }
        }
      }

      // Create run
      const run = await this.deps.runService.create({
        taskId: task.id,
        agentId: agent.id,
        attempt,
        prompt,
        workspacePath,
        executed: {
          adapter: agent.adapter,
          ...(agent.config.model ? { model: agent.config.model } : {}),
          ...(agent.config.effort ? { effort: agent.config.effort } : {}),
          ...(agent.role_id ? { role: agent.role_id } : {}),
        },
      });

      // Reset terminal states before transitioning to in_progress
      if (task.status === 'failed' || task.status === 'cancelled') {
        await this.deps.taskService.retry(taskId);
        task.status = 'todo';
        task.attempts = 0;
      }
      // Update task status
      await this.deps.taskService.updateStatus(taskId, 'in_progress');
      await this.deps.taskService.assign(taskId, agent.id);
      await this.deps.taskService.incrementAttempts(taskId);

      // Save worktree branch on proof immediately (survives any later failure)
      // Re-read from store to avoid overwriting in_progress status set above
      if (worktreeBranch) {
        const freshTask = await this.deps.taskStore.get(taskId);
        if (freshTask) {
          freshTask.proof = { ...(freshTask.proof ?? { files_changed: [] }), branch: worktreeBranch };
          freshTask.workspace = workspacePath;
          await this.deps.taskStore.save(freshTask);
        }
      }

      // Update agent status and clear last_error on successful dispatch
      await this.deps.agentService.setStatus(agent.id, 'running');
      const agentData = await this.deps.agentService.get(agent.id);
      agentData.current_task = taskId;
      agentData.last_error = undefined;
      await this.deps.agentStore.save(agentData);

      // Get adapter and execute
      const adapter = this.deps.adapterRegistry.require(agent.adapter);
      const abortController = new AbortController();
      this.abortControllers.set(taskId, abortController);

      const baseEnv: Record<string, string | undefined> = {
        ...agent.config.env,
        ORCH_AGENT_ID: agent.id,
        ORCH_AGENT_NAME: agent.name,
        ORCH_TASK_ID: task.id,
      };
      const agentBin = await this.agentBinDir();
      const handle = adapter.execute({
        prompt,
        systemPrompt,
        workspace: workspacePath,
        env: agentBin ? prependPath(baseEnv, agentBin) : (baseEnv as Record<string, string>),
        config: agentData.config,
        signal: abortController.signal,
      });

      const agentPid = handle.pid;
      const now = new Date().toISOString();
      await this.deps.runService.start(run.id, agentPid);

      // Move from claimed to running
      this.unclaim(taskId);
      state.running[taskId] = {
        run_id: run.id,
        agent_id: agent.id,
        task_id: taskId,
        pid: agentPid,
        started_at: now,
        last_event_at: now,
      };
      await this.saveState();

      // Collect events in background — track active collector to prevent
      // reconcile from false-positive "crash" detection during the window
      // between process exit and handleRunSuccess acquiring the mutex.
      this.activeCollectors.add(taskId);
      this.collectEvents(
        handle.events,
        run.id,
        taskId,
        agent.id,
        agentData.config,
      ).catch((err) => {
        this.deps.eventBus.emit({
          type: 'orchestrator:error',
          error: err instanceof Error ? err.message : String(err),
          context: `adapter execution for ${taskId}`,
          fatal: false,
        });
      }).finally(() => {
        // A stopped run that ends late must not unguard the newer run of the task.
        const current = this.state?.running[taskId];
        if (!current || current.run_id === run.id) this.activeCollectors.delete(taskId);
      });
    } catch (err) {
      // Rollback claim and clean up abort controller (process never launched)
      this.abortControllers.delete(taskId);
      this.unclaim(taskId);
      await this.saveState();
      throw err;
    }
  }

  /**
   * Collect events from an adapter's async generator.
   */
  private async collectEvents(
    generator: AsyncGenerator<import('../infrastructure/adapters/interface.js').AgentEvent>,
    runId: string,
    taskId: string,
    agentId: string,
    limits: Pick<import('../domain/agent.js').AgentConfig, 'timeout_ms' | 'stall_timeout_ms'> = {},
  ): Promise<void> {
    // Time limits of a live run. (reconcile skips runs that have a collector, so the
    // limits are enforced here: total run time, and time without any event.)
    const defaults = this.deps.config.defaults.agent;
    const timeoutMs = limits.timeout_ms ?? defaults.timeout_ms;
    const stallMs = limits.stall_timeout_ms ?? defaults.stall_timeout_ms;
    let expired: (Error & { errorKind: AdapterErrorKind }) | undefined;
    let killing: Promise<void> | undefined;
    let wake: () => void = () => {};
    const stopped = new Promise<void>((resolve) => { wake = resolve; });
    const expire = (stalled: boolean): void => {
      const entry = this.state?.running[taskId];
      if (expired || this.shuttingDown || entry?.run_id !== runId) return;
      expired = Object.assign(
        new Error(stalled ? 'Agent stalled (no events)' : `Agent execution timed out (${describeLimit(timeoutMs)} limit)`),
        { errorKind: AdapterErrorKind.TIMEOUT },
      );
      if (stalled) this.deps.eventBus.emit({ type: 'orchestrator:stall_detected', runId });
      this.abortControllers.get(taskId)?.abort();
      if (entry.pid > 0) killing = this.deps.processManager.killWithGrace(entry.pid, 5_000).catch(() => {});
      wake();
    };
    const deadline = setTimeout(() => expire(false), timeoutMs);
    const idle = setTimeout(() => expire(true), stallMs);
    deadline.unref?.();
    idle.unref?.();

    let collectedTokens: import('../domain/run.js').TokenUsage | undefined;
    let resultText: string | undefined;
    let lastAgentMessage: string | undefined;
    let lastErrorKind: import('../domain/errors.js').AdapterErrorKind | undefined;
    let lastResetAt: string | undefined;
    /** First fatal error event — the run failed even if the process exits 0. */
    let fatalError: { message: string; kind?: import('../domain/errors.js').AdapterErrorKind; resetAt?: string } | undefined;
    const filesChangedSet = new Set<string>();

    const consume = async (): Promise<void> => {
      for await (const event of generator) {
        if (this.shuttingDown || expired) break;
        idle.refresh();

        // Capture token usage and result text from done events
        if (event.type === 'done') {
          if (event.tokens) {
            const { input, output, reasoning, cache_read, cache_write } = event.tokens;
            collectedTokens = createTokenUsage(input, output, { reasoning, cache_read, cache_write });
          }
          const data = event.data as Record<string, unknown> | undefined;
          // Claude: { type: 'result', result: '...' }
          // Codex: { type: 'turn.completed', result: '...' }
          if (data && typeof data.result === 'string') {
            resultText = data.result;
          }
        }

        // Collect last agent message text as fallback for result
        // (Codex agent_message items, Claude assistant messages, etc.)
        if (event.type === 'output') {
          const data = event.data as Record<string, unknown> | undefined;
          if (data) {
            const text = typeof data.text === 'string' ? data.text :
                         typeof data.message === 'string' ? data.message : undefined;
            if (text?.trim()) lastAgentMessage = text;
          }
        }

        // Track file changes
        if (event.type === 'file_change') {
          const data = event.data as Record<string, unknown> | undefined;
          // Codex sends { paths: string[], raw: ... }
          if (data && Array.isArray(data.paths)) {
            for (const p of data.paths) {
              if (typeof p === 'string') filesChangedSet.add(p);
            }
          } else {
            const filePath = data && typeof data.path === 'string' ? data.path :
                             typeof event.data === 'string' ? event.data : String(event.data);
            filesChangedSet.add(filePath);
          }
        }

        // Extract file paths from tool_call events (Claude emits tool_use with file paths
        // but no separate file_change events — unlike Codex).
        // Must run before event.data GC release below.
        let toolCallFilePath: string | null = null;
        if (event.type === 'tool_call') {
          const data = event.data as Record<string, unknown> | undefined;
          if (data) {
            const toolInput = data.input as Record<string, unknown> | undefined;
            const toolName = typeof data.name === 'string' ? data.name : '';
            // Claude tool_use: { name: 'Write'|'Edit', input: { file_path: '...' } }
            if (toolInput && typeof toolInput.file_path === 'string') {
              if (/^(Write|Edit|MultiEdit|NotebookEdit)$/i.test(toolName)) {
                toolCallFilePath = toolInput.file_path;
                filesChangedSet.add(toolCallFilePath);
              }
            }
          }
        }

        if (event.type === 'error') {
          if (event.resetAt) lastResetAt = event.resetAt;
          if (event.fatal && !fatalError) {
            fatalError = {
              message: extractErrorMessage(event.data),
              ...(event.errorKind ? { kind: event.errorKind } : {}),
              ...(event.resetAt ? { resetAt: event.resetAt } : {}),
            };
          }
        }

        // Validate and normalize event timestamp
        const eventTimestamp = isValidISOTimestamp(event.timestamp)
          ? event.timestamp
          : new Date().toISOString();

        // Capture file path before GC release (event.data is nulled below)
        const filePath = event.type === 'file_change'
          ? (() => {
              const d = event.data as Record<string, unknown> | undefined;
              return d && typeof d.path === 'string' ? d.path :
                     typeof event.data === 'string' ? event.data : String(event.data);
            })()
          : null;
        // Serialize + truncate once — reused for JSONL write and event bus
        const serialized = serializeEventData(event.data, MAX_EVENT_DATA_LEN);
        // Release the original (potentially large) parsed object for GC
        (event as unknown as Record<string, unknown>).data = undefined;

        // Record event (pre-serialized string keeps JSONL lines manageable)
        const runEvent: RunEvent = {
          timestamp: eventTimestamp,
          type: event.type === 'output' ? 'agent_output' :
                event.type === 'file_change' ? 'file_changed' :
                event.type === 'command' ? 'command_run' :
                event.type === 'tool_call' ? 'tool_call' :
                event.type === 'error' ? 'error' : 'done',
          data: serialized,
        };
        await this.deps.runService.appendEvent(runId, runEvent);

        // Update last_event_at for stall detection (debounced write — non-critical)
        if (this.state?.running[taskId]) {
          this.state.running[taskId]!.last_event_at = eventTimestamp;
          this.saveStateLazy();
        }

        // Emit to event bus — further cap for TUI consumption
        const busData = serializeEventData(serialized, MAX_BUS_DATA_LEN);
        if (event.type === 'output' || event.type === 'tool_call') {
          this.deps.eventBus.emit({
            type: 'agent:output',
            runId,
            agentId,
            data: busData,
          });
          // Also emit file_changed for tool_calls that write files (real-time TUI visibility)
          if (toolCallFilePath) {
            this.deps.eventBus.emit({
              type: 'agent:file_changed',
              runId,
              agentId,
              path: toolCallFilePath,
            });
          }
        } else if (event.type === 'file_change') {
          this.deps.eventBus.emit({
            type: 'agent:file_changed',
            runId,
            agentId,
            path: filePath!,
          });
        } else if (event.type === 'error') {
          if (event.errorKind) lastErrorKind = event.errorKind;
          this.deps.eventBus.emit({
            type: 'agent:error',
            runId,
            agentId,
            error: busData,
            ...(event.errorKind ? { errorKind: event.errorKind } : {}),
          });
        }
      }
    };

    try {
      const consuming = consume();
      consuming.catch(() => {}); // after a time limit the stream is abandoned
      await Promise.race([consuming, stopped]);
      if (expired) {
        await killing;
        throw expired;
      }

      // A fatal error event (e.g. Claude result with is_error) fails the run even on exit code 0
      if (fatalError && !this.shuttingDown) {
        throw Object.assign(new Error(fatalError.message), {
          ...(fatalError.kind ? { errorKind: fatalError.kind } : {}),
          ...(fatalError.resetAt ? { resetAt: fatalError.resetAt } : {}),
        });
      }

      // Adapter finished successfully — runService.finish emits agent:completed
      // Use resultText from done event, or fall back to last agent message
      const finalResult = resultText ?? lastAgentMessage;
      await this.handleRunSuccess(taskId, runId, agentId, collectedTokens, finalResult, [...filesChangedSet]);
    } catch (err) {
      type AdapterFailure = Error & { errorKind?: import('../domain/errors.js').AdapterErrorKind; resetAt?: string };
      // The fatal event's message is more specific than "process exited with code 1"
      const error = expired?.message ?? fatalError?.message ?? (err instanceof Error ? err.message : String(err));
      // Prefer a time limit, the fatal event, then the last error event, then the thrown error (from utils.ts)
      const errorKind = expired?.errorKind ?? fatalError?.kind ?? lastErrorKind
        ?? (err instanceof Error ? (err as AdapterFailure).errorKind : undefined);
      const resetAt = fatalError?.resetAt ?? lastResetAt
        ?? (err instanceof Error ? (err as AdapterFailure).resetAt : undefined);
      const entry = this.state?.running[taskId];
      if (entry?.run_id === runId) {
        // runService.finish emits agent:completed
        await this.handleRunFailure(taskId, entry, error, errorKind, resetAt);
      } else {
        // Running entry was already cleaned up (e.g. by reconcile), or belongs to a
        // newer run of the same task (this one timed out / stalled) — finalize the run
        // directly so it doesn't stay stuck in status: running forever.
        await this.deps.runService.finish(runId, 'failed', undefined, error).catch(() => {});
      }
    } finally {
      clearTimeout(deadline);
      clearTimeout(idle);
      // Release the cached JSONL append handle FD for this run
      this.deps.runStore.closeRunEvents(runId);
    }
  }

  private async handleRunSuccess(
    taskId: string,
    runId: string,
    agentId: string,
    tokens?: import('../domain/run.js').TokenUsage,
    resultText?: string,
    filesChanged?: string[],
  ): Promise<void> {
    const pending = await this.withStateLock(() => this._handleRunSuccess(taskId, runId, agentId, tokens, resultText, filesChanged));
    if (!pending) return;

    // Git syncs and review criteria (e.g. a 5-minute mvn test) run OUTSIDE the state
    // lock so ticks, dispatch and other completions continue; review.max_parallel caps reviews.
    let settled: boolean;
    if (pending.kind === 'integrate') {
      // Worktree: commit → merge main in → review the merged result → merge queue.
      const outcome = await this.integration.process(taskId, { trigger: 'completed', autoApprove: pending.autoApprove });
      settled = outcome.status === 'done' || outcome.status === 'sent_back';
    } else {
      const passed = await this.integration.review(taskId, pending.criteria, pending.cwd)
        .catch((err: unknown) => {
          this.deps.eventBus.emit({
            type: 'orchestrator:error',
            error: err instanceof Error ? err.message : String(err),
            context: `auto-review of task ${taskId}`,
            fatal: false,
          });
          return false;
        });
      settled = passed && !this.shuttingDown;
      if (settled) await this.withStateLock(() => this.approveReviewed(taskId));
    }
    const wasSingleTaskRun = this.singleTaskRunIds.delete(taskId);
    // Done unblocks dependents; a send-back makes the task dispatchable again.
    if (settled && !wasSingleTaskRun) this.scheduleImmediateDispatch();
  }

  private async _handleRunSuccess(
    taskId: string,
    runId: string,
    agentId: string,
    tokens?: import('../domain/run.js').TokenUsage,
    resultText?: string,
    filesChanged?: string[],
  ): Promise<PendingCompletion | undefined> {
    await this.flushStateLazy();
    const state = this.state!;

    // Skip if the task was cancelled/removed from running, or a newer run of it is
    // in progress (this run was stopped for a stall or timeout and retried).
    if (state.running[taskId]?.run_id !== runId) return;
    this.abortControllers.delete(taskId);

    const task = await this.deps.taskStore.get(taskId);
    if (!task) return;

    // Paperwork (a plan, a PRD, a PM answer) that ended without handing it in failed (it is retried).
    let pendingDecision = await this.hasPendingDecision(taskId);
    const paperwork = await this.paperworkOutcome(task);
    const isPaperwork = Boolean(paperwork);
    if (paperwork && !pendingDecision && paperwork.outcome === 'missing') {
      return this._handleRunFailure(taskId, state.running[taskId]!, paperwork.missing).then(() => undefined);
    }

    // Every agent ends with a delivery report: none is a failed run (retried with
    // the reason); partial / blocked waits for a human.
    const deliverables = this.deps.deliverableService;
    // An owner that handed its bug to another role (orch bug reassign) is done with it.
    const handoff = Boolean(!isPaperwork && !pendingDecision && this.deps.bugService && task.bug?.handoff);
    if (!isPaperwork && !pendingDecision && !handoff && deliverables) {
      const runAgent = await this.deps.agentStore.get(agentId);
      if (await deliverables.requiresReport(task, runAgent?.adapter)) {
        const delivered = await deliverables.runOutcome(task, state.running[taskId]!.started_at);
        if (delivered === 'missing') {
          return this._handleRunFailure(
            taskId,
            state.running[taskId]!,
            'You ended your run without a delivery report. Write the report (Markdown, with the sections listed in the task prompt) and run: orch task deliver report.md --status done|partial|blocked',
          ).then(() => undefined);
        }
        if (delivered.status !== 'done' && this.deps.decisionService) {
          await this.deps.decisionService.request({
            task_id: taskId,
            source: 'delivery',
            question: `"${task.title}" was delivered as ${delivered.status}. How should we go on? (continue with instructions, approve to merge it as it is, or cancel)`,
            context: delivered.report.slice(0, MAX_CONTEXT_LENGTH),
            requested_by: delivered.submitted_by,
          });
          pendingDecision = true;
        }
      }
    }

    // Worktree tasks are committed, synced with main and reviewed by the
    // IntegrationService after the lock is released (files_changed is filled in
    // there from the committed branch if the adapter reported none).
    const isWorktree = Boolean(task.proof?.branch && task.workspace);

    // Save proof of work (agent summary + files changed); clear stale feedback
    task.proof = {
      ...task.proof,
      agent_summary: resultText?.slice(0, 2000) ?? task.proof?.agent_summary,
      // Worktree: recomputed from the branch after committing (stale after a send-back).
      files_changed: filesChanged?.length ? filesChanged : (isWorktree ? [] : (task.proof?.files_changed ?? [])),
    };
    delete task.feedback;
    await this.deps.taskStore.save(task);

    const agent = await this.deps.agentStore.get(agentId);
    if (agent) {
      await this.quota.recordSuccess(agent).catch(() => {});
    }
    const isAutonomousTask = task.labels?.includes(AUTONOMOUS_LABEL);
    const autoApprove = isAutonomousTask || agent?.config.approval_policy === 'auto';

    // An agent that asked a human (orch decision request) waits for the answer.
    // A planning task is finished once its plan is submitted (review → done below).
    const newStatus: import('../domain/task.js').TaskStatus = pendingDecision
      ? 'waiting_decision'
      : isPaperwork || handoff ? 'review' : resolveCompletionStatus(task, true, autoApprove);

    // Finish run first (emits agent:completed)
    await this.deps.runService.finish(runId, 'succeeded', tokens);

    // Track runtime before cleaning up
    const runningEntry = state.running[taskId];
    const successRuntimeMs = runningEntry
      ? Date.now() - new Date(runningEntry.started_at).getTime()
      : 0;
    if (runningEntry) {
      state.stats.total_runtime_ms += successRuntimeMs;
    }

    // Clean up running entry early — prevents handleRunFailure from being called on catch
    delete state.running[taskId];

    // Update agent stats (always — agent completed its work regardless of merge outcome)
    const statsUpdate: Partial<import('../domain/agent.js').AgentStats> = {
      tasks_completed: (agent?.stats.tasks_completed ?? 0) + 1,
      total_runs: (agent?.stats.total_runs ?? 0) + 1,
      total_runtime_ms: (agent?.stats.total_runtime_ms ?? 0) + successRuntimeMs,
    };
    if (tokens) {
      statsUpdate.tokens_used = (agent?.stats.tokens_used ?? 0) + tokens.total;
    }
    await this.deps.agentService.updateStats(agentId, statsUpdate).catch((err) => {
      this.deps.eventBus.emit({
        type: 'orchestrator:error',
        error: err instanceof Error ? err.message : String(err),
        context: `agent stats update for ${agentId}`,
        fatal: false,
      });
    });

    // Update global stats
    state.stats.total_tasks_completed++;
    state.stats.total_runs++;
    if (tokens) {
      state.stats.total_tokens.input += tokens.input;
      state.stats.total_tokens.output += tokens.output;
      state.stats.total_tokens.reasoning += tokens.reasoning;
      state.stats.total_tokens.cache_read += tokens.cache_read;
      state.stats.total_tokens.cache_write += tokens.cache_write;
      state.stats.total_tokens.total =
        state.stats.total_tokens.input + state.stats.total_tokens.output + state.stats.total_tokens.reasoning;
    }

    // Update task status — force-write via store if service validation fails
    try {
      await this.deps.taskService.updateStatus(taskId, newStatus);
    } catch (validationErr) {
      // Bypass state machine validation and force-write directly
      const error = validationErr instanceof Error ? validationErr.message : String(validationErr);
      this.deps.eventBus.emit({
        type: 'orchestrator:error',
        error,
        context: `state machine validation failed for task ${taskId} -> ${newStatus}, force-writing`,
        fatal: false,
      });
      task.status = newStatus;
      task.updated_at = new Date().toISOString();
      await this.deps.taskStore.save(task).catch((saveErr) => {
        this.deps.eventBus.emit({
          type: 'orchestrator:error',
          error: saveErr instanceof Error ? saveErr.message : String(saveErr),
          context: `force-write task ${taskId} to store failed`,
          fatal: false,
        });
      });
    }
    await this.deps.agentService.setStatus(agentId, 'idle').catch((err) => {
      this.deps.eventBus.emit({ type: 'orchestrator:error', error: err instanceof Error ? err.message : String(err), context: `_handleRunSuccess setStatus idle for agent ${agentId}`, fatal: false });
    });

    // Clear current_task — agent is now idle
    const agentAfter = await this.deps.agentStore.get(agentId);
    if (agentAfter) {
      agentAfter.current_task = undefined;
      await this.deps.agentStore.save(agentAfter);
    }

    // Review gate. With review_criteria, passing them approves the task (failing
    // never force-approves). Without criteria, an auto policy approves; otherwise a
    // human approves. Approval merges; dependents unblock only once it is done.
    // Worktree tasks first get main merged in (IntegrationService). Git and review
    // work runs after the lock is released (see handleRunSuccess).
    let pendingReview: PendingCompletion | undefined;
    if (handoff && newStatus === 'review') {
      const fresh = await this.deps.taskStore.get(taskId);
      if (fresh) {
        await this.deps.bugService!.applyHandoff(fresh).catch((err: unknown) => {
          this.deps.eventBus.emit({ type: 'orchestrator:error', error: err instanceof Error ? err.message : String(err), context: `handing bug ${taskId} to another role`, fatal: false });
        });
      }
    } else if (isPaperwork && newStatus === 'review') {
      await this.finishPaperworkTask(task);
    } else if (newStatus === 'review') {
      if (isWorktree) {
        pendingReview = { kind: 'integrate', autoApprove };
      } else if (task.review_criteria?.length) {
        pendingReview = { kind: 'review', criteria: task.review_criteria, cwd: task.workspace ?? this.deps.projectRoot };
      } else if (autoApprove) {
        await this.approveReviewed(taskId);
      }
    }

    await this.saveState();

    const wasSingleTaskRun = this.singleTaskRunIds.delete(taskId);
    if (!wasSingleTaskRun) {
      // Reactive dispatch — agent is idle, try to assign next task immediately
      this.scheduleImmediateDispatch();
    } else if (pendingReview) {
      // Keep tracking it so the post-review approval skips the reactive dispatch too.
      this.singleTaskRunIds.add(taskId);
    }
    return pendingReview;
  }

  private async handleRunFailure(
    taskId: string,
    entry: RunningEntry,
    error: string,
    errorKind?: import('../domain/errors.js').AdapterErrorKind,
    resetAt?: string,
  ): Promise<void> {
    if (errorKind === AdapterErrorKind.RATE_LIMIT) {
      return this.withStateLock(() => this._handleUsageLimit(taskId, entry, error, resetAt));
    }
    return this.withStateLock(() => this._handleRunFailure(taskId, entry, error, errorKind));
  }

  /**
   * A run hit its account's usage limit. Not the task's fault: pause the quota
   * group until the reset time, refund the attempt, and put the task back in the
   * queue with its worktree intact. Dependents are not failed. The task runs
   * again once the group resumes (or on an agent with another account).
   */
  private async _handleUsageLimit(
    taskId: string,
    entry: RunningEntry,
    error: string,
    resetAt?: string,
  ): Promise<void> {
    await this.flushStateLazy();
    const state = this.state!;
    if (state.running[taskId]?.run_id !== entry.run_id) return;
    this.abortControllers.delete(taskId);

    const task = await this.deps.taskStore.get(taskId);
    if (!task) return;

    await this.deps.runService.finish(entry.run_id, 'failed', undefined, error);
    await this.deps.agentService.setStatus(entry.agent_id, 'idle');

    const agent = await this.deps.agentStore.get(entry.agent_id);
    if (agent) {
      const parsedReset = resetAt ? new Date(resetAt) : undefined;
      const { pause } = await this.quota.recordLimitHit({
        agent,
        taskId,
        message: error,
        ...(parsedReset && !Number.isNaN(parsedReset.getTime()) ? { resetAt: parsedReset } : {}),
      });
      agent.current_task = undefined;
      agent.last_error = {
        message: `Usage limit — paused until ${pause.until}. ${pause.reason}`.slice(0, 500),
        kind: AdapterErrorKind.RATE_LIMIT,
        timestamp: new Date().toISOString(),
      };
      agent.stats.total_runs += 1;
      agent.stats.total_runtime_ms += Date.now() - new Date(entry.started_at).getTime();
      await this.deps.agentStore.save(agent);
    }

    // Refund the attempt and requeue (in_progress → retrying is dispatchable).
    task.attempts = Math.max(0, task.attempts - 1);
    task.updated_at = new Date().toISOString();
    await this.deps.taskStore.save(task);
    await this.deps.taskService.updateStatus(taskId, 'retrying');

    delete state.running[taskId];
    state.stats.total_runs++;
    await this.saveState();
    // No immediate re-dispatch: the group is paused; the next tick checks again.
  }

  private async _handleRunFailure(
    taskId: string,
    entry: RunningEntry,
    error: string,
    errorKind?: import('../domain/errors.js').AdapterErrorKind,
  ): Promise<void> {
    await this.flushStateLazy();
    const state = this.state!;

    // Guard: skip if the running entry was already cleaned up (e.g. by handleRunSuccess)
    // or belongs to a newer run of the task
    if (state.running[taskId]?.run_id !== entry.run_id) return;
    this.abortControllers.delete(taskId);

    const task = await this.deps.taskStore.get(taskId);
    if (!task) return;

    // Paperwork handed in before a crash still did its job.
    if (!(await this.hasPendingDecision(taskId)) && (await this.paperworkOutcome(task))?.outcome === 'submitted') {
      await this._handleRunSuccess(taskId, entry.run_id, entry.agent_id);
      return;
    }

    await this.deps.runService.finish(entry.run_id, 'failed', undefined, error);
    await this.deps.agentService.setStatus(entry.agent_id, 'idle');

    // Clear current_task and persist last_error — agent is now idle
    const agentAfterIdle = await this.deps.agentStore.get(entry.agent_id);
    if (agentAfterIdle) {
      agentAfterIdle.current_task = undefined;
      agentAfterIdle.last_error = {
        message: error.slice(0, 500),
        kind: errorKind ?? classifyAdapterError(error),
        timestamp: new Date().toISOString(),
      };
      await this.deps.agentStore.save(agentAfterIdle);
    }

    if (await this.hasPendingDecision(taskId)) {
      // The agent asked a human and stopped: not a failure. Refund the attempt and
      // keep the worktree; the task continues once the decision is answered.
      task.attempts = Math.max(0, task.attempts - 1);
      task.updated_at = new Date().toISOString();
      await this.deps.taskStore.save(task);
      await this.deps.taskService.updateStatus(taskId, 'waiting_decision');
      delete state.running[taskId];
      state.stats.total_runs++;
      await this.saveState();
      this.singleTaskRunIds.delete(taskId);
      return;
    }

    // Compute runtime once — used for both agent stats and global stats
    const runtimeMs = Date.now() - new Date(entry.started_at).getTime();
    await this.deps.agentService.updateStats(entry.agent_id, {
      tasks_failed: (agentAfterIdle?.stats.tasks_failed ?? 0) + 1,
      total_runs: (agentAfterIdle?.stats.total_runs ?? 0) + 1,
      total_runtime_ms: (agentAfterIdle?.stats.total_runtime_ms ?? 0) + runtimeMs,
    });

    // Determine retry or fail via domain function
    const failureStatus = resolveFailureStatus(task);
    await this.deps.taskService.updateStatus(taskId, failureStatus);

    if (failureStatus === 'retrying') {
      const delay = calculateRetryDelay(
        task.attempts - 1,
        this.deps.config.scheduling.retry_base_delay_ms,
        this.deps.config.scheduling.retry_max_delay_ms,
      );

      this.enqueueRetry(state, taskId, task.attempts + 1, delay, error);

      this.deps.eventBus.emit({
        type: 'run:retry',
        runId: entry.run_id,
        attempt: task.attempts + 1,
        delay_ms: delay,
      });
    } else {
      state.stats.total_tasks_failed++;

      // Cascade-fail tasks that depend on this permanently failed task
      this.cachedTaskStore.invalidate();
      const allTasks = await this.cachedTaskStore.list();
      await this.cascadeFailDependents(taskId, allTasks, `dependency ${taskId} failed: ${error}`);
    }

    // Track runtime (reuse runtimeMs computed above)
    state.stats.total_runtime_ms += runtimeMs;

    // Keep the worktree and branch: a retry continues from the work done so far, and a
    // failed task can be inspected or retried (orch task retry). Only a human cancel
    // discards them (discardCancelledWork).

    // Clean up running entry
    delete state.running[taskId];
    state.stats.total_runs++;
    await this.saveState();

    const wasSingleTaskRun = this.singleTaskRunIds.delete(taskId);
    if (!wasSingleTaskRun) {
      // Reactive dispatch — agent is idle, try to assign next task immediately
      this.scheduleImmediateDispatch();
    }
  }

  /**
   * Planning task done: the plan is with a human (or already decided). The
   * planner only read code, so its worktree is removed without merging.
   */
  /**
   * Tasks that hand in something other than code: a plan, a PRD, a PM answer.
   * Undefined for ordinary tasks.
   */
  private async paperworkOutcome(task: Task): Promise<{ outcome: 'submitted' | 'missing'; missing: string } | undefined> {
    if (task.plan_id && this.deps.planService) {
      return {
        outcome: await this.deps.planService.planningRunOutcome(task),
        missing: 'The planner ended its run without submitting a plan. Write the plan file and run: orch plan submit <file>',
      };
    }
    if (task.prd_draft && this.deps.prdService) {
      return {
        outcome: await this.deps.prdService.draftOutcome(task),
        missing: `You ended your run without handing in the PRD. Write it and run: orch prd add ${task.prd_draft} -f prd.md -m "<what it covers>"`,
      };
    }
    if (task.review_of && this.deps.reviewService) {
      return {
        outcome: await this.deps.reviewService.outcome(task),
        missing: 'You ended your run without submitting the review. Write review.yml and run: orch review submit review.yml',
      };
    }
    if (task.verify_bugs?.length && this.deps.bugService) {
      return {
        outcome: await this.deps.bugService.verifyOutcome(task),
        missing: `You ended your run before re-verifying every bug. For each one run: orch bug verify <bug-id> --fixed  |  --not-fixed -m "<what you saw>" (bugs: ${task.verify_bugs.join(', ')})`,
      };
    }
    if (task.triage_decision_id && this.deps.pmService) {
      const id = task.triage_decision_id;
      return {
        outcome: await this.deps.pmService.triageOutcome(task),
        missing: `You ended your run without answering ${id}. Run: orch decision answer ${id} -m "<answer>" — or, if a human must decide: orch decision escalate ${id} -m "<why>"`,
      };
    }
    return undefined;
  }

  /** Paperwork handed in: done (nothing to commit or merge); a drafted PRD is planned next. */
  private async finishPaperworkTask(task: Task): Promise<void> {
    await this.finishPlanningTask(task);
    if (task.verify_bugs?.length && this.deps.bugService) {
      await this.deps.bugService.verifyFinished(task).catch((err: unknown) => {
        this.deps.eventBus.emit({ type: 'orchestrator:error', error: err instanceof Error ? err.message : String(err), context: `after re-verification ${task.id}`, fatal: false });
      });
    }
    if (task.prd_draft && this.deps.prdService) {
      await this.deps.prdService.draftFinished(task).catch((err: unknown) => {
        this.deps.eventBus.emit({
          type: 'orchestrator:error',
          error: err instanceof Error ? err.message : String(err),
          context: `planning PRD ${task.prd_draft} after task ${task.id}`,
          fatal: false,
        });
      });
    }
  }

  private async finishPlanningTask(task: Task): Promise<void> {
    if (task.proof?.branch || task.workspace) {
      await this.deps.workspaceManager.cleanup(task.id, task.proof?.branch).catch((err) => {
        this.deps.eventBus.emit({
          type: 'orchestrator:error',
          error: err instanceof Error ? err.message : String(err),
          context: `workspace cleanup for planning task ${task.id}`,
          fatal: false,
        });
      });
    }
    await this.deps.taskService.updateStatus(task.id, 'done').catch((err) => {
      this.deps.eventBus.emit({
        type: 'orchestrator:error',
        error: err instanceof Error ? err.message : String(err),
        context: `finishing planning task ${task.id}`,
        fatal: false,
      });
    });
  }

  private async hasPendingDecision(taskId: string): Promise<boolean> {
    if (!this.deps.decisionService) return false;
    return (await this.deps.decisionService.pendingFor(taskId).catch(() => [])).length > 0;
  }

  /** Answered decisions the agent on `task` must follow, shaped for the prompt. */
  private async bindingDecisions(task: Task): Promise<Array<{ question: string; answer: string; project_wide: boolean }>> {
    if (!this.deps.decisionService) return [];
    const decisions = await this.deps.decisionService.bindingFor(task).catch(() => []);
    return decisions.map((d) => ({ question: d.question, answer: describeAnswer(d), project_wide: d.answer?.scope === 'project' }));
  }

  private agentBinPromise: Promise<string | undefined> | undefined;

  /** Directory with the `orch` launcher for agents (created once; undefined if unavailable). */
  private agentBinDir(): Promise<string | undefined> {
    if (!this.deps.prepareAgentBin) return Promise.resolve(undefined);
    this.agentBinPromise ??= this.deps.prepareAgentBin().catch((err: unknown) => {
      this.reportOnce('agent-bin', {
        error: `Could not prepare the orch launcher for agents: ${err instanceof Error ? err.message : String(err)}`,
        context: 'agents cannot run orch commands (e.g. orch decision request)',
      });
      return undefined;
    });
    return this.agentBinPromise;
  }

  /** Approve a reviewed task (merge + done). On merge failure it stays in review. */
  private async approveReviewed(taskId: string): Promise<void> {
    try {
      await this.reviewGate.approve(taskId);
    } catch (err) {
      this.deps.eventBus.emit({
        type: 'orchestrator:error',
        error: err instanceof Error ? err.message : String(err),
        context: `approve task ${taskId}`,
        fatal: false,
      });
    }
  }

  private unclaim(taskId: string): void {
    this.state!.claimed.delete(taskId);
  }

  /**
   * Throw if this instance doesn't own the lock (read-only session).
   */
  private requireOwnership(): void {
    if (!this.lockAcquired) {
      throw new LockConflictError(0);
    }
  }

  private async loadState(): Promise<void> {
    this.state = await this.deps.stateStore.read();
  }

  /**
   * On startup, clean up stale running entries left by a crashed/restarted process.
   *
   * Instead of marking orphaned tasks as 'failed' (which triggers retry → agents
   * redo already-committed work), we cancel them. Users can manually reactivate
   * specific tasks if needed.
   */
  private async cleanupStaleRunningEntries(): Promise<void> {
    const state = this.state!;

    // Phase 1: Clean up stale running entries with dead PIDs (parallel)
    const deadEntries = Object.entries(state.running).filter(
      ([, entry]) => !this.deps.processManager.isAlive(entry.pid),
    );
    const cleanedTaskIds = new Set<string>();

    if (deadEntries.length > 0) {
      for (const [taskId] of deadEntries) {
        delete state.running[taskId];
        cleanedTaskIds.add(taskId);
      }

      await Promise.all(
        deadEntries.map(async ([taskId, entry]) => {
          await this.deps.agentService.setStatus(entry.agent_id, 'idle').catch((err) => {
            this.deps.eventBus.emit({ type: 'orchestrator:error', error: err instanceof Error ? err.message : String(err), context: `startup cleanup: setStatus idle for agent ${entry.agent_id}`, fatal: false });
          });
          await this.forceTaskCancelled(taskId);
          await this.deps.runService.finish(entry.run_id, 'cancelled', undefined, 'Orchestrator restarted').catch((err) => {
            this.deps.eventBus.emit({ type: 'orchestrator:error', error: err instanceof Error ? err.message : String(err), context: `startup cleanup: finish run ${entry.run_id}`, fatal: false });
          });
        }),
      );
    }

    // Always clear claimed — any claim that survived a restart is guaranteed stale
    // (the process that set it is dead). This fixes tasks stuck in "claimed" after crash.
    state.claimed = new Set<string>();

    // Phase 2: Cancel orphaned in_progress tasks — only when we detected a restart
    // (dead PIDs found). Without dead PIDs, orphans are handled by normal reconcile.
    if (cleanedTaskIds.size > 0) {
      const allTasks = await this.cachedTaskStore.list();
      const orphaned = allTasks.filter(
        (t) => t.status === 'in_progress' && !state.running[t.id],
      );
      if (orphaned.length > 0) {
        await Promise.all(orphaned.map((t) => this.forceTaskCancelled(t.id)));
      }

      const cancelledIds = new Set([...cleanedTaskIds, ...orphaned.map((t) => t.id)]);
      state.retry_queue = state.retry_queue.filter((r) => !cancelledIds.has(r.task_id));
      await this.saveState();
    }

    // Phase 3: Finalize orphaned 'preparing' runs — runs created but never started
    // (crash between runService.create() and runService.start()). These are invisible
    // to reconcile because they have no state.running entry.
    await this.cleanupOrphanedPreparingRuns();
  }

  /**
   * Find runs stuck in 'preparing' status (orphaned by a crash before adapter.execute)
   * and mark them as cancelled. Called once at startup.
   */
  private async cleanupOrphanedPreparingRuns(): Promise<void> {
    try {
      const allRuns = await this.deps.runStore.listAll();
      const preparingRuns = allRuns.filter((r) => r.status === 'preparing');
      if (preparingRuns.length === 0) return;

      // Currently active runs (in state.running) may legitimately be in 'preparing'
      // for a brief moment during the current process — exclude them
      const activeRunIds = new Set(
        Object.values(this.state!.running).map((e) => e.run_id),
      );

      const orphaned = preparingRuns.filter((r) => !activeRunIds.has(r.id));
      if (orphaned.length === 0) return;

      await Promise.all(
        orphaned.map((run) =>
          this.deps.runService.finish(run.id, 'cancelled', undefined, 'Orphaned preparing run (orchestrator restarted)').catch((err) => {
            this.deps.eventBus.emit({
              type: 'orchestrator:error',
              error: err instanceof Error ? err.message : String(err),
              context: `startup cleanup: finish orphaned preparing run ${run.id}`,
              fatal: false,
            });
          }),
        ),
      );
    } catch (err) {
      this.deps.eventBus.emit({
        type: 'orchestrator:error',
        error: err instanceof Error ? err.message : String(err),
        context: 'startup cleanup: cleanupOrphanedPreparingRuns',
        fatal: false,
      });
    }
  }

  /** Cancel a task, falling back to direct store write if transition is invalid. */
  private async forceTaskCancelled(taskId: string): Promise<void> {
    try {
      await this.deps.taskService.updateStatus(taskId, 'cancelled');
    } catch {
      const task = await this.deps.taskStore.get(taskId);
      if (task && !isTerminal(task.status)) {
        task.status = 'cancelled';
        task.updated_at = new Date().toISOString();
        await this.deps.taskStore.save(task).catch((err) => {
          this.deps.eventBus.emit({ type: 'orchestrator:error', error: err instanceof Error ? err.message : String(err), context: `startup cleanup: force-cancel task ${taskId}`, fatal: false });
        });
      }
    }
  }

  private async saveState(): Promise<void> {
    if (this.state) {
      await this.deps.stateStore.write(this.state);
    }
  }

  /**
   * Debounced saveState — batches rapid writes within 500ms window.
   * Used for non-critical updates like last_event_at in collectEvents.
   */
  private saveStateLazy(): void {
    this.saveStateDirty = true;
    if (this.saveStateTimer) return; // already scheduled
    this.saveStateTimer = setTimeout(() => {
      this.saveStateTimer = null;
      if (this.saveStateDirty) {
        this.saveStateDirty = false;
        this.saveState().catch((err) => {
          this.deps.eventBus.emit({
            type: 'orchestrator:error',
            error: err instanceof Error ? err.message : String(err),
            context: 'debounced state save',
            fatal: false,
          });
        });
      }
    }, 500);
  }

  /**
   * Flush any pending debounced saveState immediately.
   * Call before critical transitions to ensure state is persisted.
   */
  private async flushStateLazy(): Promise<void> {
    if (this.saveStateTimer) {
      clearTimeout(this.saveStateTimer);
      this.saveStateTimer = null;
    }
    if (this.saveStateDirty) {
      this.saveStateDirty = false;
      await this.saveState();
    }
  }
}

/** Check if a string is a valid ISO 8601 timestamp. */
function isValidISOTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const d = new Date(value);
  return !isNaN(d.getTime()) && d.toISOString() === value;
}

/**
 * Serialize event data to a string, truncating if it exceeds maxLen.
 * Always returns a string — avoids double-stringify by callers (appendJsonl, event bus).
 */
function serializeEventData(data: unknown, maxLen: number): string {
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  return str.length > maxLen ? str.slice(0, maxLen) + '…' : str;
}
