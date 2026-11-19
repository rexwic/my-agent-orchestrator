/**
 * RoleService — roles (.orchestry/roles/*.yml) and their agent instances.
 *
 * sync() makes the agents match the roles:
 *   - each role has exactly `replicas` agents named `<role>-<n>` (role_id = role);
 *   - every instance's adapter/config is overwritten from its role (no per-instance
 *     overrides — edit the role, or define another role);
 *   - surplus or orphaned instances are removed once idle (busy ones on a later sync);
 *   - agents of a role whose file fails validation are left untouched.
 * Agents without role_id are not managed.
 */

import { nanoid } from 'nanoid';
import type { Agent } from '../domain/agent.js';
import type { OrchestratorConfig } from '../domain/config.js';
import { InvalidArgumentsError } from '../domain/errors.js';
import {
  roleAgentConfig,
  roleAgentIndex,
  roleAgentName,
  validateRole,
  type CreateRoleInput,
  type Role,
} from '../domain/role.js';
import type { IAgentStore, IRoleStore, RoleLoadResult } from '../infrastructure/storage/interfaces.js';
import type { EventBus } from './event-bus.js';

export interface RoleSyncResult {
  created: string[];
  updated: string[];
  removed: string[];
  /** Surplus/orphaned instances still busy — removed on a later sync. */
  pendingRemoval: string[];
  errors: RoleLoadResult['errors'];
}

export class RoleService {
  constructor(
    private readonly roleStore: IRoleStore,
    private readonly agentStore: IAgentStore,
    private readonly eventBus: EventBus,
    private readonly config: OrchestratorConfig,
  ) {}

  async create(input: CreateRoleInput): Promise<{ role: Role; sync: RoleSyncResult }> {
    const role = validateRole({ replicas: 1, ...input });
    if (await this.roleStore.get(role.name).catch(() => null)) {
      throw new InvalidArgumentsError(`Role "${role.name}" already exists`);
    }
    await this.roleStore.save(role);
    return { role, sync: await this.sync() };
  }

  async get(name: string): Promise<Role> {
    const role = await this.roleStore.get(name);
    if (!role) throw new InvalidArgumentsError(`Unknown role "${name}". List roles with: orch role list`);
    return role;
  }

  load(): Promise<RoleLoadResult> {
    return this.roleStore.load();
  }

  async scale(name: string, replicas: number): Promise<{ role: Role; sync: RoleSyncResult }> {
    const role = validateRole({ ...(await this.get(name)), replicas });
    await this.roleStore.save(role);
    return { role, sync: await this.sync() };
  }

  async remove(name: string): Promise<RoleSyncResult> {
    await this.get(name);
    await this.roleStore.delete(name);
    return this.sync();
  }

