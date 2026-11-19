/**
 * Review by a reviewer role (a role with the review duty that `reviews` the
 * author's role) — asymmetric: the reviewer reads, it never changes the code.
 *
 * Round 1: the reviewer lists findings, each must-fix, should or nit. Only
 * must-fix findings send the work back to its author.
 * Round 2: the reviewer only verifies the round-1 must-fix findings (fixed or
 * not); anything new it reports cannot block (must-fix becomes should).
 * Still not fixed after round 2: a human decides.
 */

export type FindingSeverity = 'must-fix' | 'should' | 'nit';
export const FINDING_SEVERITIES: readonly FindingSeverity[] = ['must-fix', 'should', 'nit'];
export const MAX_REVIEW_ROUNDS = 2;
/** Label on review tasks. */
export const REVIEW_LABEL = 'review' as const;

export interface ReviewFinding {
  /** F1, F2, … (unique across rounds). */
  id: string;
  severity: FindingSeverity;
  file?: string;
  line?: number;
  issue: string;
  suggestion?: string;
  round: number;
}

export interface FindingCheck {
  id: string;
  fixed: boolean;
  note?: string;
}

export type ReviewStatus =
  /** A review task is open. */
  | 'pending'
  | 'passed'
  /** Sent back to the author with must-fix findings. */
  | 'changes'
  /** Round limit reached (or the review could not be done): a human decides. */
  | 'escalated';

/** Review state kept on the reviewed task. */
export interface TaskReview {
  round: number;
  status: ReviewStatus;
  review_task_id?: string;
  reviewer?: string;
  /** All findings so far (every round). */
  findings: ReviewFinding[];
  /** Round-2 checks of the round-1 must-fix findings. */
  checks?: FindingCheck[];
  summary?: string;
  updated_at: string;
}

export interface ReviewSubmission {
  /** New findings, numbered. */
  findings: ReviewFinding[];
  checks: FindingCheck[];
  summary?: string;
  verdict: 'passed' | 'changes';
  /** Must-fix findings that block (round 1) or checks not fixed (round 2). */
  blocking: string[];
  /** Things ORCH changed (e.g. a round-2 must-fix turned into should). */
  notes: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Validate what a reviewer submitted for `round`, given the findings of earlier
 * rounds. Every problem is reported at once.
 */
export function validateReviewSubmission(
  raw: unknown,
  ctx: { round: number; previous: readonly ReviewFinding[] },
): { submission?: ReviewSubmission; errors: string[] } {
  const errors: string[] = [];
  const notes: string[] = [];
  if (!isRecord(raw)) return { errors: ['The review must be a map with findings (and, in round 2, checks)'] };
  for (const k of Object.keys(raw)) {
    if (!['summary', 'findings', 'checks'].includes(k)) errors.push(`Unknown field "${k}" (allowed: summary, findings, checks)`);
  }

  const summary = typeof raw['summary'] === 'string' && raw['summary'].trim() ? raw['summary'].trim() : undefined;
  const rawFindings = raw['findings'] ?? [];
  if (!Array.isArray(rawFindings)) errors.push('findings must be a list');
  let next = ctx.previous.length + 1;
  const findings: ReviewFinding[] = [];
  (Array.isArray(rawFindings) ? rawFindings : []).forEach((f, i) => {
    const where = `findings[${i}]`;
    if (!isRecord(f)) { errors.push(`${where} must be a map`); return; }
    const severity = f['severity'];
    const issue = typeof f['issue'] === 'string' ? f['issue'].trim() : '';
    if (!FINDING_SEVERITIES.includes(severity as FindingSeverity)) errors.push(`${where}: severity must be one of ${FINDING_SEVERITIES.join(', ')}`);
    if (!issue) errors.push(`${where}: issue is required (what is wrong)`);
    const line = f['line'];
    if (line !== undefined && (typeof line !== 'number' || !Number.isInteger(line) || line < 1)) errors.push(`${where}: line must be a positive integer`);
    let sev = severity as FindingSeverity;
    if (ctx.round > 1 && sev === 'must-fix') {
      sev = 'should';
      notes.push(`F${next}: round ${ctx.round} only verifies earlier findings, so this new must-fix is recorded as should`);
    }
    findings.push({
      id: `F${next++}`,
      severity: sev,
      ...(typeof f['file'] === 'string' && f['file'].trim() ? { file: f['file'].trim() } : {}),
      ...(typeof line === 'number' ? { line } : {}),
      issue,
      ...(typeof f['suggestion'] === 'string' && f['suggestion'].trim() ? { suggestion: f['suggestion'].trim() } : {}),
      round: ctx.round,
    });
  });

  const toCheck = ctx.previous.filter((f) => f.severity === 'must-fix');
  const rawChecks = raw['checks'] ?? [];
  const checks: FindingCheck[] = [];
  if (!Array.isArray(rawChecks)) errors.push('checks must be a list');
  else if (ctx.round === 1 && rawChecks.length) errors.push('checks are for round 2 (verifying earlier findings); round 1 lists findings only');
  else {
    rawChecks.forEach((c, i) => {
      const where = `checks[${i}]`;
      if (!isRecord(c)) { errors.push(`${where} must be a map`); return; }
      const id = typeof c['id'] === 'string' ? c['id'].trim() : '';
      if (!toCheck.some((f) => f.id === id)) { errors.push(`${where}: "${id}" is not a must-fix finding of an earlier round (${toCheck.map((f) => f.id).join(', ') || 'none'})`); return; }
      if (typeof c['fixed'] !== 'boolean') { errors.push(`${where}: fixed must be true or false`); return; }
      checks.push({ id, fixed: c['fixed'], ...(typeof c['note'] === 'string' && c['note'].trim() ? { note: c['note'].trim() } : {}) });
    });
    if (ctx.round > 1) {
      const missing = toCheck.filter((f) => !checks.some((c) => c.id === f.id)).map((f) => f.id);
      if (missing.length) errors.push(`checks: verify every earlier must-fix finding (missing: ${missing.join(', ')})`);
    }
  }

  if (errors.length) return { errors };
  const blocking = ctx.round === 1
    ? findings.filter((f) => f.severity === 'must-fix').map((f) => f.id)
    : checks.filter((c) => !c.fixed).map((c) => c.id);
  return {
    submission: { findings, checks, ...(summary ? { summary } : {}), verdict: blocking.length ? 'changes' : 'passed', blocking, notes },
    errors,
  };
}

/** One line per finding, for feedback, decisions and prompts. */
export function describeFinding(f: ReviewFinding): string {
  const at = f.file ? ` ${f.file}${f.line ? `:${f.line}` : ''}` : '';
  return `${f.id} [${f.severity}]${at} — ${f.issue}${f.suggestion ? ` (suggestion: ${f.suggestion})` : ''}`;
}
