/**
 * ReviewService — a reviewer role checks work before it merges.
 *
 * Integration asks `gate(task)` once the author's work passed its automatic
 * checks. When a role with the review duty `reviews` the task's role, ORCH
 * gives it a review task and the work waits in review. The reviewer submits
 * findings (`orch review submit`):
 *   passed                → the task is approved (merged on the next tick),
 *                           unless the role's approval policy is manual
 *   must-fix, round 1     → back to the author with the findings
 *   still open, round 2   → a human decides (a decision on the task)
 * See domain/review.ts for the round rules.
 */

import type { OrchestratorConfig } from '../domain/config.js';
import { MAX_CONTEXT_LENGTH } from '../domain/decision.js';
import { InvalidArgumentsError, TaskNotFoundError } from '../domain/errors.js';
import {
  MAX_REVIEW_ROUNDS,
  REVIEW_LABEL,
  describeFinding,
  validateReviewSubmission,
  type ReviewFinding,
  type TaskReview,
} from '../domain/review.js';
import { rolesWithDuty, type Role } from '../domain/role.js';
import type { Task } from '../domain/task.js';
import { isTerminal } from '../domain/transitions.js';
import type { IRoleStore, ITaskStore } from '../infrastructure/storage/interfaces.js';
import type { DecisionService } from './decision-service.js';
import type { EventBus } from './event-bus.js';
import type { TaskService } from './task-service.js';

export interface ReviewServiceDeps {
  taskStore: ITaskStore;
  taskService: TaskService;
  roleStore: IRoleStore;
  decisionService: DecisionService;
  eventBus: EventBus;
  config: OrchestratorConfig;
}

export type ReviewGate = 'not_required' | 'passed' | 'pending';

/** What the reviewer's prompt gets. */
export interface ReviewPromptContext {
  task_id: string;
  title: string;
  description: string;
  author_role?: string;
  branch?: string;
  files_changed: string[];
  round: number;
  max_rounds: number;
  /** Round 2+: the must-fix findings to verify. */
  to_verify: string[];
  delivery_status?: string;
}

const isPaperwork = (t: Task): boolean => Boolean(t.plan_id || t.prd_draft || t.triage_decision_id || t.review_of);

export class ReviewService {
  constructor(private readonly deps: ReviewServiceDeps) {
    deps.eventBus.on('task:status_changed', (e) => {
      if (e.to === 'failed' || e.to === 'cancelled') {
        void this.reviewTaskEnded(e.taskId, e.to).catch((err: unknown) => {
          deps.eventBus.emit({ type: 'orchestrator:error', error: err instanceof Error ? err.message : String(err), context: `review task ${e.taskId} ended`, fatal: false });
        });
      }
    });
  }

  /** The role that reviews this task's role, if any. */
  async reviewerFor(task: Task): Promise<Role | undefined> {
    if (!task.role || isPaperwork(task)) return undefined;
    const roles = await this.deps.roleStore.list().catch(() => []);
    return rolesWithDuty(roles, 'review').find((r) => r.reviews?.includes(task.role!) && r.name !== task.role);
  }

