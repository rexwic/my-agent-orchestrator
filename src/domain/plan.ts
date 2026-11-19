/**
 * Plan — a requirement broken into tasks by a planner agent, approved by a human.
 *
 * `orch plan new "<requirement>"` creates a planning task for the planner role.
 * The planner reads the code and submits a plan (`orch plan submit plan.yml`);
 * ORCH validates it and asks a human to approve it (a decision). Approving
 * creates a goal and every task of the plan (roles, dependencies, scopes,
 * review criteria). Sending it back with feedback starts a new planning task
 * (the next revision) that sees the previous plan and the feedback.
 *
 * Stored in .orchestry/plans/<id>.yml.
 */

import type { ReviewCriterion } from './task.js';

export type PlanStatus =
  /** The planner is working (or asked a question). */
  | 'planning'
  /** Submitted and valid; a human approves it, sends it back, or cancels it. */
  | 'awaiting_approval'
  /** Its tasks were created. */
  | 'approved'
  | 'cancelled';

/** Label on planning tasks. */
export const PLANNING_LABEL = 'planning' as const;

export const DEFAULT_MAX_PLAN_TASKS = 30;
export const DEFAULT_PLANNER_ROLE = 'planner';

export interface PlanTask {
  /** Name inside the plan, used by depends_on (e.g. "api-contract"). */
  key: string;
  title: string;
  role: string;
  /** What to do and how to tell it is done (acceptance criteria). */
  description: string;
  /** Keys of other tasks in the plan, or IDs of existing tasks. */
  depends_on: string[];
  scope?: string[];
  review_criteria?: ReviewCriterion[];
  priority?: number;
  /** A human confirms before the task starts (true, or the question to ask). */
  needs_decision?: boolean | string;
}

/** What the planner submits. */
export interface PlanDraft {
  goal: string;
  summary?: string;
  tasks: PlanTask[];
}

export interface Plan {
  id: string;
  status: PlanStatus;
  title: string;
  requirement: string;
  /** Role that plans. */
  role: string;
  /** 1 for the first plan; +1 every time a human sends it back. */
  revision: number;
  /** Current planning task (the latest revision). */
  planning_task_id: string;
  /** Planning tasks of all revisions, oldest first. */
  planning_task_ids: string[];
  /** Latest submitted plan. */
  draft?: PlanDraft;
  submitted_at?: string;
  submitted_by?: string;
  /** The approval decision for the latest submission. */
  decision_id?: string;
  /** Feedback of the last send-back (shown to the next planner). */
  feedback?: string;
  goal_id?: string;
  /** Plan key → created task ID (filled while approving). */
  created_tasks?: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export interface PlanValidationContext {
  /** Roles tasks may be assigned to. */
  roles: readonly string[];
  /** IDs of existing tasks a plan task may depend on. */
  existingTaskIds: ReadonlySet<string>;
  maxTasks: number;
}

export interface PlanValidation {
  /** Present only when there are no errors. */
  draft?: PlanDraft;
  errors: string[];
  /** Not blocking (e.g. parallel tasks with overlapping scope). */
  warnings: string[];
}

const PLAN_KEYS = ['goal', 'summary', 'tasks'] as const;
const TASK_KEYS = ['key', 'title', 'role', 'description', 'depends_on', 'scope', 'review_criteria', 'priority', 'needs_decision'] as const;
const CRITERIA: readonly ReviewCriterion[] = ['test_pass', 'typecheck', 'lint'];
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 20_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A string or a list of strings (a single string is accepted for convenience). */
function stringList(value: unknown, where: string, errors: string[]): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const list = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list) || list.some((v) => typeof v !== 'string')) {
    errors.push(`${where} must be a list of strings`);
    return undefined;
  }
  return (list as string[]).map((s) => s.trim()).filter(Boolean);
}

/**
 * Validate a submitted plan (parsed YAML/JSON). Every problem is reported so
 * the planner can fix them in one go.
 */
