/**
 * Storage layer interfaces.
 *
 * All persistence goes through these contracts.
 * Implementations use atomic file writes (temp → rename).
 * Services depend on interfaces, not concrete stores.
 */

import type { Agent } from '../../domain/agent.js';
import type { OrchestratorConfig } from '../../domain/config.js';
import type { Goal, GoalStatus } from '../../domain/goal.js';
import type { Message } from '../../domain/message.js';
import type { Run, RunEvent } from '../../domain/run.js';
import type { OrchestratorState } from '../../domain/state.js';
import type { Task, TaskStatus } from '../../domain/task.js';
import type { Team } from '../../domain/team.js';

export interface ITaskStore {
  list(filter?: { status?: TaskStatus; goalId?: string }): Promise<Task[]>;
  get(id: string): Promise<Task | null>;
  save(task: Task): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface IAgentStore {
  list(): Promise<Agent[]>;
  get(id: string): Promise<Agent | null>;
  getByName(name: string): Promise<Agent | null>;
  save(agent: Agent): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface IRunStore {
  save(run: Run): Promise<void>;
  get(id: string): Promise<Run | null>;
  listAll(): Promise<Run[]>;
  listForTask(taskId: string): Promise<Run[]>;
  listForAgent(agentId: string): Promise<Run[]>;
  appendEvent(runId: string, event: RunEvent): Promise<void>;
  readEvents(runId: string): Promise<RunEvent[]>;
  readEventsTail(runId: string, count: number): Promise<RunEvent[]>;
  streamEvents(runId: string, signal?: AbortSignal): AsyncGenerator<RunEvent>;
  closeRunEvents(runId: string): void;
}

export interface IStateStore {
  read(): Promise<OrchestratorState>;
  write(state: OrchestratorState): Promise<void>;
}

export interface RoleLoadResult {
  roles: import('../../domain/role.js').Role[];
  /** Role files that failed validation (not loaded). */
  errors: Array<{ file: string; message: string }>;
}

export interface IRoleStore {
  save(role: import('../../domain/role.js').Role): Promise<void>;
  get(name: string): Promise<import('../../domain/role.js').Role | null>;
  /** All valid roles plus validation errors for the invalid files. */
  load(): Promise<RoleLoadResult>;
  list(): Promise<import('../../domain/role.js').Role[]>;
  delete(name: string): Promise<void>;
}

export interface IDecisionStore {
  save(decision: import('../../domain/decision.js').Decision): Promise<void>;
  get(id: string): Promise<import('../../domain/decision.js').Decision | null>;
  /** All decisions, oldest first. */
  list(): Promise<import('../../domain/decision.js').Decision[]>;
}

export interface IPlanStore {
  save(plan: import('../../domain/plan.js').Plan): Promise<void>;
  get(id: string): Promise<import('../../domain/plan.js').Plan | null>;
  /** All plans, oldest first. */
  list(): Promise<import('../../domain/plan.js').Plan[]>;
}

export interface IQuotaStore {
  read(): Promise<import('../../domain/quota.js').QuotaState>;
  write(state: import('../../domain/quota.js').QuotaState): Promise<void>;
}

export interface IConfigStore {
  read(): Promise<OrchestratorConfig>;
  write(config: OrchestratorConfig): Promise<void>;
  get(keyPath: string): Promise<unknown>;
  set(keyPath: string, value: unknown): Promise<void>;
}

export interface ContextEntry {
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
  ttl_ms?: number;
  expires_at?: string;
}

export interface IContextStore {
  get(key: string): Promise<ContextEntry | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<ContextEntry[]>;
  getAll(): Promise<Record<string, string>>;
}

export interface IMessageStore {
  save(message: Message): Promise<void>;
  get(id: string): Promise<Message | null>;
  list(): Promise<Message[]>;
  listPending(agentId: string): Promise<Message[]>;
  markDelivered(id: string): Promise<void>;
  delete(id: string): Promise<void>;
  purgeExpired(): Promise<number>;
}

export interface IGoalStore {
  list(filter?: { status?: GoalStatus }): Promise<Goal[]>;
  get(id: string): Promise<Goal | null>;
  save(goal: Goal): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface ITeamStore {
  save(team: Team): Promise<void>;
  get(id: string): Promise<Team | null>;
  getByName(name: string): Promise<Team | null>;
  list(): Promise<Team[]>;
  delete(id: string): Promise<void>;
}
