/**
 * Dashboard state: everything the page shows, gathered from the services in
 * one call (GET /api/state, every few seconds).
 */

import type { LightContainer } from '../../container.js';
import type { Agent } from '../../domain/agent.js';
import type { Decision } from '../../domain/decision.js';
import type { Plan } from '../../domain/plan.js';
import type { Task } from '../../domain/task.js';
import { isTerminal } from '../../domain/transitions.js';

export interface DashboardAgent {
  id: string;
  name: string;
  status: Agent['status'];
  current_task?: string;
  current_task_title?: string;
}

export interface DashboardRole {
  name: string;
  description?: string;
  adapter: string;
  model?: string;
  effort?: string;
  replicas: number;
  agents: DashboardAgent[];
  /** Usage limit hit: no new work until `until`. */
  paused?: { until: string; reason: string };
}

export type TaskKind = 'work' | 'plan' | 'prd' | 'pm-answer';

export interface DashboardTask {
  id: string;
  title: string;
  status: Task['status'];
  kind: TaskKind;
  role?: string;
  agent?: string;
  priority: number;
  /** Titles of dependencies that are not done yet. */
  waiting_for: string[];
  send_backs: number;
  attempts: number;
  max_attempts: number;
  prd?: string;
  produces?: string[];
  uses?: string[];
  delivery?: { status: string; by: string; at: string };
  updated_at: string;
}

export interface DashboardDecision extends Decision {
  task_title?: string;
}

export interface DashboardPlan {
  id: string;
  title: string;
  status: Plan['status'];
  revision: number;
  decision_id?: string;
  prd?: { name: string; version: number };
  goal?: string;
  summary?: string;
  tasks: Array<{ key: string; title: string; role: string; depends_on: string[]; produces?: string[]; uses?: string[]; needs_decision?: boolean }>;
  created_tasks: number;
  feedback?: string;
  updated_at: string;
}

export interface DashboardPrd {
  name: string;
  latest: number;
  latest_by: string;
  latest_at: string;
  note?: string;
  /** Versions a human has not looked at. */
  unseen: number[];
}

export interface DashboardState {
  generated_at: string;
  project: string;
  orchestrator: { running: boolean; pid?: number; in_process: boolean; running_tasks: number };
  roles: DashboardRole[];
  /** Agents that belong to no role (made with orch agent add). */
  other_agents: DashboardAgent[];
  tasks: DashboardTask[];
  decisions: {
    /** Waiting for a human. */
    mine: DashboardDecision[];
    /** Held by a role (the PM) first. */
    with_roles: DashboardDecision[];
    /** Answered lately (newest first). */
    recent: DashboardDecision[];
  };
  plans: DashboardPlan[];
  prds: DashboardPrd[];
}

export interface StateOptions {
  /** Is an orchestrator running (and its pid)? */
  orchestrator: () => Promise<{ running: boolean; pid?: number; in_process: boolean }>;
  /** Answered decisions shown (default 10). */
  recentDecisions?: number;
}

function kindOf(t: Task): TaskKind {
  if (t.plan_id) return 'plan';
  if (t.prd_draft) return 'prd';
  if (t.triage_decision_id) return 'pm-answer';
  return 'work';
}