export function validatePlanDraft(raw: unknown, ctx: PlanValidationContext): PlanValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isRecord(raw)) {
    return { errors: ['The plan must be a map with goal, summary and tasks'], warnings };
  }
  for (const k of Object.keys(raw)) {
    if (!(PLAN_KEYS as readonly string[]).includes(k)) errors.push(`Unknown field "${k}" (allowed: ${PLAN_KEYS.join(', ')})`);
  }

  const goal = typeof raw['goal'] === 'string' ? raw['goal'].trim() : '';
  if (!goal) errors.push('goal is required (one line: what the plan achieves)');
  else if (goal.length > MAX_TITLE) errors.push(`goal is too long (max ${MAX_TITLE} characters)`);

  let summary: string | undefined;
  if (raw['summary'] !== undefined && raw['summary'] !== null) {
    if (typeof raw['summary'] !== 'string') errors.push('summary must be a string');
    else summary = raw['summary'].trim() || undefined;
  }

  const rawTasks = raw['tasks'];
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    errors.push('tasks must be a non-empty list');
    return { errors, warnings };
  }
  if (rawTasks.length > ctx.maxTasks) {
    errors.push(`Too many tasks: ${rawTasks.length} (max ${ctx.maxTasks}). Make tasks bigger or plan a first phase only`);
  }

  const tasks: PlanTask[] = [];
  const keys = new Set<string>();
  rawTasks.forEach((item, i) => {
    const label = isRecord(item) && typeof item['key'] === 'string' && item['key'] ? `tasks[${i}] (${item['key']})` : `tasks[${i}]`;
    if (!isRecord(item)) { errors.push(`${label} must be a map`); return; }
    for (const k of Object.keys(item)) {
      if (!(TASK_KEYS as readonly string[]).includes(k)) errors.push(`${label}: unknown field "${k}" (allowed: ${TASK_KEYS.join(', ')})`);
    }

    const key = typeof item['key'] === 'string' ? item['key'].trim() : '';
    if (!key) errors.push(`${label}: key is required`);
    else if (!KEY_PATTERN.test(key)) errors.push(`${label}: key must be letters, digits, ".", "_" or "-" (max 64)`);
    else if (key.startsWith('tsk_')) errors.push(`${label}: key must not start with "tsk_" (reserved for task IDs)`);
    else if (keys.has(key)) errors.push(`${label}: duplicate key "${key}"`);
    keys.add(key);

    const title = typeof item['title'] === 'string' ? item['title'].trim() : '';
    if (!title) errors.push(`${label}: title is required`);
    else if (title.length > MAX_TITLE) errors.push(`${label}: title is too long (max ${MAX_TITLE})`);

    const role = typeof item['role'] === 'string' ? item['role'].trim() : '';
    if (!role) errors.push(`${label}: role is required (one of: ${ctx.roles.join(', ') || 'none defined'})`);
    else if (!ctx.roles.includes(role)) errors.push(`${label}: role "${role}" does not exist (roles: ${ctx.roles.join(', ') || 'none'})`);

    const description = typeof item['description'] === 'string' ? item['description'].trim() : '';
    if (!description) errors.push(`${label}: description is required (what to do and its acceptance criteria)`);
    else if (description.length > MAX_DESCRIPTION) errors.push(`${label}: description is too long (max ${MAX_DESCRIPTION})`);

    const dependsOn = stringList(item['depends_on'], `${label}: depends_on`, errors) ?? [];

    let scope = stringList(item['scope'], `${label}: scope`, errors);
    if (scope) {
      scope = scope.map((s) => s.replace(/\\/g, '/').replace(/^\.\//, ''));
      for (const s of scope) {
        if (s.startsWith('/') || /^[A-Za-z]:/.test(s) || s.split('/').includes('..')) {
          errors.push(`${label}: scope "${s}" must be a path relative to the project root`);
        }
      }
    }

    const criteria = stringList(item['review_criteria'], `${label}: review_criteria`, errors);
    if (criteria?.some((c) => !CRITERIA.includes(c as ReviewCriterion))) {
      errors.push(`${label}: review_criteria must be among ${CRITERIA.join(', ')}`);
    }

    let priority: number | undefined;
    if (item['priority'] !== undefined && item['priority'] !== null) {
      const p = item['priority'];
      if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 4) errors.push(`${label}: priority must be an integer 1-4 (1 = most urgent)`);
      else priority = p;
    }

    let needsDecision: boolean | string | undefined;
    const nd = item['needs_decision'];
    if (nd !== undefined && nd !== null && nd !== false) {
      if (nd === true) needsDecision = true;
      else if (typeof nd === 'string' && nd.trim()) needsDecision = nd.trim();
      else errors.push(`${label}: needs_decision must be true or the question to ask`);
    }

    tasks.push({
      key,
      title,
      role,
      description,
      depends_on: [...new Set(dependsOn)],
      ...(scope?.length ? { scope } : {}),
      ...(criteria?.length ? { review_criteria: criteria as ReviewCriterion[] } : {}),
      ...(priority !== undefined ? { priority } : {}),
      ...(needsDecision !== undefined ? { needs_decision: needsDecision } : {}),
    });
  });

  // Dependencies: other keys in the plan or existing tasks; no cycles.
  for (const t of tasks) {
    for (const dep of t.depends_on) {
      if (dep === t.key) errors.push(`${t.key}: depends on itself`);
      else if (!keys.has(dep) && !ctx.existingTaskIds.has(dep)) {
        errors.push(`${t.key}: depends_on "${dep}" is neither a key in this plan nor an existing task ID`);
      }
    }
  }
  if (!errors.length) {
    const cycle = findCycle(tasks);
    if (cycle) errors.push(`Dependency cycle (→ = depends on): ${cycle.join(' → ')}`);
  }

  if (errors.length) return { errors, warnings };

  // Parallel tasks (neither depends on the other) that may touch the same files.
  const reach = reachability(tasks);
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i]!;
      const b = tasks[j]!;
      if (reach.get(a.key)!.has(b.key) || reach.get(b.key)!.has(a.key)) continue;
      const shared = overlappingPatterns(a.scope, b.scope);
      if (shared) {
        warnings.push(`${a.key} and ${b.key} can run in parallel but their scopes overlap (${shared}); ORCH runs them one after the other`);
      }
    }
  }

  return { draft: { goal, ...(summary ? { summary } : {}), tasks }, errors, warnings };
}

