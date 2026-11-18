import { describe, it, expect } from 'vitest';
import {
  quotaGroupOf,
  describeQuotaGroup,
  computePauseUntil,
  parseResetTime,
  RESET_MARGIN_MS,
  FALLBACK_PAUSE_MS,
  MAX_FALLBACK_PAUSE_MS,
} from '../../../src/domain/quota.js';
import { classifyAdapterError, AdapterErrorKind } from '../../../src/domain/errors.js';

const hash = (v: string) => `h(${v})`;
const agent = (adapter: string, config: Record<string, unknown> = {}) => ({ adapter, config });

describe('quotaGroupOf', () => {
  it('uses the CLI login (subscription) when no account env var is set', () => {
    expect(quotaGroupOf(agent('claude'), {}, hash)).toBe('claude:subscription');
    expect(quotaGroupOf(agent('codex'), { PATH: '/bin' }, hash)).toBe('codex:subscription');
  });

  it('groups by API key — hashed, never the key itself', () => {
    const group = quotaGroupOf(agent('claude'), { ANTHROPIC_API_KEY: 'sk-ant-secret' }, hash);
    expect(group).toBe('claude:anthropic_api_key:h(sk-ant-secret)');
  });

  it('agent env overrides the orchestrator env (different account per agent)', () => {
    const base = { OPENAI_API_KEY: 'team-key' };
    expect(quotaGroupOf(agent('codex', { env: { OPENAI_API_KEY: 'my-key' } }), base, hash)).toBe('codex:openai_api_key:h(my-key)');
    expect(quotaGroupOf(agent('codex'), base, hash)).toBe('codex:openai_api_key:h(team-key)');
  });

  it('treats a separate Claude config dir or OAuth token as a separate account', () => {
    expect(quotaGroupOf(agent('claude', { env: { CLAUDE_CONFIG_DIR: 'C:/work' } }), {}, hash)).toBe('claude:claude_config_dir:h(C:/work)');
    expect(quotaGroupOf(agent('claude', { env: { CLAUDE_CODE_OAUTH_TOKEN: 't' } }), {}, hash)).toBe('claude:claude_code_oauth_token:h(t)');
  });

  it('honours an explicit quota_group', () => {
    expect(quotaGroupOf(agent('claude', { quota_group: 'shared-team', env: { ANTHROPIC_API_KEY: 'x' } }), {}, hash)).toBe('shared-team');
  });

  it('keeps different adapters apart even on the same machine', () => {
    expect(quotaGroupOf(agent('antigravity'), {}, hash)).toBe('antigravity:subscription');
  });
});

describe('describeQuotaGroup', () => {
  it('renders subscription and API-key groups without the secret', () => {
    expect(describeQuotaGroup('claude:subscription')).toBe('claude (subscription)');
    expect(describeQuotaGroup('codex:openai_api_key:0123456789ab')).toBe('codex (OPENAI_API_KEY …89ab)');
    expect(describeQuotaGroup('shared-team')).toBe('shared-team');
  });
});

describe('computePauseUntil', () => {
  const now = new Date('2026-11-18T10:00:00Z');

  it('waits until the provider reset time plus a margin', () => {
    const reset = new Date('2026-11-18T15:00:00Z');
    expect(computePauseUntil(reset, 0, now)).toEqual({ until: new Date(reset.getTime() + RESET_MARGIN_MS), resetKnown: true });
  });

  it('treats a reset time in the past as "now + margin"', () => {
    const { until } = computePauseUntil(new Date('2026-11-18T09:00:00Z'), 0, now);
    expect(until.getTime()).toBe(now.getTime() + RESET_MARGIN_MS);
  });

  it('falls back to 15 min, doubling per strike, capped at 1 h', () => {
    expect(computePauseUntil(undefined, 0, now)).toEqual({ until: new Date(now.getTime() + FALLBACK_PAUSE_MS), resetKnown: false });
    expect(computePauseUntil(undefined, 1, now).until.getTime() - now.getTime()).toBe(2 * FALLBACK_PAUSE_MS);
    expect(computePauseUntil(undefined, 5, now).until.getTime() - now.getTime()).toBe(MAX_FALLBACK_PAUSE_MS);
  });

  it('ignores absurdly distant reset times (parse errors) and uses the fallback', () => {
    expect(computePauseUntil(new Date('2030-01-01T00:00:00Z'), 0, now).resetKnown).toBe(false);
  });
});

describe('parseResetTime', () => {
  const now = new Date(2026, 10, 18, 10, 0, 0); // local time

  it('reads an epoch after a pipe (legacy Claude format)', () => {
    expect(parseResetTime('Claude AI usage limit reached|1794979200', now)).toEqual(new Date(1794979200 * 1000));
  });

  it('reads relative durations', () => {
    expect(parseResetTime("You've hit your usage limit. Try again in 2 days 3 hours 4 minutes.", now))
      .toEqual(new Date(now.getTime() + (2 * 24 * 60 + 3 * 60 + 4) * 60_000));
    expect(parseResetTime('Rate limited, retry in 30s', now)).toEqual(new Date(now.getTime() + 30_000));
    expect(parseResetTime('Quota exceeded. Please retry after 120 seconds', now)).toEqual(new Date(now.getTime() + 120_000));
    expect(parseResetTime('try again in 5h 30m', now)).toEqual(new Date(now.getTime() + 5.5 * 3_600_000));
  });

  it('reads a clock time as its next occurrence (local)', () => {
    expect(parseResetTime('Try again at 3:04 PM.', now)).toEqual(new Date(2026, 10, 18, 15, 4));
    expect(parseResetTime("5-hour limit reached ∙ resets 3pm", now)).toEqual(new Date(2026, 10, 18, 15, 0));
    expect(parseResetTime('resets at 09:30', now)).toEqual(new Date(2026, 10, 19, 9, 30)); // already past today
  });

  it('reads an absolute date and time', () => {
    expect(parseResetTime("You've hit your usage limit. Try again at Nov 20th, 2026 3:04 PM.", now))
      .toEqual(new Date(2026, 10, 20, 15, 4));
  });

  it('returns undefined when there is no reset time', () => {
    expect(parseResetTime("You've hit your usage limit. Upgrade to Pro.", now)).toBeUndefined();
    expect(parseResetTime('Look at 3 files in 2 folders', now)).toBeUndefined();
    expect(parseResetTime('', now)).toBeUndefined();
  });
});

describe('classifyAdapterError — usage limits', () => {
  it.each([
    "You've hit your usage limit. Upgrade to Pro or try again in 2 hours.",
    'Claude AI usage limit reached|1794979200',
    '5-hour limit reached ∙ resets 3pm',
    'Weekly limit reached',
    '429 Too Many Requests',
    'RESOURCE_EXHAUSTED: Quota exceeded for quota metric',
    'You exceeded your current quota, please check your plan',
    'Your credit balance is too low to access the Anthropic API',
  ])('classifies %j as RATE_LIMIT', (message) => {
    expect(classifyAdapterError(message)).toBe(AdapterErrorKind.RATE_LIMIT);
  });

  it('does not treat a context-window limit as a usage limit', () => {
    expect(classifyAdapterError('Context limit reached · /compact or /clear to continue')).not.toBe(AdapterErrorKind.RATE_LIMIT);
  });
});
