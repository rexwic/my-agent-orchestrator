/**
 * Role domain model.
 *
 * A Role is the single source of configuration for a kind of worker
 * (e.g. "backend": Claude Sonnet, high effort, 2 replicas). ORCH keeps
 * `replicas` agents per role (`backend-1`, `backend-2`, …) and overwrites
 * their configuration from the role on every sync — instances cannot
 * override it; to run a different model, define another role.
 *
 * Stored in .orchestry/roles/<name>.yml.
 */

import type { AgentConfig, ApprovalPolicy, ReasoningEffort } from './agent.js';
import type { ReviewCriterion, WorkspaceMode } from './task.js';
import { InvalidArgumentsError } from './errors.js';

export interface RoleTaskDefaults {
  /** Applied to tasks created for this role that don't set their own. */
  review_criteria?: ReviewCriterion[];
  max_attempts?: number;
  priority?: number;
}

export interface Role {
  name: string;
  description?: string;
  adapter: string;
  model?: string;
  effort?: ReasoningEffort;
  /** Number of agents kept for this role. */
  replicas: number;
  system_prompt?: string;
  skills?: string[];
  env?: Record<string, string>;
  quota_group?: string;
  approval_policy?: ApprovalPolicy;
  workspace_mode?: WorkspaceMode;
  max_turns?: number;
  timeout_ms?: number;
  stall_timeout_ms?: number;
  /** Shell adapter only. */
  command?: string;
  task_defaults?: RoleTaskDefaults;
}

export type CreateRoleInput = Omit<Role, 'replicas'> & { replicas?: number };

/** Role names become agent name prefixes and file names. */
export const ROLE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
export const MAX_REPLICAS = 20;

const EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high'];
const POLICIES: readonly ApprovalPolicy[] = ['suggest', 'auto', 'manual'];
const WORKSPACE_MODES: readonly WorkspaceMode[] = ['shared', 'worktree', 'isolated'];
const CRITERIA: readonly ReviewCriterion[] = ['test_pass', 'typecheck', 'lint'];

/** Agent name of the n-th (1-based) instance of a role. */
export function roleAgentName(role: string, index: number): string {
  return `${role}-${index}`;
}

