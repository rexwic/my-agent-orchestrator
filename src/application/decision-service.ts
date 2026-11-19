/**
 * DecisionService — requests, answers and the decision log.
 *
 * Requesting a decision on a task holds the task in `waiting_decision` (a task
 * that is running is moved there by the orchestrator when its run ends).
 * Answering applies the action once no other decision on the task is pending:
 *   continue → todo, with the answer as feedback (send-back count reset)
 *   approve  → review + approved (the orchestrator integrates it)
 *   cancel   → cancelled
 * Answered decisions are given to later agents (bindingFor).
 */

import { nanoid } from 'nanoid';
import {
  normalizeDecisionRequest,
  resolveDecisionAnswer,
  describeAnswer,
  type Decision,
  type DecisionAnswerInput,
  type DecisionRequest,
} from '../domain/decision.js';
import { InvalidArgumentsError, InvalidTransitionError, TaskNotFoundError } from '../domain/errors.js';
import { isTerminal } from '../domain/transitions.js';
import type { Task } from '../domain/task.js';
import type { IDecisionStore, ITaskStore } from '../infrastructure/storage/interfaces.js';
import type { EventBus } from './event-bus.js';
import type { TaskService } from './task-service.js';

/** Most recent project-wide decisions given to every prompt. */
const MAX_PROJECT_DECISIONS_IN_PROMPT = 30;

export interface AnswerResult {
  decision: Decision;
  /** The task after the answer was applied (undefined if it has none / was not changed). */
  task?: Task;
  /** Other decisions on the task still pending (the action waits for them). */
  stillPending: number;
}

export class DecisionService {
  constructor(
    private readonly store: IDecisionStore,
    private readonly taskStore: ITaskStore,
    private readonly taskService: TaskService,
    private readonly eventBus: EventBus,
  ) {}

  async request(input: DecisionRequest): Promise<Decision> {
    const req = normalizeDecisionRequest(input);
    let task: Task | null = null;
    if (req.task_id) {
      task = await this.taskStore.get(req.task_id);
      if (!task) throw new TaskNotFoundError(req.task_id);
      if (isTerminal(task.status)) {
        throw new InvalidArgumentsError(`Task ${task.id} is ${task.status}; no decision can be requested on it`);
      }
    }

    const decision: Decision = {
      id: `dec_${nanoid(7)}`,
      status: 'pending',
      source: req.source,
      ...(req.task_id ? { task_id: req.task_id } : {}),
      question: req.question,
      options: req.options,
      ...(req.context ? { context: req.context } : {}),
      requested_by: req.requested_by ?? (req.source === 'escalation' ? 'orch' : 'human'),
      created_at: new Date().toISOString(),
    };
    await this.store.save(decision);

    // A running task is moved when its run ends (the orchestrator owns it meanwhile).
    if (task && task.status !== 'in_progress' && task.status !== 'waiting_decision') {
      await this.taskService.updateStatus(task.id, 'waiting_decision');
    }

    this.eventBus.emit({
      type: 'decision:requested',
      decisionId: decision.id,
      ...(decision.task_id ? { taskId: decision.task_id } : {}),
      source: decision.source,
      question: decision.question,
    });
    return decision;
  }

  async get(id: string): Promise<Decision> {
    const decision = await this.store.get(id);
    if (!decision) throw new InvalidArgumentsError(`Decision not found: ${id}`, 'List them with: orch decision list');
    return decision;
  }

  async list(filter: { status?: Decision['status']; taskId?: string } = {}): Promise<Decision[]> {
    return (await this.store.list()).filter((d) =>
      (!filter.status || d.status === filter.status) && (!filter.taskId || d.task_id === filter.taskId));
  }

  async pendingFor(taskId: string): Promise<Decision[]> {
    return this.list({ status: 'pending', taskId });
  }

  async answer(id: string, input: DecisionAnswerInput): Promise<AnswerResult> {
    const decision = await this.get(id);
    if (decision.status !== 'pending') {
      throw new InvalidArgumentsError(`${id} was already answered: ${describeAnswer(decision)}`);
    }
    decision.answer = resolveDecisionAnswer(decision, input);
    decision.status = 'answered';
    await this.store.save(decision);
    this.eventBus.emit({
      type: 'decision:answered',
      decisionId: id,
      ...(decision.task_id ? { taskId: decision.task_id } : {}),
      action: decision.answer.action,
      scope: decision.answer.scope,
    });

    if (!decision.task_id) return { decision, stillPending: 0 };
    const stillPending = (await this.pendingFor(decision.task_id)).length;
    const task = await this.taskStore.get(decision.task_id);
    if (!task || task.status !== 'waiting_decision' || stillPending > 0) {
      return { decision, stillPending };
    }
    return { decision, task: await this.apply(task, decision), stillPending };
  }

  /**
   * Answered decisions an agent working on `task` must follow: this task's
   * decisions plus the most recent project-wide ones, oldest first.
   */
  async bindingFor(task: Pick<Task, 'id'>): Promise<Decision[]> {
    const answered = (await this.store.list()).filter((d) => d.status === 'answered' && d.answer);
    const project = answered.filter((d) => d.answer!.scope === 'project' && d.task_id !== task.id)
      .slice(-MAX_PROJECT_DECISIONS_IN_PROMPT);
    const own = answered.filter((d) => d.task_id === task.id);
    return [...project, ...own]
      .sort((a, b) => a.answer!.answered_at.localeCompare(b.answer!.answered_at));
  }

  private async apply(task: Task, decision: Decision): Promise<Task> {
    const action = decision.answer!.action;
    if (action === 'cancel') return this.taskService.updateStatus(task.id, 'cancelled');

    if (action === 'approve') {
      task.approved = true;
      task.updated_at = new Date().toISOString();
      await this.taskStore.save(task);
      return this.taskService.updateStatus(task.id, 'review');
    }

    if (action !== 'continue') throw new InvalidTransitionError(task.id, task.status, action);
    task.feedback = buildDecisionFeedback(decision);
    task.send_backs = 0; // a human gave it a fresh budget
    task.attempts = 0;
    delete task.approved;
    task.updated_at = new Date().toISOString();
    await this.taskStore.save(task);
    return this.taskService.updateStatus(task.id, 'todo');
  }
}

/** Feedback for the agent that continues after a decision. */
export function buildDecisionFeedback(decision: Decision): string {
  const lines = [
    `A human answered a question about this task.`,
    `Question: ${decision.question}`,
    `Answer: ${describeAnswer(decision)}`,
  ];
  if (decision.source === 'escalation' && decision.context) {
    lines.push('', 'Background (why it was escalated):', decision.context);
  }
  return lines.join('\n');
}