  /**
   * Called when the author's work passed its checks. Opens a review task when
   * one is needed; `pending` keeps the work waiting in review.
   */
  async gate(task: Task): Promise<ReviewGate> {
    const reviewer = await this.reviewerFor(task);
    if (!reviewer) return 'not_required';
    const state = task.review;
    if (state?.status === 'passed' || state?.status === 'escalated') return 'passed';
    if (state?.status === 'pending' && state.review_task_id) {
      const open = await this.deps.taskStore.get(state.review_task_id).catch(() => null);
      if (open && !isTerminal(open.status)) return 'pending';
    }
    const round = state?.status === 'changes' ? state.round + 1 : (state?.round ?? 0) + (state ? 0 : 1);
    const findings = state?.findings ?? [];
    const toVerify = findings.filter((f) => f.severity === 'must-fix' && f.round === round - 1);
    const reviewTask = await this.deps.taskService.create({
      title: `Review: ${task.title}${round > 1 ? ` (round ${round})` : ''}`,
      description: [
        `Review the work of ${task.id} "${task.title}" (role ${task.role}).`,
        round > 1 ? `Round ${round}: only verify that these must-fix findings are fixed:\n${toVerify.map(describeFinding).join('\n')}` : '',
        `The task asked for:\n${task.description}`,
      ].filter(Boolean).join('\n\n'),
      role: reviewer.name,
      priority: Math.min(task.priority, 2),
      labels: [REVIEW_LABEL],
      review_criteria: [],
      review_of: task.id,
      ...(task.prd ? { prd: task.prd } : {}),
      ...(task.uses?.length ? { uses: task.uses } : {}),
    });
    const fresh = (await this.deps.taskStore.get(task.id)) ?? task;
    fresh.review = { round, status: 'pending', review_task_id: reviewTask.id, findings, updated_at: new Date().toISOString() };
    await this.deps.taskStore.save(fresh);
    this.deps.eventBus.emit({ type: 'review:requested', taskId: task.id, reviewTaskId: reviewTask.id, round, reviewer: reviewer.name });
    return 'pending';
  }

  async promptContext(reviewTask: Task): Promise<ReviewPromptContext | undefined> {
    if (!reviewTask.review_of) return undefined;
    const task = await this.deps.taskStore.get(reviewTask.review_of).catch(() => null);
    if (!task?.review) return undefined;
    const round = task.review.round;
    return {
      task_id: task.id,
      title: task.title,
      description: task.description,
      ...(task.role ? { author_role: task.role } : {}),
      ...(task.proof?.branch ? { branch: task.proof.branch } : {}),
      files_changed: task.proof?.files_changed ?? [],
      round,
      max_rounds: MAX_REVIEW_ROUNDS,
      to_verify: task.review.findings.filter((f) => f.severity === 'must-fix' && f.round === round - 1).map(describeFinding),
    };
  }

  /** A review task's run is done once its findings are in. */
  async outcome(reviewTask: Task): Promise<'submitted' | 'missing'> {
    const task = reviewTask.review_of ? await this.deps.taskStore.get(reviewTask.review_of).catch(() => null) : null;
    if (!task?.review || task.review.review_task_id !== reviewTask.id) return 'submitted'; // nothing to do any more
    return task.review.status === 'pending' ? 'missing' : 'submitted';
  }