/** Tasks ordered so that every task comes after the plan tasks it depends on. */
export function planTaskOrder(tasks: readonly PlanTask[]): PlanTask[] {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const done = new Set<string>();
  const order: PlanTask[] = [];
  const visit = (t: PlanTask, path: Set<string>): void => {
    if (done.has(t.key) || path.has(t.key)) return;
    path.add(t.key);
    for (const dep of t.depends_on) {
      const d = byKey.get(dep);
      if (d) visit(d, path);
    }
    path.delete(t.key);
    done.add(t.key);
    order.push(t);
  };
  for (const t of tasks) visit(t, new Set());
  return order;
}

function findCycle(tasks: readonly PlanTask[]): string[] | null {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (key: string): string[] | null => {
    const s = state.get(key);
    if (s === 'done') return null;
    if (s === 'visiting') return [...stack.slice(stack.indexOf(key)), key];
    state.set(key, 'visiting');
    stack.push(key);
    for (const dep of byKey.get(key)?.depends_on ?? []) {
      if (!byKey.has(dep)) continue;
      const found = visit(dep);
      if (found) return found;
    }
    stack.pop();
    state.set(key, 'done');
    return null;
  };
  for (const t of tasks) {
    const found = visit(t.key);
    if (found) return found;
  }
  return null;
}

/** key → every plan key it (transitively) depends on. */
function reachability(tasks: readonly PlanTask[]): Map<string, Set<string>> {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const memo = new Map<string, Set<string>>();
  const deps = (key: string): Set<string> => {
    const cached = memo.get(key);
    if (cached) return cached;
    const all = new Set<string>();
    memo.set(key, all);
    for (const d of byKey.get(key)?.depends_on ?? []) {
      if (!byKey.has(d)) continue;
      all.add(d);
      for (const x of deps(d)) all.add(x);
    }
    return all;
  };
  for (const t of tasks) deps(t.key);
  return memo;
}

function overlappingPatterns(a?: string[], b?: string[]): string | null {
  if (!a?.length || !b?.length) return null;
  for (const pa of a) {
    for (const pb of b) {
      const baseA = pa.split('*')[0]!;
      const baseB = pb.split('*')[0]!;
      if (pa === pb || baseA.startsWith(baseB) || baseB.startsWith(baseA)) return pa === pb ? pa : `${pa} / ${pb}`;
    }
  }
  return null;
}

/** Short title from a requirement: its first non-empty line, shortened. */
export function planTitle(requirement: string, max = 60): string {
  const first = requirement.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}
