/**
 * PRD — the product requirements: what to build (features, business rules,
 * acceptance criteria, what is out of scope), with numbered versions.
 *
 * The PM role drafts it (`orch prd new "<requirement>"`); every change is a new
 * version (`orch prd add <name> -f prd.md`). A human approves it together with
 * the plan built from it; afterwards the PM may add versions when it answers
 * agents' questions (those are not approved again, but a human is told).
 * Tasks of a plan built from a PRD get its latest version in their prompt.
 *
 * Stored in .orchestry/prds/<name>/v<N>.md.
 */

import { InvalidArgumentsError } from './errors.js';

export const PRD_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,49}$/;
export const MAX_PRD_LENGTH = 100_000;
/** PRDs longer than this are cut in prompts (the agent can read the whole with orch prd show). */
export const MAX_PRD_IN_PROMPT = 30_000;
export const DEFAULT_PM_ROLE = 'pm';
/** Label on PRD drafting tasks. */
export const PRD_DRAFT_LABEL = 'prd' as const;
/** Label on PM tasks that answer a teammate's question. */
export const PM_ANSWER_LABEL = 'pm-answer' as const;

export interface PrdVersion {
  name: string;
  /** 1, 2, 3… */
  version: number;
  /** Markdown. */
  content: string;
  /** Agent name, or "human". */
  created_by: string;
  created_at: string;
  /** What changed (e.g. "discount cap clarified for dec_x"). */
  note?: string;
  /** Drafting / PM task that wrote it. */
  task_id?: string;
  /** Versions written by agents are unseen until a human looks at them (orch prd diff/show). */
  seen: boolean;
}

export function validatePrdName(name: string): string {
  const n = name.trim();
  if (!PRD_NAME_PATTERN.test(n)) {
    throw new InvalidArgumentsError(`PRD name "${n}" must be lowercase letters, digits and hyphens (max 50)`, 'e.g. --name order-discounts');
  }
  return n;
}

export function validatePrdContent(content: string): string {
  const c = content.replace(/\r\n/g, '\n').trim();
  if (!c) throw new InvalidArgumentsError('The PRD is empty');
  if (c.length > MAX_PRD_LENGTH) throw new InvalidArgumentsError(`The PRD is too long (max ${MAX_PRD_LENGTH} characters)`);
  return c;
}

/** A PRD name from a requirement: its ASCII words, or `prd-<suffix>` when there are none (e.g. Chinese). */
export function prdNameFrom(requirement: string, suffix: string): string {
  const first = requirement.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  const slug = first.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return slug.length >= 3 ? slug : `prd-${suffix}`;
}
