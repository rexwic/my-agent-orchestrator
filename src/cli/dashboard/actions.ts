/**
 * Dashboard actions (POST /api/action) and details (task, PRD). They call the
 * same services as the CLI, so the same rules apply (e.g. a plan send-back
 * needs feedback, approving a task merges it through the orchestrator).
 */

import type { ApproveTaskOutcome } from '../../application/orchestrator.js';
import type { LightContainer } from '../../container.js';
import type { DecisionAction } from '../../domain/decision.js';
import { InvalidArgumentsError, WorkspaceError } from '../../domain/errors.js';
import { isTerminal } from '../../domain/transitions.js';
import { textDiff } from '../text-diff.js';

export type DashboardAction =
  | { type: 'decision_answer'; id: string; choice?: string; message?: string; action?: DecisionAction; project?: boolean }
  | { type: 'plan_approve'; id: string; message?: string }
  | { type: 'plan_reject'; id: string; message: string }
  | { type: 'plan_cancel'; id: string }
  | { type: 'prd_seen'; name: string; version: number }
  | { type: 'task_cancel'; id: string }
  | { type: 'task_approve'; id: string }
  | { type: 'task_reject'; id: string; message: string };

/** What needs the orchestrator (full container), created on demand. */
export interface OrchestratorOps {
  /** Integrate (sync, verify, merge) a task approved in review. */
  approveTask(taskId: string): Promise<ApproveTaskOutcome>;
  /** Cancel a running task (stops its agent). */
  cancelRunning(taskId: string): Promise<void>;
  /** Remove the worktree and branch of a task a human cancelled. */
  discardCancelledWork(taskId: string): Promise<void>;
}

