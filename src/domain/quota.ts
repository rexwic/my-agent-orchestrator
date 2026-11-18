/**
 * Usage-limit (quota) pauses — pure domain logic.
 *
 * A quota belongs to an account, not to an agent: every agent that runs the
 * same CLI with the same login (subscription) or the same API key shares it.
 * When one of them hits the limit, the whole quota group is paused until the
 * provider's reset time, then resumes automatically.
 */

import type { Agent } from './agent.js';

export interface QuotaPause {
  /** ISO time the group may run again. */
  until: string;
  /** ISO time the pause started. */
  since: string;
  /** Human-readable reason (provider message, trimmed). */
  reason: string;
  /** Consecutive limit hits without a successful run — grows the fallback wait. */
  strikes: number;
  /** Whether `until` came from the provider (vs. the fallback backoff). */
  reset_known: boolean;
  /** Agent whose run hit the limit (for display). */
  agent_id?: string;
  /**
   * The pause has been lifted (expired or resumed manually). The record is kept
   * so a repeated hit backs off further; it is dropped after the next successful run.
   */
  resumed?: boolean;
}

/** Pause records keyed by quota group. Persisted in .orchestry/quota.json. */
export type QuotaState = Record<string, QuotaPause>;

/**
 * Environment variables that select a different account for each CLI, in the
 * order the CLI gives them precedence. Unset → the CLI's own login (subscription).
 */
export const QUOTA_AUTH_ENV: Readonly<Record<string, readonly string[]>> = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR'],
  codex: ['CODEX_API_KEY', 'OPENAI_API_KEY', 'CODEX_HOME'],
  antigravity: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
};

/** Group suffix for "the CLI's own login". */
export const SUBSCRIPTION_GROUP = 'subscription';

/**
 * Quota group of an agent:
 *  - `agent.config.quota_group` when set (explicit override), else
 *  - `<adapter>:<env var>:<hash>` when an account-selecting env var is set
 *    (agent env overrides the orchestrator's env), else
 *  - `<adapter>:subscription`.
 * Secrets are never part of the key — only a short hash of their value.
 */
export function quotaGroupOf(
  agent: Pick<Agent, 'adapter' | 'config'>,
  baseEnv: Readonly<Record<string, string | undefined>>,
  hash: (value: string) => string,
): string {
  const explicit = agent.config.quota_group?.trim();
  if (explicit) return explicit;

  const env: Record<string, string | undefined> = { ...baseEnv, ...agent.config.env };
  for (const name of QUOTA_AUTH_ENV[agent.adapter] ?? []) {
    const value = env[name];
    if (value) return `${agent.adapter}:${name.toLowerCase()}:${hash(value)}`;
  }
  return `${agent.adapter}:${SUBSCRIPTION_GROUP}`;
}

/** Display name for a quota group, e.g. "claude (subscription)", "codex (OPENAI_API_KEY …3fa1)". */
export function describeQuotaGroup(group: string): string {
  const [adapter, kind, hash] = group.split(':');
  if (!kind) return group;
  if (kind === SUBSCRIPTION_GROUP) return `${adapter} (subscription)`;
  return hash ? `${adapter} (${kind.toUpperCase()} …${hash.slice(-4)})` : group;
}

/** Wait this long past the provider's reset time before retrying. */
export const RESET_MARGIN_MS = 60_000;
/** Fallback wait when the reset time is unknown: 15 min, doubling per strike, capped at 1 h. */
export const FALLBACK_PAUSE_MS = 15 * 60_000;
export const MAX_FALLBACK_PAUSE_MS = 60 * 60_000;
/** Ignore provider reset times further out than this (likely a parse error). */
const MAX_RESET_HORIZON_MS = 8 * 24 * 60 * 60_000;

/**
 * When a paused group may run again. `strikes` counts previous consecutive hits
 * (0 for the first). A known reset time in the past still waits the margin.
 */
export function computePauseUntil(resetAt: Date | undefined, strikes: number, now: Date): { until: Date; resetKnown: boolean } {
  if (resetAt && resetAt.getTime() - now.getTime() <= MAX_RESET_HORIZON_MS) {
    return { until: new Date(Math.max(resetAt.getTime(), now.getTime()) + RESET_MARGIN_MS), resetKnown: true };
  }
  const wait = Math.min(FALLBACK_PAUSE_MS * 2 ** Math.max(0, strikes), MAX_FALLBACK_PAUSE_MS);
  return { until: new Date(now.getTime() + wait), resetKnown: false };
}

const UNIT_MS: Record<string, number> = {
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  s: 1_000, sec: 1_000, secs: 1_000, second: 1_000, seconds: 1_000,
};

/**
 * Best-effort extraction of a reset time from a provider's limit message.
 *
 * Recognised forms:
 *   "…|1763654400"                         (epoch seconds after a pipe)
 *   "try again in 2 days 3 hours 4 minutes", "retry in 30s", "retry after 120 seconds"
 *   "try again at 3:04 PM", "resets 3pm", "resets at 15:00"   (next occurrence, local time)
 *   "try again at Nov 18th, 2026 3:04 PM"  (absolute date)
 */
export function parseResetTime(text: string, now: Date = new Date()): Date | undefined {
  if (!text) return undefined;

  const epoch = /\|\s*(\d{10})\b/.exec(text);
  if (epoch?.[1]) return new Date(Number(epoch[1]) * 1000);

  const relative = /\b(?:in|after)\s+((?:\d+(?:\.\d+)?\s*[a-z]+[\s,]*(?:and\s+)?)+)/i.exec(text);
  if (relative?.[1]) {
    let total = 0;
    for (const part of relative[1].matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) {
      const ms = UNIT_MS[(part[2] ?? '').toLowerCase()];
      if (ms === undefined) { total = 0; break; }
      total += Number(part[1]) * ms;
    }
    if (total > 0) return new Date(now.getTime() + total);
  }

  const at = /\b(?:at|resets?(?:\s+at)?)\s+([A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4},?\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?(?![\d:])/i.exec(text);
  if (at?.[2] && (at[3] !== undefined || at[4] !== undefined)) {
    let hour = Number(at[2]);
    const minute = Number(at[3] ?? 0);
    const meridiem = at[4]?.toLowerCase().replace(/\./g, '');
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) return undefined;

    if (at[1]) {
      const datePart = at[1].replace(/(\d)(st|nd|rd|th)/i, '$1').replace(/,/g, ' ').trim();
      const day = new Date(datePart);
      if (!Number.isNaN(day.getTime())) {
        day.setHours(hour, minute, 0, 0);
        return day;
      }
    }

    const candidate = new Date(now);
    candidate.setHours(hour, minute, 0, 0);
    if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1);
    return candidate;
  }

  return undefined;
}
