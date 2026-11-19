/**
 * PmService — agents ask the PM before they ask a human.
 *
 * When there is a PM role, a question an agent asks (`orch decision request`)
 * is assigned to it: ORCH gives the PM a task with the question, and the PM
 * answers it (`orch decision answer`, the asking task continues) or escalates
 * it to a human (`orch decision escalate`). Questions the PM asks itself, and
 * everything that is not an agent's question (plans, gates, loop escalations,
 * partial / blocked deliveries), go to a human directly. A PM task that ends
 * for good without an answer escalates the question.
 */

import type { OrchestratorConfig } from '../domain/config.js';
import type { Decision } from '../domain/decision.js';
import { DEFAULT_PM_ROLE, PM_ANSWER_LABEL } from '../domain/prd.js';
import type { Task } from '../domain/task.js';
import type { IRoleStore, ITaskStore } from '../infrastructure/storage/interfaces.js';
import type { DecisionService } from './decision-service.js';
import type { EventBus } from './event-bus.js';
import type { TaskService } from './task-service.js';

const MAX_ASKER_DESCRIPTION = 4000;

export interface PmServiceDeps {
  decisionService: DecisionService;
  taskService: TaskService;
  taskStore: ITaskStore;
  roleStore: IRoleStore;
  eventBus: EventBus;
  config: OrchestratorConfig;
}

/** What the PM's prompt gets about the question it answers. */
export interface TriagePromptContext {
  decision_id: string;
  question: string;
  options: string[];
  context?: string;
  asked_by: string;
  asking_task?: { id: string; title: string };
}

export class PmService {
  constructor(private readonly deps: PmServiceDeps) {
    deps.decisionService.setRouter((d, asker) => this.route(d, asker));
    deps.eventBus.on('task:status_changed', (e) => {
      if (e.to === 'failed' || e.to === 'cancelled') {
        void this.triageTaskEnded(e.taskId, e.to).catch((err: unknown) => {
          deps.eventBus.emit({ type: 'orchestrator:error', error: err instanceof Error ? err.message : String(err), context: `escalating the question of PM task ${e.taskId}`, fatal: false });
        });
      }
    });
  }

  get role(): string {
    return this.deps.config.pm?.role || DEFAULT_PM_ROLE;
  }

  /** Assign an agent's question to the PM (creating its task), or leave it to a human. */
  async route(decision: Decision, asker: Task | null): Promise<{ assignee: string; triage_task_id: string } | undefined> {
    if (decision.source !== 'agent' || !asker) return undefined;
    if (asker.role === this.role || asker.triage_decision_id) return undefined;
    if (!(await this.deps.roleStore.get(this.role).catch(() => null))) return undefined;

    const flat = decision.question.replace(/\s+/g, ' ').trim();
    const desc = asker.description.length > MAX_ASKER_DESCRIPTION ? `${asker.description.slice(0, MAX_ASKER_DESCRIPTION)}…` : asker.description;
    const task = await this.deps.taskService.create({
      title: `Answer: ${flat.length > 60 ? `${flat.slice(0, 59)}…` : flat}`,
      description: [
        `${decision.requested_by} asked a question while working on "${asker.title}" (${asker.id}).`,
        '',
        `Question: ${decision.question}`,
        ...(decision.options.length ? ['Options:', ...decision.options.map((o, i) => `  ${i + 1}. ${o}`)] : []),
        ...(decision.context ? ['', 'Background from the asker:', decision.context] : []),
        '',
        `The task they work on:\n${desc}`,
      ].join('\n'),
      role: this.role,
      priority: 1,
      labels: [PM_ANSWER_LABEL],
      review_criteria: [],
      triage_decision_id: decision.id,
      ...(asker.prd ? { prd: asker.prd } : {}),
    });
    return { assignee: this.role, triage_task_id: task.id };
  }

  /** A PM task's run is done once the question is answered or escalated. */
  async triageOutcome(task: Task): Promise<'submitted' | 'missing'> {
    if (!task.triage_decision_id) return 'missing';
    const d = await this.deps.decisionService.get(task.triage_decision_id).catch(() => null);
    return !d || d.status === 'answered' || d.assignee !== this.role ? 'submitted' : 'missing';
  }

  async promptContext(task: Task): Promise<TriagePromptContext | undefined> {
    if (!task.triage_decision_id) return undefined;
    const d = await this.deps.decisionService.get(task.triage_decision_id).catch(() => null);
    if (!d) return undefined;
    const asking = d.task_id ? await this.deps.taskStore.get(d.task_id).catch(() => null) : null;
    return {
      decision_id: d.id,
      question: d.question,
      options: d.options,
      ...(d.context ? { context: d.context } : {}),
      asked_by: d.requested_by,
      ...(asking ? { asking_task: { id: asking.id, title: asking.title } } : {}),
    };
  }

  private async triageTaskEnded(taskId: string, status: 'failed' | 'cancelled'): Promise<void> {
    const task = await this.deps.taskStore.get(taskId);
    if (!task?.triage_decision_id) return;
    const d = await this.deps.decisionService.get(task.triage_decision_id).catch(() => null);
    if (!d || d.status !== 'pending' || d.assignee !== this.role) return;
    await this.deps.decisionService.escalate(d.id, {
      by: 'orch',
      note: `The PM task ${taskId} ended (${status}) without an answer.`,
    });
  }
}
