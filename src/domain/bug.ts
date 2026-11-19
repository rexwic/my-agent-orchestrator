/**
 * Bugs filed by a verifying role (a role with the verify duty, e.g. QA).
 *
 * Every bug has exactly one owner role (one of the verifier's bug_owners).
 * When the bug involves an API contract, the side that does not follow the
 * contract owns it. The owner may hand it to another role once
 * (`orch bug reassign`); a second hand-off goes to a human, who picks the owner.
 * Once every bug a verification task filed is closed, ORCH opens a second
 * round that only re-verifies those bugs; still broken after that, a human
 * decides.
 */

import { InvalidArgumentsError } from './errors.js';

export const BUG_LABEL = 'bug' as const;
export const VERIFY_LABEL = 'verify' as const;
export const MAX_BUG_REASSIGNS = 1;
export const MAX_VERIFY_ROUNDS = 2;

export interface BugHandoff {
  from: string;
  to: string;
  reason: string;
  by: string;
  at: string;
}

export interface BugInfo {
  /** The verification task that filed it. */
  found_by?: string;
  reporter: string;
  repro: string;
  expected: string;
  actual: string;
  /** Contract file the owner must follow (the arbiter between sides). */
  contract?: string;
  evidence?: string;
  /** 1 for a bug filed in a first verification; higher for reopened ones. */
  round: number;
  /** Hand-offs already done. */
  reassigned?: BugHandoff[];
  /** Requested during the owner's run; applied when the run ends. */
  handoff?: { to: string; reason: string; by: string };
  /** Re-verification result. */
  verified?: { fixed: boolean; note?: string; by: string; at: string };
}

export interface NewBugInput {
  title: string;
  owner: string;
  repro: string;
  expected: string;
  actual: string;
  contract?: string;
  evidence?: string;
}

export function validateNewBug(input: Partial<NewBugInput>): NewBugInput {
  const errors: string[] = [];
  const req = (k: keyof NewBugInput, what: string): string => {
    const v = typeof input[k] === 'string' ? input[k]!.trim() : '';
    if (!v) errors.push(`${k} is required (${what})`);
    return v;
  };
  const out: NewBugInput = {
    title: req('title', 'one line'),
    owner: req('owner', 'the one role that must fix it'),
    repro: req('repro', 'steps to reproduce'),
    expected: req('expected', 'what should happen'),
    actual: req('actual', 'what happens instead'),
  };
  if (input.contract?.trim()) out.contract = input.contract.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (input.evidence?.trim()) out.evidence = input.evidence.trim();
  if (errors.length) {
    throw new InvalidArgumentsError(`The bug has ${errors.length} problem(s):\n  - ${errors.join('\n  - ')}`,
      'orch bug add "<title>" --owner <role> --repro "<steps>" --expected "<…>" --actual "<…>" [--contract <file>] [--evidence "<…>"]');
  }
  return out;
}

/** The bug as the owner reads it (task description). */
export function bugDescription(b: NewBugInput & { reporter: string }): string {
  return [
    `Bug reported by ${b.reporter}.`,
    '',
    `Steps to reproduce:\n${b.repro}`,
    '',
    `Expected: ${b.expected}`,
    `Actual: ${b.actual}`,
    ...(b.contract ? ['', `Contract: ${b.contract} — the contract decides what is right; fix your side to follow it.`] : []),
    ...(b.evidence ? ['', `Evidence:\n${b.evidence}`] : []),
  ].join('\n');
}
