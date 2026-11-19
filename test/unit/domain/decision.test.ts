import { describe, it, expect } from 'vitest';
import {
  normalizeDecisionRequest,
  resolveDecisionAnswer,
  describeAnswer,
  type Decision,
} from '../../../src/domain/decision.js';
import { canTransition, isDispatchable, isTerminal } from '../../../src/domain/transitions.js';

const decision = (over: Partial<Decision> = {}): Decision => ({
  id: 'dec_1',
  status: 'pending',
  source: 'agent',
  question: 'BigDecimal or long for money?',
  options: ['BigDecimal', 'long'],
  requested_by: 'backend-1',
  created_at: '2026-11-19T00:00:00.000Z',
  ...over,
});

describe('normalizeDecisionRequest', () => {
  it('trims, drops empty/duplicate options, and requires a question', () => {
    expect(normalizeDecisionRequest({ source: 'agent', question: '  Which DB?  ', options: ['pg', ' pg ', '', 'mysql'] }))
      .toMatchObject({ question: 'Which DB?', options: ['pg', 'mysql'] });
    expect(() => normalizeDecisionRequest({ source: 'agent', question: '   ' })).toThrow(/needs a question/);
  });

  it('caps the number of options and the context size', () => {
    expect(() => normalizeDecisionRequest({ source: 'agent', question: 'q', options: Array.from({ length: 11 }, (_, i) => `o${i}`) }))
      .toThrow(/At most 10/);
    const req = normalizeDecisionRequest({ source: 'escalation', question: 'q', context: 'x'.repeat(10_000) + 'END' });
    expect(req.context!.length).toBe(8000);
    expect(req.context!.endsWith('END')).toBe(true); // keeps the tail (latest output)
  });
});

describe('resolveDecisionAnswer', () => {
  const now = new Date('2026-11-19T01:00:00.000Z');

  it('accepts an option by text (any case) or by number', () => {
    expect(resolveDecisionAnswer(decision(), { choice: 'bigdecimal' }, now)).toEqual({
      choice: 'BigDecimal', action: 'continue', scope: 'task', answered_at: now.toISOString(),
    });
    expect(resolveDecisionAnswer(decision(), { choice: '2', scope: 'project' }, now)).toMatchObject({ choice: 'long', scope: 'project' });
  });

  it('rejects a choice that is not an option, listing the options', () => {
    expect(() => resolveDecisionAnswer(decision(), { choice: 'float' })).toThrow(/"float" is not an option/);
    try {
      resolveDecisionAnswer(decision(), { choice: '3' });
    } catch (err) {
      expect((err as { hint?: string }).hint).toContain('1. BigDecimal');
    }
  });

  it('continuing needs a choice or a message; approve/cancel do not', () => {
    expect(() => resolveDecisionAnswer(decision(), {})).toThrow(/needs a choice or a message/);
    expect(resolveDecisionAnswer(decision({ options: [] }), { message: 'Use BigDecimal everywhere' })).toMatchObject({ message: 'Use BigDecimal everywhere' });
    expect(resolveDecisionAnswer(decision(), { action: 'approve' })).toMatchObject({ action: 'approve' });
    expect(resolveDecisionAnswer(decision(), { action: 'cancel' })).toMatchObject({ action: 'cancel' });
  });

  it('a free-text choice is allowed when the decision has no options', () => {
    expect(resolveDecisionAnswer(decision({ options: [] }), { choice: 'whatever' })).toMatchObject({ choice: 'whatever' });
  });
});

describe('describeAnswer', () => {
  it('joins choice and message, falls back to the action', () => {
    expect(describeAnswer(decision({ answer: { choice: 'BigDecimal', message: 'scale 2', action: 'continue', scope: 'task', answered_at: '' } })))
      .toBe('BigDecimal — scale 2');
    expect(describeAnswer(decision({ answer: { action: 'approve', scope: 'task', answered_at: '' } }))).toBe('approve');
    expect(describeAnswer(decision())).toBe('');
  });
});

describe('waiting_decision in the state machine', () => {
  it('is entered from todo / in_progress / retrying / review and left to todo / review / cancelled', () => {
    for (const from of ['todo', 'in_progress', 'retrying', 'review'] as const) {
      expect(canTransition(from, 'waiting_decision')).toBe(true);
    }
    expect(canTransition('waiting_decision', 'todo')).toBe(true);
    expect(canTransition('waiting_decision', 'review')).toBe(true);
    expect(canTransition('waiting_decision', 'cancelled')).toBe(true);
    expect(canTransition('waiting_decision', 'done')).toBe(false);
    expect(canTransition('waiting_decision', 'in_progress')).toBe(false);
  });

  it('is neither dispatchable nor terminal', () => {
    expect(isDispatchable('waiting_decision')).toBe(false);
    expect(isTerminal('waiting_decision')).toBe(false);
  });
});