export async function buildDashboardState(c: LightContainer, opts: StateOptions): Promise<DashboardState> {
  const [tasks, agents, roles, decisions, plans, prds, pauses, orch] = await Promise.all([
    c.taskStore.list(),
    c.agentStore.list(),
    c.roleStore.list().catch(() => []),
    c.decisionService.list(),
    c.planService.list(),
    c.prdService.list().catch(() => []),
    c.quotaService.activePauses().catch(() => ({})),
    opts.orchestrator(),
  ]);
  const unseen = await c.prdService.unseen().catch(() => []);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const agentById = new Map(agents.map((a) => [a.id, a]));

  const toAgent = (a: Agent): DashboardAgent => ({
    id: a.id,
    name: a.name,
    status: a.status,
    ...(a.current_task ? { current_task: a.current_task, current_task_title: byId.get(a.current_task)?.title } : {}),
  });

  const pausedFor = (members: Agent[]): DashboardRole['paused'] => {
    for (const a of members) {
      const p = (pauses as Record<string, { until: string; reason: string }>)[c.quotaService.groupOf(a)];
      if (p) return { until: p.until, reason: p.reason };
    }
    return undefined;
  };

  const roleRows: DashboardRole[] = roles.map((r) => {
    const members = agents.filter((a) => a.role_id === r.name).sort((a, b) => a.name.localeCompare(b.name));
    const paused = pausedFor(members);
    return {
      name: r.name,
      ...(r.description ? { description: r.description } : {}),
      adapter: r.adapter,
      ...(r.model ? { model: r.model } : {}),
      ...(r.effort ? { effort: r.effort } : {}),
      replicas: r.replicas,
      agents: members.map(toAgent),
      ...(paused ? { paused } : {}),
    };
  });
  const roleNames = new Set(roles.map((r) => r.name));

  const deliveries = await Promise.all(tasks.map((t) => c.deliverableService.get(t.id).catch(() => null)));
  const taskRows: DashboardTask[] = tasks.map((t, i) => {
    const d = deliveries[i];
    const agent = t.assignee ? agentById.get(t.assignee) : undefined;
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      kind: kindOf(t),
      ...(t.role ? { role: t.role } : {}),
      ...(agent ? { agent: agent.name } : t.assignee ? { agent: t.assignee } : {}),
      priority: t.priority,
      waiting_for: isTerminal(t.status) ? [] : t.depends_on
        .map((id) => byId.get(id))
        .filter((dep): dep is Task => Boolean(dep) && dep!.status !== 'done')
        .map((dep) => dep.title),
      send_backs: t.send_backs ?? 0,
      attempts: t.attempts,
      max_attempts: t.max_attempts,
      ...(t.prd ? { prd: t.prd } : {}),
      ...(t.produces?.length ? { produces: t.produces } : {}),
      ...(t.uses?.length ? { uses: t.uses } : {}),
      ...(d ? { delivery: { status: d.status, by: d.submitted_by, at: d.submitted_at } } : {}),
      updated_at: t.updated_at,
    };
  });

  const withTitle = (d: Decision): DashboardDecision => ({ ...d, ...(d.task_id && byId.get(d.task_id) ? { task_title: byId.get(d.task_id)!.title } : {}) });
  const pending = decisions.filter((d) => d.status === 'pending');
  const recent = decisions
    .filter((d) => d.status === 'answered' && d.answer)
    .sort((a, b) => b.answer!.answered_at.localeCompare(a.answer!.answered_at))
    .slice(0, opts.recentDecisions ?? 10);

  const planRows: DashboardPlan[] = plans
    .filter((p) => p.status === 'planning' || p.status === 'awaiting_approval' || Date.now() - Date.parse(p.updated_at) < 7 * 24 * 3600_000)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .map((p) => ({
      id: p.id,
      title: p.title,
      status: p.status,
      revision: p.revision,
      ...(p.decision_id ? { decision_id: p.decision_id } : {}),
      ...(p.prd ? { prd: p.prd } : {}),
      ...(p.draft?.goal ? { goal: p.draft.goal } : {}),
      ...(p.draft?.summary ? { summary: p.draft.summary } : {}),
      tasks: (p.draft?.tasks ?? []).map((t) => ({
        key: t.key, title: t.title, role: t.role, depends_on: t.depends_on,
        ...(t.produces ? { produces: t.produces } : {}),
        ...(t.uses ? { uses: t.uses } : {}),
        ...(t.needs_decision ? { needs_decision: true } : {}),
      })),
      created_tasks: Object.keys(p.created_tasks ?? {}).length,
      ...(p.feedback ? { feedback: p.feedback } : {}),
      updated_at: p.updated_at,
    }));

  return {
    generated_at: new Date().toISOString(),
    project: c.config.project.name,
    orchestrator: { ...orch, running_tasks: tasks.filter((t) => t.status === 'in_progress').length },
    roles: roleRows,
    other_agents: agents.filter((a) => !a.role_id || !roleNames.has(a.role_id)).map(toAgent),
    tasks: taskRows,
    decisions: {
      mine: pending.filter((d) => !d.assignee).map(withTitle),
      with_roles: pending.filter((d) => d.assignee).map(withTitle),
      recent: recent.map(withTitle),
    },
    plans: planRows,
    prds: prds.map((p) => ({
      name: p.name,
      latest: p.latest.version,
      latest_by: p.latest.created_by,
      latest_at: p.latest.created_at,
      ...(p.latest.note ? { note: p.latest.note } : {}),
      unseen: unseen.filter((v) => v.name === p.name).map((v) => v.version),
    })),
  };
}