  /** The reviewer's findings for its review task. */
  async submit(input: { reviewTaskId: string; raw: unknown; by?: string }): Promise<{ task: Task; verdict: 'passed' | 'changes'; escalated: boolean; findings: ReviewFinding[]; notes: string[] }> {
    const reviewTask = await this.deps.taskStore.get(input.reviewTaskId);
    if (!reviewTask) throw new TaskNotFoundError(input.reviewTaskId);
    if (!reviewTask.review_of) throw new InvalidArgumentsError(`${reviewTask.id} is not a review task`);
    const task = await this.deps.taskStore.get(reviewTask.review_of);
    if (!task) throw new TaskNotFoundError(reviewTask.review_of);
    const state = task.review;
    if (!state || state.review_task_id !== reviewTask.id || state.status !== 'pending') {
      throw new InvalidArgumentsError(`${task.id} is not waiting for this review (it was reviewed already or a newer review replaced it)`);
    }

    const { submission, errors } = validateReviewSubmission(input.raw, { round: state.round, previous: state.findings });
    if (!submission) {
      throw new InvalidArgumentsError(
        `The review has ${errors.length} problem(s):\n  - ${errors.join('\n  - ')}`,
        'Fix the review file and run orch review submit again',
      );
    }

    const by = input.by ?? 'human';
    const all = [...state.findings, ...submission.findings];
    const escalated = submission.verdict === 'changes' && state.round >= MAX_REVIEW_ROUNDS;
    const review: TaskReview = {
      round: state.round,
      status: submission.verdict === 'passed' ? 'passed' : escalated ? 'escalated' : 'changes',
      review_task_id: reviewTask.id,
      reviewer: by,
      findings: all,
      ...(submission.checks.length ? { checks: submission.checks } : {}),
      ...(submission.summary ? { summary: submission.summary } : {}),
      updated_at: new Date().toISOString(),
    };
    const blockingText = (): string => {
      const open = state.round === 1
        ? submission.findings.filter((f) => submission.blocking.includes(f.id))
        : state.findings.filter((f) => submission.blocking.includes(f.id));
      return open.map((f) => {
        const check = submission.checks.find((c) => c.id === f.id);
        return `- ${describeFinding(f)}${check?.note ? `\n  reviewer: ${check.note}` : ''}`;
      }).join('\n');
    };
    const optional = all.filter((f) => f.severity !== 'must-fix' && f.round === state.round).map((f) => `- ${describeFinding(f)}`).join('\n');

    const fresh = (await this.deps.taskStore.get(task.id))!;
    fresh.review = review;
    if (review.status === 'passed') {
      const role = task.role ? await this.deps.roleStore.get(task.role).catch(() => null) : null;
      if (role?.approval_policy !== 'manual') fresh.approved = true;
      if (optional) fresh.feedback = `The reviewer approved this work. Optional suggestions (not required):\n${optional}`;
      await this.deps.taskStore.save(fresh);
    } else if (review.status === 'changes') {
      fresh.feedback = [
        `${by} reviewed this work (round ${state.round} of ${MAX_REVIEW_ROUNDS}) and found must-fix problems. Fix each one; the next round only checks these:`,
        blockingText(),
        ...(optional ? ['', 'Optional (should / nit — fix if cheap, they do not block):', optional] : []),
        ...(submission.summary ? ['', `Reviewer's summary: ${submission.summary}`] : []),
      ].join('\n');
      fresh.attempts = 0;
      delete fresh.approved;
      await this.deps.taskStore.save(fresh);
      if (fresh.status === 'review') await this.deps.taskService.updateStatus(fresh.id, 'todo');
    } else {
      await this.deps.taskStore.save(fresh);
      await this.deps.decisionService.request({
        task_id: task.id,
        source: 'review',
        question: `"${task.title}" still has open must-fix review findings after ${MAX_REVIEW_ROUNDS} rounds. Merge it as it is (approve), send it back with your instructions, or cancel it?`,
        context: [`Open findings (${by}):`, blockingText(), ...(submission.summary ? ['', submission.summary] : [])].join('\n').slice(0, MAX_CONTEXT_LENGTH),
        requested_by: by,
      });
    }
    this.deps.eventBus.emit({ type: 'review:submitted', taskId: task.id, round: state.round, verdict: submission.verdict, blocking: submission.blocking, by });
    return { task: (await this.deps.taskStore.get(task.id))!, verdict: submission.verdict, escalated, findings: submission.findings, notes: submission.notes };
  }

  /** A review task that ended for good without findings: a human decides about the work. */
  private async reviewTaskEnded(taskId: string, status: 'failed' | 'cancelled'): Promise<void> {
    const reviewTask = await this.deps.taskStore.get(taskId);
    if (!reviewTask?.review_of) return;
    const task = await this.deps.taskStore.get(reviewTask.review_of);
    if (!task?.review || task.review.review_task_id !== taskId || task.review.status !== 'pending' || isTerminal(task.status)) return;
    task.review = { ...task.review, status: 'escalated', updated_at: new Date().toISOString() };
    await this.deps.taskStore.save(task);
    await this.deps.decisionService.request({
      task_id: task.id,
      source: 'review',
      question: `The review of "${task.title}" could not be done (review task ${taskId} ${status}). Merge it without a review (approve), send it back, or cancel it?`,
      requested_by: 'orch',
    });
  }
}