const str = (v: unknown, field: string, required = true): string | undefined => {
  if (v === undefined || v === null || v === '') {
    if (required) throw new InvalidArgumentsError(`${field} is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new InvalidArgumentsError(`${field} must be a string`);
  return v;
};

/** Validate a request body into an action. */
export function parseAction(body: unknown): DashboardAction {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  switch (b['type']) {
    case 'decision_answer': {
      const action = str(b['action'], 'action', false) ?? 'continue';
      if (!['continue', 'approve', 'cancel'].includes(action)) throw new InvalidArgumentsError('action must be continue, approve or cancel');
      return {
        type: 'decision_answer', id: str(b['id'], 'id')!,
        ...(str(b['choice'], 'choice', false) ? { choice: str(b['choice'], 'choice', false)! } : {}),
        ...(str(b['message'], 'message', false) ? { message: str(b['message'], 'message', false)! } : {}),
        action: action as DecisionAction,
        project: b['project'] === true,
      };
    }
    case 'plan_approve': return { type: 'plan_approve', id: str(b['id'], 'id')!, ...(str(b['message'], 'message', false) ? { message: str(b['message'], 'message', false)! } : {}) };
    case 'plan_reject': return { type: 'plan_reject', id: str(b['id'], 'id')!, message: str(b['message'], 'feedback (message)')! };
    case 'plan_cancel': return { type: 'plan_cancel', id: str(b['id'], 'id')! };
    case 'task_cancel': return { type: 'task_cancel', id: str(b['id'], 'id')! };
    case 'task_approve': return { type: 'task_approve', id: str(b['id'], 'id')! };
    case 'task_reject': {
      const message = str(b['message'], 'reason (message)')!.trim();
      if (!message) throw new InvalidArgumentsError('reason (message) is required');
      return { type: 'task_reject', id: str(b['id'], 'id')!, message };
    }
    case 'prd_seen': {
      const version = Number(b['version']);
      if (!Number.isInteger(version) || version < 1) throw new InvalidArgumentsError('version must be a positive integer');
      return { type: 'prd_seen', name: str(b['name'], 'name')!, version };
    }
    default: throw new InvalidArgumentsError(`Unknown action "${String(b['type'])}"`);
  }
}

/** Run an action; returns a one-line result for the page. */
export async function runAction(c: LightContainer, action: DashboardAction, ops: () => Promise<OrchestratorOps>): Promise<string> {
  switch (action.type) {
    case 'decision_answer': {
      const r = await c.decisionService.answer(action.id, {
        ...(action.choice ? { choice: action.choice } : {}),
        ...(action.message ? { message: action.message } : {}),
        action: action.action ?? 'continue',
        scope: action.project ? 'project' : 'task',
      });
      if (r.decision.plan_id) {
        const plan = await c.planService.get(r.decision.plan_id);
        return plan.status === 'approved'
          ? `計畫 ${plan.id} 已核准，建立了 ${Object.keys(plan.created_tasks ?? {}).length} 個 task`
          : `計畫 ${plan.id}：${plan.status}`;
      }
      const taskId = r.decision.task_id;
      if (!taskId) return `已回答 ${action.id}`;
      if (r.stillPending > 0) return `已回答；task ${taskId} 還在等另外 ${r.stillPending} 張決策單`;
      if (!r.task) return `已回答；task ${taskId} 下次執行時會看到這個答案`;
      if (r.task.status === 'cancelled') {
        if (r.task.workspace) await (await ops()).discardCancelledWork(taskId);
        return `task ${taskId} 已取消${r.task.workspace ? '，worktree 與分支已刪除' : ''}`;
      }
      if (r.task.status === 'review' && r.task.approved) {
        return describeApproval(taskId, await (await ops()).approveTask(taskId));
      }
      return `已回答；task ${taskId} → ${r.task.status}`;
    }
    case 'plan_approve': {
      const plan = await c.planService.approve(action.id, action.message);
      return `計畫 ${plan.id} 已核准，建立了 ${Object.keys(plan.created_tasks ?? {}).length} 個 task`;
    }
    case 'plan_reject': {
      const plan = await c.planService.revise(action.id, action.message);
      return `計畫 ${plan.id} 已退回，planner 會做第 ${plan.revision} 版`;
    }
    case 'plan_cancel': {
      const plan = await c.planService.cancel(action.id);
      return `計畫 ${plan.id} 已取消`;
    }
    case 'prd_seen': {
      await c.prdService.markSeen(action.name, action.version);
      return `${action.name} v${action.version} 已標為看過`;
    }
    case 'task_cancel': {
      const task = await c.taskService.get(action.id);
      if (isTerminal(task.status)) throw new InvalidArgumentsError(`Task ${task.id} is already ${task.status}`);
      if (task.status === 'in_progress') {
        await (await ops()).cancelRunning(task.id);
      } else {
        await c.taskService.cancel(task.id);
        if (task.workspace) await (await ops()).discardCancelledWork(task.id);
      }
      return `task ${task.id} 已取消`;
    }
    case 'task_approve': {
      const task = await c.taskService.get(action.id);
      if (task.status !== 'review') throw new InvalidArgumentsError(`Task ${task.id} is ${task.status}, not in review`);
      const out = await (await ops()).approveTask(task.id);
      if (out.status === 'review') {
        throw new WorkspaceError(`無法合併 ${task.id}：${out.detail}`, 'task 留在審查中，worktree 保留。修好後再核准，或退回給 agent。');
      }
      return describeApproval(task.id, out);
    }
    case 'task_reject': {
      const task = await c.taskService.reject(action.id, action.message);
      return `task ${task.id} 已退回 → 待辦，agent 會依你的說明重做`;
    }
  }
}

const SEND_BACK_REASON: Record<string, string> = {
  conflict: '合併最新 main 時有衝突',
  review: '合併最新 main 後驗證失敗',
  contract: '它改了使用中的契約檔',
};

/** One line for the result of approving a task (same cases as `orch task approve`). */
export function describeApproval(taskId: string, out: ApproveTaskOutcome): string {
  switch (out.status) {
    case 'done': return `task ${taskId} 已核准並合併，完成`;
    case 'queued': return `task ${taskId} 已核准，執行中的 orchestrator 會同步、驗證並合併它`;
    case 'sent_back':
      return `task ${taskId} 已核准，但${SEND_BACK_REASON[out.reason] ?? out.reason}${out.files?.length ? `（${out.files.join(', ')}）` : ''}，已退回給 agent`;
    case 'waiting_decision': return `task ${taskId} 已核准，但退回次數到上限，等你回答決策單 ${out.decisionId}`;
    case 'deferred': return `task ${taskId} 已核准，還沒合併（${out.detail}），orchestrator 會再試`;
    case 'review': return `task ${taskId} 無法合併：${out.detail}（留在審查中）`;
    default: return `task ${taskId} 已核准 → ${out.status}`;
  }
}

/** A task with its delivery report and decisions (detail view). */
export async function taskDetail(c: LightContainer, id: string): Promise<unknown> {
  const task = await c.taskService.get(id);
  const [delivery, decisions] = await Promise.all([
    c.deliverableService.get(id).catch(() => null),
    c.decisionService.list({ taskId: id }),
  ]);
  return { task, delivery, decisions };
}

/** A PRD version, or the diff between two versions (default: previous → latest). */
export async function prdDetail(c: LightContainer, name: string, opts: { version?: number; diffFrom?: number }): Promise<unknown> {
  const v = await c.prdService.get(name, opts.version);
  if (opts.diffFrom === undefined) return { version: v };
  const from = await c.prdService.get(name, opts.diffFrom);
  const doneBefore = await c.prdService.doneBefore(name, from.version + 1);
  return {
    version: v,
    from: { version: from.version, created_by: from.created_by, created_at: from.created_at, note: from.note },
    diff: await textDiff(from.content, v.content, `v${from.version}`, `v${v.version}`),
    done_before: doneBefore.map((t) => ({ id: t.id, title: t.title })),
  };
}