/** 1-based instance index from an agent name, or null if it doesn't follow `<role>-<n>`. */
export function roleAgentIndex(role: string, agentName: string): number | null {
  const prefix = `${role}-`;
  if (!agentName.startsWith(prefix)) return null;
  const n = Number(agentName.slice(prefix.length));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Agent configuration derived from a role. `defaults` fills what the role
 * leaves unset (the project's agent defaults).
 */
export function roleAgentConfig(
  role: Role,
  defaults: { approval_policy: ApprovalPolicy; max_turns: number; timeout_ms: number; stall_timeout_ms: number },
): AgentConfig {
  const isShell = role.adapter === 'shell';
  const config: AgentConfig = {
    approval_policy: role.approval_policy ?? (isShell ? 'auto' : defaults.approval_policy),
    max_turns: role.max_turns ?? defaults.max_turns,
    timeout_ms: role.timeout_ms ?? defaults.timeout_ms,
    stall_timeout_ms: role.stall_timeout_ms ?? defaults.stall_timeout_ms,
  };
  if (isShell && role.command) config.command = role.command;
  if (!isShell && role.model) config.model = role.model;
  if (!isShell && role.effort) config.effort = role.effort;
  if (role.env && Object.keys(role.env).length > 0) config.env = { ...role.env };
  if (role.system_prompt) config.system_prompt = role.system_prompt;
  if (role.workspace_mode) config.workspace_mode = role.workspace_mode;
  if (role.skills?.length) config.skills = [...role.skills];
  if (role.quota_group) config.quota_group = role.quota_group;
  return config;
}

/**
 * Validate and normalise a role read from YAML or built from CLI input.
 * Throws InvalidArgumentsError with every problem found.
 */
export function validateRole(raw: unknown, expectedName?: string): Role {
  const errors: string[] = [];
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const str = (key: string): string | undefined => {
    const v = r[key];
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string') { errors.push(`${key} must be a string`); return undefined; }
    return v.trim() || undefined;
  };
  const posInt = (key: string, value: unknown): number | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) { errors.push(`${key} must be a non-negative integer`); return undefined; }
    return value;
  };
  const oneOf = <T extends string>(key: string, allowed: readonly T[]): T | undefined => {
    const v = str(key);
    if (v !== undefined && !allowed.includes(v as T)) { errors.push(`${key} must be one of ${allowed.join(', ')}`); return undefined; }
    return v as T | undefined;
  };

  const name = str('name');
  if (!name) errors.push('name is required');
  else if (!ROLE_NAME_PATTERN.test(name)) errors.push(`name "${name}" must be lowercase letters, digits and hyphens, starting with a letter`);
  if (expectedName && name && name !== expectedName) errors.push(`name "${name}" does not match file name "${expectedName}"`);

  const adapter = str('adapter');
  if (!adapter) errors.push('adapter is required');

  const replicas = posInt('replicas', r['replicas'] ?? 1);
  if (replicas !== undefined && replicas > MAX_REPLICAS) errors.push(`replicas must be at most ${MAX_REPLICAS}`);

  const command = str('command');
  if (adapter === 'shell' && !command) errors.push('shell roles require a command');

  let env: Record<string, string> | undefined;
  if (r['env'] !== undefined && r['env'] !== null) {
    if (typeof r['env'] !== 'object' || Array.isArray(r['env'])) errors.push('env must be a map of strings');
    else {
      env = {};
      for (const [k, v] of Object.entries(r['env'] as Record<string, unknown>)) {
        if (typeof v !== 'string') errors.push(`env.${k} must be a string`);
        else env[k] = v;
      }
    }
  }

  let skills: string[] | undefined;
  if (r['skills'] !== undefined && r['skills'] !== null) {
    if (!Array.isArray(r['skills']) || r['skills'].some((s) => typeof s !== 'string')) errors.push('skills must be a list of strings');
    else skills = (r['skills'] as string[]).map((s) => s.trim()).filter(Boolean);
  }

  let taskDefaults: RoleTaskDefaults | undefined;
  const td = r['task_defaults'];
  if (td !== undefined && td !== null) {
    if (typeof td !== 'object' || Array.isArray(td)) errors.push('task_defaults must be a map');
    else {
      const t = td as Record<string, unknown>;
      taskDefaults = {};
      if (t['review_criteria'] !== undefined) {
        const rc = t['review_criteria'];
        if (!Array.isArray(rc) || rc.some((c) => !CRITERIA.includes(c as ReviewCriterion))) {
          errors.push(`task_defaults.review_criteria must be a list of ${CRITERIA.join(', ')}`);
        } else taskDefaults.review_criteria = rc as ReviewCriterion[];
      }
      const ma = posInt('task_defaults.max_attempts', t['max_attempts']);
      if (ma !== undefined) taskDefaults.max_attempts = ma;
      const pr = posInt('task_defaults.priority', t['priority']);
      if (pr !== undefined) taskDefaults.priority = pr;
    }
  }

  const role: Role = {
    name: name ?? '',
    adapter: adapter ?? '',
    replicas: replicas ?? 1,
  };
  const description = str('description'); if (description) role.description = description;
  const model = str('model'); if (model) role.model = model;
  const effort = oneOf('effort', EFFORTS); if (effort) role.effort = effort;
  const systemPrompt = typeof r['system_prompt'] === 'string' && r['system_prompt'].trim() ? r['system_prompt'] : str('system_prompt');
  if (systemPrompt) role.system_prompt = systemPrompt;
  if (skills?.length) role.skills = skills;
  if (env && Object.keys(env).length) role.env = env;
  const quotaGroup = str('quota_group'); if (quotaGroup) role.quota_group = quotaGroup;
  const policy = oneOf('approval_policy', POLICIES); if (policy) role.approval_policy = policy;
  const mode = oneOf('workspace_mode', WORKSPACE_MODES); if (mode) role.workspace_mode = mode;
  const maxTurns = posInt('max_turns', r['max_turns']); if (maxTurns !== undefined) role.max_turns = maxTurns;
  const timeout = posInt('timeout_ms', r['timeout_ms']); if (timeout !== undefined) role.timeout_ms = timeout;
  const stall = posInt('stall_timeout_ms', r['stall_timeout_ms']); if (stall !== undefined) role.stall_timeout_ms = stall;
  if (command) role.command = command;
  if (taskDefaults && Object.keys(taskDefaults).length) role.task_defaults = taskDefaults;

  if (errors.length) {
    throw new InvalidArgumentsError(`Invalid role${name ? ` "${name}"` : ''}: ${errors.join('; ')}`);
  }
  return role;
}
