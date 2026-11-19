/**
 * DeliverableService — delivery reports (`orch task deliver`).
 *
 * A report is checked when it is handed in, so the agent can fix it while it
 * still runs: the role's required sections must be there and not empty, and
 * with status `done` every `produces` pattern of the task must match a file in
 * the workspace. The orchestrator then asks `runOutcome` when the run ends.
 */

import {
  DEFAULT_REPORT_SECTIONS,
  needsDeliveryReport,
  validateReport,
  type Deliverable,
  type DeliveryStatus,
} from '../domain/deliverable.js';
import type { OrchestratorConfig } from '../domain/config.js';
import { InvalidArgumentsError, TaskNotFoundError } from '../domain/errors.js';
import { matchesPattern } from '../domain/scope.js';
import type { Task } from '../domain/task.js';
import { isTerminal } from '../domain/transitions.js';
import type { IDeliverableStore, IRoleStore, ITaskStore } from '../infrastructure/storage/interfaces.js';
import type { EventBus } from './event-bus.js';

/** Upstream reports in a prompt are cut to this many characters. */
export const MAX_UPSTREAM_REPORT = 1500;

export interface DeliverableServiceDeps {
  store: IDeliverableStore;
  taskStore: ITaskStore;
  roleStore?: IRoleStore;
  eventBus: EventBus;
  config: OrchestratorConfig;
}

export interface SubmitDeliverableInput {
  taskId: string;
  report: string;
  status: DeliveryStatus;
  submittedBy?: string;
  /** Files in the agent's workspace (relative paths), to check `produces`. Omit to skip that check. */
  files?: string[];
}

export interface DeliveryContract {
  sections: string[];
  produces: string[];
}

export class DeliverableService {
  constructor(private readonly deps: DeliverableServiceDeps) {}

  get required(): boolean {
    return this.deps.config.deliverables?.required !== false;
  }

  /** Whether a run of `task` by an agent with this adapter must end with a report. */
  async requiresReport(task: Task, adapter: string | undefined): Promise<boolean> {
    const role = task.role && this.deps.roleStore ? await this.deps.roleStore.get(task.role).catch(() => null) : null;
    return needsDeliveryReport(task, adapter, this.required, role?.deliverable?.required);
  }

  /** Sections the task's role requires, and the files the task must produce. */
  async contractFor(task: Task): Promise<DeliveryContract> {
    const role = task.role && this.deps.roleStore ? await this.deps.roleStore.get(task.role).catch(() => null) : null;
    return {
      sections: role?.deliverable?.sections?.length ? [...role.deliverable.sections] : [...DEFAULT_REPORT_SECTIONS],
      produces: [...(task.produces ?? [])],
    };
  }

  async submit(input: SubmitDeliverableInput): Promise<Deliverable> {
    const task = await this.deps.taskStore.get(input.taskId);
    if (!task) throw new TaskNotFoundError(input.taskId);
    if (isTerminal(task.status)) throw new InvalidArgumentsError(`Task ${task.id} is ${task.status}; it takes no more reports`);

    const contract = await this.contractFor(task);
    const errors = validateReport(input.report, contract.sections);
    if (input.status === 'done' && input.files) {
      for (const pattern of contract.produces) {
        if (!input.files.some((f) => matchesPattern(f, pattern))) {
          errors.push(`No file matches "${pattern}", which this task must produce (if you could not produce it, deliver with --status partial or blocked)`);
        }
      }
    }
    if (errors.length) {
      throw new InvalidArgumentsError(
        `The report has ${errors.length} problem(s):\n  - ${errors.join('\n  - ')}`,
        `Required sections: ${contract.sections.map((s) => `## ${s}`).join(', ')}. Fix the report and run orch task deliver again`,
      );
    }

    const deliverable: Deliverable = {
      task_id: task.id,
      status: input.status,
      report: input.report.replace(/\r\n/g, '\n').trim(),
      submitted_by: input.submittedBy ?? 'human',
      submitted_at: new Date().toISOString(),
    };
    await this.deps.store.save(deliverable);
    this.deps.eventBus.emit({ type: 'task:delivered', taskId: task.id, status: input.status, by: deliverable.submitted_by });
    return deliverable;
  }

  async get(taskId: string): Promise<Deliverable | null> {
    return this.deps.store.get(taskId);
  }

  /** The report handed in during the run that started at `sinceIso`, or `missing`. */
  async runOutcome(task: Pick<Task, 'id'>, sinceIso: string): Promise<'missing' | Deliverable> {
    const d = await this.deps.store.get(task.id).catch(() => null);
    if (!d || d.submitted_at < sinceIso) return 'missing';
    return d;
  }

  /** Reports of the tasks `task` depends on (cut for the prompt), in depends_on order. */
  async upstreamFor(task: Task): Promise<Array<{ task_id: string; title: string; status: DeliveryStatus; report: string }>> {
    const out = await Promise.all(task.depends_on.map(async (id) => {
      const [dep, d] = await Promise.all([this.deps.taskStore.get(id).catch(() => null), this.deps.store.get(id).catch(() => null)]);
      if (!dep || !d) return null;
      const cut = d.report.length > MAX_UPSTREAM_REPORT ? `${d.report.slice(0, MAX_UPSTREAM_REPORT)}\n… (cut; full report: orch task show ${id})` : d.report;
      // Nest its headings under the prompt's "### <task>" heading.
      const report = cut.replace(/^(#{1,4})(?=\s)/gm, '$1##');
      return { task_id: id, title: dep.title, status: d.status, report };
    }));
    return out.filter((x): x is NonNullable<typeof x> => x !== null);
  }
}
