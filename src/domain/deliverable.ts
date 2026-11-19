/**
 * Deliverable — the report an agent hands in when it ends a task.
 *
 * Agents report success even when they could not do the work. Before its run
 * ends, an agent writes a report and runs `orch task deliver report.md
 * --status done|partial|blocked`. ORCH checks the report has the sections its
 * role requires and that the files the task must produce exist; a run that
 * ends without a report fails, and a partial / blocked report goes to a human.
 *
 * Stored in .orchestry/deliverables/<task>.md (not in git).
 */

import { AUTONOMOUS_LABEL, type Task } from './task.js';
import { InvalidArgumentsError } from './errors.js';

export type DeliveryStatus =
  /** The task is done as described. */
  | 'done'
  /** Some of it is done; the report says what is missing. */
  | 'partial'
  /** Could not be done (missing information, broken environment, …). */
  | 'blocked';

export const DELIVERY_STATUSES: readonly DeliveryStatus[] = ['done', 'partial', 'blocked'];

/** Sections every report needs unless the role sets its own (`deliverable.sections`). */
export const DEFAULT_REPORT_SECTIONS: readonly string[] = ['Summary', 'Verification', 'Open issues'];

export const MAX_REPORT_LENGTH = 50_000;

export interface Deliverable {
  task_id: string;
  status: DeliveryStatus;
  /** Markdown. */
  report: string;
  /** Agent name, or "human". */
  submitted_by: string;
  submitted_at: string;
}

export function parseDeliveryStatus(value: string | undefined): DeliveryStatus {
  const v = (value ?? '').trim().toLowerCase();
  if (!DELIVERY_STATUSES.includes(v as DeliveryStatus)) {
    throw new InvalidArgumentsError(`--status must be one of ${DELIVERY_STATUSES.join(', ')}`);
  }
  return v as DeliveryStatus;
}

/**
 * Problems with a report: missing or empty required sections. A section is a
 * Markdown heading whose text starts with the section name (case-insensitive);
 * its body runs to the next heading of the same or a higher level.
 */
export function validateReport(report: string, sections: readonly string[]): string[] {
  const text = report.replace(/\r\n/g, '\n');
  if (!text.trim()) return ['The report is empty'];
  const errors: string[] = [];
  if (text.length > MAX_REPORT_LENGTH) errors.push(`The report is too long (max ${MAX_REPORT_LENGTH} characters)`);

  const lines = text.split('\n');
  const headings: Array<{ line: number; level: number; title: string }> = [];
  let fenced = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fenced = !fenced;
    const m = fenced ? null : /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (m) headings.push({ line: i, level: m[1]!.length, title: m[2]!.trim().toLowerCase() });
  });

  for (const name of sections) {
    const want = name.trim().toLowerCase();
    const idx = headings.findIndex((h) => h.title.startsWith(want));
    if (idx === -1) {
      errors.push(`Missing section "## ${name}"`);
      continue;
    }
    const h = headings[idx]!;
    const next = headings.slice(idx + 1).find((o) => o.level <= h.level);
    const body = lines.slice(h.line + 1, next ? next.line : lines.length).join('\n');
    if (!body.trim()) errors.push(`Section "## ${name}" is empty`);
  }
  return errors;
}

/**
 * Whether a run of `task` must end with a report. Paperwork tasks (plans, PRD
 * drafts, PM answers) hand in something else; shell roles are scripts;
 * autonomous goal tasks loop.
 */
export function needsDeliveryReport(task: Task, adapter: string | undefined, required: boolean): boolean {
  if (!required || adapter === 'shell') return false;
  if (task.plan_id || task.prd_draft || task.triage_decision_id) return false;
  return !task.labels?.includes(AUTONOMOUS_LABEL);
}