  /**
   * Apply a role template: validate every role (and that `reviews` /
   * `bug_owners` name roles of the template or of the project), then save the
   * new ones; existing roles are kept unless `force`. All or nothing.
   */
  async applyTemplate(
    raw: Array<{ file: string; data: unknown }>,
    opts: { force?: boolean } = {},
  ): Promise<{ created: string[]; overwritten: string[]; skipped: string[]; sync: RoleSyncResult }> {
    const errors: string[] = [];
    const roles: Role[] = [];
    for (const { file, data } of raw) {
      try {
        roles.push(validateRole(data));
      } catch (err) {
        errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const dup = roles.map((r) => r.name).filter((n, i, all) => all.indexOf(n) !== i);
    if (dup.length) errors.push(`Defined twice: ${[...new Set(dup)].join(', ')}`);

    const existing = (await this.roleStore.list()).map((r) => r.name);
    const known = new Set([...existing, ...roles.map((r) => r.name)]);
    for (const r of roles) {
      for (const [field, names] of [['reviews', r.reviews], ['bug_owners', r.bug_owners]] as const) {
        for (const n of names ?? []) if (!known.has(n)) errors.push(`${r.name}: ${field} names "${n}", which is neither in the template nor an existing role`);
      }
    }
    if (errors.length) {
      throw new InvalidArgumentsError(`The template has ${errors.length} problem(s):\n  - ${errors.join('\n  - ')}`);
    }

    const result = { created: [] as string[], overwritten: [] as string[], skipped: [] as string[] };
    for (const role of roles) {
      const exists = existing.includes(role.name);
      if (exists && !opts.force) { result.skipped.push(role.name); continue; }
      await this.roleStore.save(role);
      (exists ? result.overwritten : result.created).push(role.name);
    }
    return { ...result, sync: await this.sync() };
  }

  /** Instances of a role (agents with role_id === name). */
  async instances(name: string): Promise<Agent[]> {
    return (await this.agentStore.list()).filter((a) => a.role_id === name);
  }

  async sync(): Promise<RoleSyncResult> {
    const { roles, errors } = await this.roleStore.load();
    const result: RoleSyncResult = { created: [], updated: [], removed: [], pendingRemoval: [], errors };
    const agents = await this.agentStore.list();
    const usedNames = new Set(agents.map((a) => a.name));
    const defaults = this.config.defaults.agent;

    // Roles whose file exists but is invalid: leave their agents alone.
    const invalidRoleNames = new Set(errors.map((e) => e.file.replace(/^roles\//, '').replace(/\.yml$/, '')));
    const roleNames = new Set(roles.map((r) => r.name));

    for (const role of roles) {
      const config = roleAgentConfig(role, defaults);
      const description = role.description ?? role.name;
      const instances = agents
        .filter((a) => a.role_id === role.name)
        .sort((a, b) => (roleAgentIndex(role.name, a.name) ?? Infinity) - (roleAgentIndex(role.name, b.name) ?? Infinity));

      // Apply the role's configuration to every instance.
      for (const agent of instances) {
        if (agent.adapter === role.adapter && agent.role === description && sameConfig(agent.config, config)) continue;
        agent.adapter = role.adapter;
        agent.role = description;
        agent.config = { ...config };
        await this.agentStore.save(agent);
        result.updated.push(agent.name);
      }

      // Scale up with the lowest free names.
      for (let n = 1, missing = role.replicas - instances.length; missing > 0; n++) {
        const name = roleAgentName(role.name, n);
        if (usedNames.has(name)) continue;
        const agent = newAgent(role, name, description, config);
        await this.agentStore.save(agent);
        usedNames.add(name);
        result.created.push(name);
        missing--;
      }

      // Scale down from the highest-numbered instances, idle ones only.
      if (instances.length > role.replicas) {
        const surplus = [...instances].reverse().slice(0, instances.length - role.replicas);
        await this.removeIdle(surplus, result);
      }
    }

    // Instances of deleted roles.
    const orphans = agents.filter((a) => a.role_id && !roleNames.has(a.role_id) && !invalidRoleNames.has(a.role_id));
    await this.removeIdle(orphans, result);

    if (result.created.length || result.updated.length || result.removed.length) {
      this.eventBus.emit({
        type: 'role:synced',
        created: result.created,
        updated: result.updated,
        removed: result.removed,
      });
    }
    return result;
  }

  private async removeIdle(agents: Agent[], result: RoleSyncResult): Promise<void> {
    for (const agent of agents) {
      if (agent.status === 'running' || agent.current_task) {
        result.pendingRemoval.push(agent.name);
        continue;
      }
      await this.agentStore.delete(agent.id);
      result.removed.push(agent.name);
    }
  }
}

function newAgent(role: Role, name: string, description: string, config: Agent['config']): Agent {
  return {
    id: `agt_${nanoid(7)}`,
    name,
    adapter: role.adapter,
    role: description,
    role_id: role.name,
    config: { ...config },
    status: 'idle',
    stats: { tasks_completed: 0, tasks_failed: 0, total_runs: 0, total_runtime_ms: 0 },
  };
}

/** Structural equality for agent configs (key order independent). */
function sameConfig(a: Agent['config'], b: Agent['config']): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
