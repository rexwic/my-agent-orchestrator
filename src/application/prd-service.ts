/**
 * PrdService — versioned PRDs and the PM's drafting tasks.
 *
 * `startDraft` gives the PM role a task to write (or update) a PRD; the PM
 * hands it in with `orch prd add`. When that task's run ends with a version
 * handed in, a plan is started from it if there is a planner role, so a human
 * sees the PRD and the plan together when approving the plan.
 */

import { customAlphabet } from 'nanoid';
import type { OrchestratorConfig } from '../domain/config.js';
import { InvalidArgumentsError } from '../domain/errors.js';
import {
  DEFAULT_PM_ROLE,
  MAX_PRD_IN_PROMPT,
  PRD_DRAFT_LABEL,
  prdNameFrom,
  validatePrdContent,
  validatePrdName,
  type PrdVersion,
} from '../domain/prd.js';
import type { Task } from '../domain/task.js';
import type { IPrdStore, IRoleStore } from '../infrastructure/storage/interfaces.js';
import type { EventBus } from './event-bus.js';
import type { PlanService } from './plan-service.js';
import type { TaskService } from './task-service.js';

const suffix = customAlphabet('abcdefghijkmnpqrstuvwxyz23456789', 5);

const PM_ROLE_HINT = 'Create one, e.g.: orch role add pm --adapter claude --model opus -d "Product manager: writes the PRD, answers the team\'s questions"';

export interface PrdServiceDeps {
  store: IPrdStore;
  taskService: TaskService;
  roleStore: IRoleStore;
  eventBus: EventBus;
  config: OrchestratorConfig;
  /** Starts a plan from a drafted PRD (when there is a planner role). */
  planService?: PlanService;
}

export interface AddPrdInput {
  name: string;
  content: string;
  /** Agent name, or "human" (default). */
  createdBy?: string;
  note?: string;
  /** Task of the agent that wrote it. */
  taskId?: string;
}

export interface PrdSummary {
  name: string;
  latest: PrdVersion;
  versions: number;
  unseen: number;
}

/** What a task's prompt gets about the PRD it implements, or the one it drafts. */
export interface PrdPromptContext {
  name: string;
  /** Latest version (0 when drafting the first one). */
  version: number;
  content?: string;
  truncated?: boolean;
  /** Drafting task: the version it must hand in. */
  drafting?: { next_version: number };
}

export class PrdService {
  constructor(private readonly deps: PrdServiceDeps) {}

  get pmRole(): string {
    return this.deps.config.pm?.role || DEFAULT_PM_ROLE;
  }

  async hasPmRole(): Promise<boolean> {
    return Boolean(await this.deps.roleStore.get(this.pmRole).catch(() => null));
  }

  async add(input: AddPrdInput): Promise<PrdVersion> {
    const name = validatePrdName(input.name);
    const content = validatePrdContent(input.content);
    const versions = await this.deps.store.versions(name);
    const latest = versions.at(-1);
    if (latest && latest.content === content) {
      throw new InvalidArgumentsError(`${name} v${latest.version} already has this content`);
    }
    const by = input.createdBy?.trim() || 'human';
    // A draft is reviewed with the plan made from it; later agent versions are changes to tell a human about.
    const fromDraft = input.taskId ? (await this.deps.taskService.get(input.taskId).catch(() => null))?.prd_draft === name : false;
    const v: PrdVersion = {
      name,
      version: (latest?.version ?? 0) + 1,
      content,
      created_by: by,
      created_at: new Date().toISOString(),
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
      ...(input.taskId ? { task_id: input.taskId } : {}),
      seen: by === 'human' || fromDraft,
    };
    await this.deps.store.save(v);
    this.deps.eventBus.emit({ type: 'prd:versioned', name, version: v.version, by, ...(v.note ? { note: v.note } : {}) });
    return v;
  }

  /** A version (default: the latest). */
  async get(name: string, version?: number): Promise<PrdVersion> {
    const v = version !== undefined
      ? await this.deps.store.get(name, version)
      : (await this.deps.store.versions(name)).at(-1) ?? null;
    if (!v) {
      throw new InvalidArgumentsError(
        version !== undefined ? `${name} has no version ${version}` : `No PRD named "${name}"`,
        'List them with: orch prd list',
      );
    }
    return v;
  }

  async latest(name: string): Promise<PrdVersion | null> {
    return (await this.deps.store.versions(name)).at(-1) ?? null;
  }

  versions(name: string): Promise<PrdVersion[]> {
    return this.deps.store.versions(name);
  }

  async list(): Promise<PrdSummary[]> {
    const names = await this.deps.store.names();
    const out = await Promise.all(names.map(async (name) => {
      const versions = await this.deps.store.versions(name);
      const latest = versions.at(-1);
      return latest ? { name, latest, versions: versions.length, unseen: versions.filter((v) => !v.seen).length } : null;
    }));
    return out.filter((s): s is PrdSummary => s !== null);
  }

  /** Versions written by agents that a human has not looked at yet. */
  async unseen(): Promise<PrdVersion[]> {
    const all = await Promise.all((await this.deps.store.names()).map((n) => this.deps.store.versions(n)));
    return all.flat().filter((v) => !v.seen);
  }

