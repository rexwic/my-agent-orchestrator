/**
 * Adapter parsers: usage-limit detection, reset times, and fatal errors.
 * Claude fixtures mirror real stream-json from Claude Code 2.1 (rate_limit_event,
 * result with is_error / subtype / api_error_status).
 */
import { describe, it, expect } from 'vitest';
import { createClaudeEventParser } from '../../../src/infrastructure/adapters/claude.js';
import { createCodexEventParser } from '../../../src/infrastructure/adapters/codex.js';
import { createAntigravityParser } from '../../../src/infrastructure/adapters/antigravity.js';
import { AdapterErrorKind } from '../../../src/domain/errors.js';

const line = (o: unknown) => JSON.stringify(o);

const rateLimitEvent = (status: string, resetsAt = 1794979200) => line({
  type: 'rate_limit_event',
  rate_limit_info: { status, resetsAt, rateLimitType: 'five_hour', overageStatus: 'rejected', isUsingOverage: false },
});

const claudeResult = (fields: Record<string, unknown>) => line({
  type: 'result', subtype: 'success', is_error: false, api_error_status: null, result: 'ok', num_turns: 1,
  usage: { input_tokens: 10, output_tokens: 5 }, ...fields,
});

describe('Claude parser', () => {
  it('passes through an allowed rate_limit_event as output', () => {
    const parse = createClaudeEventParser();
    expect(parse(rateLimitEvent('allowed'))?.type).toBe('output');
  });

  it('turns a successful result into done with tokens', () => {
    const event = createClaudeEventParser()(claudeResult({}));
    expect(event).toMatchObject({ type: 'done', tokens: { input: 10, output: 5 } });
  });

  it('rejected rate limit + is_error result → fatal RATE_LIMIT with the provider reset time', () => {
    const parse = createClaudeEventParser();
    const warning = parse(rateLimitEvent('rejected'));
    const failure = parse(claudeResult({ is_error: true, result: "You've hit your limit · resets 3pm" }));

    expect(warning).toMatchObject({ type: 'error', errorKind: AdapterErrorKind.RATE_LIMIT, resetAt: new Date(1794979200 * 1000).toISOString() });
    expect(warning?.fatal).toBeUndefined();
    expect(failure).toMatchObject({
      type: 'error',
      fatal: true,
      errorKind: AdapterErrorKind.RATE_LIMIT,
      resetAt: new Date(1794979200 * 1000).toISOString(), // structured resetsAt wins over text parsing
    });
  });

  it('is_error with api_error_status 429 is a usage limit even without a rate_limit_event', () => {
    const event = createClaudeEventParser()(claudeResult({ is_error: true, subtype: 'error_during_execution', result: '', api_error_status: 429 }));
    expect(event).toMatchObject({ type: 'error', fatal: true, errorKind: AdapterErrorKind.RATE_LIMIT });
  });

  it('legacy "usage limit reached|<epoch>" text carries its reset time', () => {
    const event = createClaudeEventParser()(claudeResult({ is_error: true, result: 'Claude AI usage limit reached|1794979200' }));
    expect(event).toMatchObject({ errorKind: AdapterErrorKind.RATE_LIMIT, resetAt: new Date(1794979200 * 1000).toISOString() });
  });

  it('max turns is a fatal failure but not a usage limit (previously counted as success)', () => {
    const event = createClaudeEventParser()(claudeResult({ is_error: true, subtype: 'error_max_turns', result: '' }));
    expect(event).toMatchObject({ type: 'error', fatal: true });
    expect(event?.errorKind).not.toBe(AdapterErrorKind.RATE_LIMIT);
    expect((event?.data as { message: string }).message).toContain('max turns');
  });
});

describe('Codex parser', () => {
  it('turn.failed with a usage-limit message → fatal RATE_LIMIT with parsed reset time', () => {
    const before = Date.now();
    const event = createCodexEventParser()(line({
      type: 'turn.failed',
      error: { message: "You've hit your usage limit. Upgrade to Pro or try again in 1 hour 30 minutes." },
    }));

    expect(event).toMatchObject({ type: 'error', fatal: true, errorKind: AdapterErrorKind.RATE_LIMIT });
    const resetMs = Date.parse(event!.resetAt!);
    expect(resetMs - before).toBeGreaterThanOrEqual(90 * 60_000 - 1_000);
    expect(resetMs - before).toBeLessThanOrEqual(90 * 60_000 + 5_000);
  });

  it('a transient error event (reconnecting) is not fatal', () => {
    const event = createCodexEventParser()(line({ type: 'error', message: 'stream disconnected — reconnecting 1/5' }));
    expect(event?.type).toBe('error');
    expect(event?.fatal).toBeUndefined();
  });
});

describe('Antigravity parser', () => {
  it('aggregates agent_response deltas into one output and maps a SUCCESS result to done', () => {
    const p = createAntigravityParser();
    expect(p.parse(line({ event: 'init', conversation_id: 'c' }))).toBeNull();
    expect(p.parse(line({ event: 'step_update', step_update: { step_index: 0, state: 'DONE', step_type: 'user_input' } }))).toBeNull();
    expect(p.parse(line({ event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Hel' } }))).toBeNull();
    const output = p.parse(line({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'lo\n' } }));
    const done = p.parse(line({
      event: 'result',
      result: { status: 'SUCCESS', response: 'Hello\n', usage: { input_tokens: 8834, output_tokens: 21, thinking_tokens: 19, cache_read_tokens: 0 } },
    }));

    expect(output).toMatchObject({ type: 'output', data: { text: 'Hello' } });
    expect(done).toMatchObject({ type: 'done', data: { result: 'Hello' }, tokens: { input: 8834, output: 21, reasoning: 19 } });
    expect(p.sawResult).toBe(true);
  });

  it('maps an ERROR result to a fatal error (real shape: invalid model)', () => {
    const event = createAntigravityParser().parse(line({
      event: 'result',
      result: { status: 'ERROR', response: '', error: 'invalid model selection (--model "x"): model x is not recognized' },
    }));
    expect(event).toMatchObject({ type: 'error', fatal: true });
    expect(event?.errorKind).not.toBe(AdapterErrorKind.RATE_LIMIT);
  });

  it('maps a quota ERROR result to RATE_LIMIT with a reset time when given', () => {
    const before = Date.now();
    const event = createAntigravityParser().parse(line({
      event: 'result',
      result: { status: 'ERROR', error: 'RESOURCE_EXHAUSTED: quota exceeded. Please retry in 45s.' },
    }));
    expect(event).toMatchObject({ type: 'error', fatal: true, errorKind: AdapterErrorKind.RATE_LIMIT });
    expect(Date.parse(event!.resetAt!) - before).toBeGreaterThanOrEqual(44_000);
  });

  it('still streams plain-text lines (older agy without stream-json)', () => {
    const p = createAntigravityParser();
    expect(p.parse('plain line')).toMatchObject({ type: 'output', data: { text: 'plain line' } });
    expect(p.plainText).toBe('plain line');
    expect(p.sawResult).toBe(false);
  });
});