  /** A human looked at these versions (default: all of the PRD). */
  async markSeen(name: string, upTo?: number): Promise<void> {
    for (const v of await this.deps.store.versions(name)) {
      if (!v.seen && (upTo === undefined || v.version <= upTo)) await this.deps.store.save({ ...v, seen: true });
    }
  }

  /**
   * Done tasks that implement the PRD and finished before `version` existed
   * (so they were built on an older version), oldest first.
   */
  async doneBefore(name: string, version: number): Promise<Task[]> {
    const v = await this.deps.store.get(name, version);
    if (!v) return [];
    return (await this.deps.taskService.list({ status: 'done' }))
      .filter((t) => t.prd === name && t.updated_at < v.created_at)
      .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  }

  /**
   * Requirement for planning only what changed in the PRD since `since`: the
   * changes, the done tasks built on an older version, and the whole latest PRD.
   * `diff` is the text diff of v`since` → latest (made by the caller).
   */
  async changeRequirement(name: string, since: number, diff: string): Promise<{ requirement: string; latest: PrdVersion; done: Task[] }> {
    const latest = await this.get(name);
    await this.get(name, since);
    if (since >= latest.version) {
      throw new InvalidArgumentsError(`${name} has no version after v${since} (latest: v${latest.version})`);
    }
    const done = await this.doneBefore(name, since + 1);
    const requirement = [
      `PRD ${name} changed since v${since} (now v${latest.version}). Plan only the work these changes need: the tasks listed below are done and were built on an older version — change them only where the PRD now asks for something else (read their delivery reports with \`orch task show <id>\`).`,
      '',
      `## Changes (v${since} → v${latest.version})`,
      '~~~~diff',
      diff.trim(),
      '~~~~',
      '',
      '## Done tasks built on an older version',
      ...(done.length ? done.map((t) => `- ${t.id} ${t.title}`) : ['(none)']),
      '',
      `## The whole PRD (v${latest.version})`,
      latest.content,
    ].join('\n');
    return { requirement, latest, done };
  }

  /** Give the PM a task to write a PRD (or the next version of an existing one). */
  async startDraft(input: { requirement: string; name?: string; title?: string }): Promise<{ name: string; task: Task }> {
    const requirement = input.requirement.trim();
    if (!requirement) throw new InvalidArgumentsError('Describe the requirement for the PRD');
    if (!(await this.hasPmRole())) throw new InvalidArgumentsError(`There is no "${this.pmRole}" role to write the PRD`, PM_ROLE_HINT);
    const name = input.name ? validatePrdName(input.name) : prdNameFrom(requirement, suffix());
    const latest = await this.latest(name);
    const title = input.title?.trim() || requirement.split(/\r?\n/).map((l) => l.trim()).find(Boolean)!.slice(0, 60);
    const task = await this.deps.taskService.create({
      title: `PRD: ${title}${latest ? ` (v${latest.version + 1})` : ''}`,
      description: requirement,
      role: this.pmRole,
      labels: [PRD_DRAFT_LABEL],
      review_criteria: [],
      prd_draft: name,
    });
    return { name, task };
  }

  /** A drafting task's run is done once it handed in a version. */
  async draftOutcome(task: Task): Promise<'submitted' | 'missing'> {
    if (!task.prd_draft) return 'missing';
    const versions = await this.deps.store.versions(task.prd_draft);
    return versions.some((v) => v.task_id === task.id) ? 'submitted' : 'missing';
  }

  /**
   * The drafting task finished: plan the latest version if there is a planner
   * role. Returns the plan ID, if one was started.
   */
  async draftFinished(task: Task): Promise<string | undefined> {
    if (!task.prd_draft || !this.deps.planService) return undefined;
    const latest = await this.latest(task.prd_draft);
    if (!latest) return undefined;
    const plannerRole = this.deps.config.planner?.role || 'planner';
    if (!(await this.deps.roleStore.get(plannerRole).catch(() => null))) return undefined;
    const { plan } = await this.deps.planService.start({
      requirement: latest.content,
      title: task.title.replace(/^PRD: /, '').replace(/ \(v\d+\)$/, ''),
      prd: { name: latest.name, version: latest.version },
    });
    return plan.id;
  }

  /** PRD section of a prompt: the PRD a task implements (task.prd) or drafts (task.prd_draft). */
  async promptContext(task: Task): Promise<PrdPromptContext | undefined> {
    const name = task.prd_draft ?? task.prd;
    if (!name) return undefined;
    const latest = await this.latest(name);
    if (task.prd_draft) {
      return {
        name,
        version: latest?.version ?? 0,
        ...(latest ? cut(latest.content) : {}),
        drafting: { next_version: (latest?.version ?? 0) + 1 },
      };
    }
    if (!latest) return undefined;
    return { name, version: latest.version, ...cut(latest.content) };
  }
}

function cut(content: string): { content: string; truncated?: boolean } {
  return content.length > MAX_PRD_IN_PROMPT
    ? { content: content.slice(0, MAX_PRD_IN_PROMPT), truncated: true }
    : { content };
}
