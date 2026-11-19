import { describe, it, expect } from 'vitest';
import { validateReviewSubmission, describeFinding, type ReviewFinding } from '../../../src/domain/review.js';

describe('validateReviewSubmission', () => {
  it('round 1: numbers findings; only must-fix blocks', () => {
    const r = validateReviewSubmission({
      summary: 'Mostly fine',
      findings: [
        { severity: 'must-fix', file: 'A.java', line: 3, issue: 'NPE when cart is empty', suggestion: 'guard' },
        { severity: 'nit', issue: 'naming' },
      ],
    }, { round: 1, previous: [] });
    expect(r.errors).toEqual([]);
    expect(r.submission).toMatchObject({ verdict: 'changes', blocking: ['F1'], summary: 'Mostly fine' });
    expect(r.submission!.findings.map((f) => [f.id, f.severity, f.round])).toEqual([['F1', 'must-fix', 1], ['F2', 'nit', 1]]);
    expect(describeFinding(r.submission!.findings[0]!)).toBe('F1 [must-fix] A.java:3 — NPE when cart is empty (suggestion: guard)');
  });

  it('no findings passes', () => {
    expect(validateReviewSubmission({ summary: 'Good' }, { round: 1, previous: [] }).submission).toMatchObject({ verdict: 'passed', blocking: [] });
  });

  it('round 2 verifies every earlier must-fix; new must-fix cannot block', () => {
    const previous: ReviewFinding[] = [
      { id: 'F1', severity: 'must-fix', issue: 'a', round: 1 },
      { id: 'F2', severity: 'should', issue: 'b', round: 1 },
      { id: 'F3', severity: 'must-fix', issue: 'c', round: 1 },
    ];
    const missing = validateReviewSubmission({ checks: [{ id: 'F1', fixed: true }] }, { round: 2, previous });
    expect(missing.errors).toEqual(['checks: verify every earlier must-fix finding (missing: F3)']);

    const r = validateReviewSubmission({
      checks: [{ id: 'F1', fixed: true }, { id: 'F3', fixed: false, note: 'still throws' }],
      findings: [{ severity: 'must-fix', issue: 'new thing' }],
    }, { round: 2, previous });
    expect(r.submission).toMatchObject({ verdict: 'changes', blocking: ['F3'] });
    expect(r.submission!.findings[0]).toMatchObject({ id: 'F4', severity: 'should', round: 2 });
    expect(r.submission!.notes[0]).toMatch(/F4: round 2 only verifies earlier findings/);

    const fixed = validateReviewSubmission({ checks: [{ id: 'F1', fixed: true }, { id: 'F3', fixed: true }] }, { round: 2, previous });
    expect(fixed.submission!.verdict).toBe('passed');
  });

  it('reports every problem at once', () => {
    const r = validateReviewSubmission({
      verdict: 'ok',
      findings: [{ severity: 'blocker', line: 0 }],
      checks: [{ id: 'F9', fixed: true }],
    }, { round: 1, previous: [] });
    expect(r.errors).toEqual([
      'Unknown field "verdict" (allowed: summary, findings, checks)',
      'findings[0]: severity must be one of must-fix, should, nit',
      'findings[0]: issue is required (what is wrong)',
      'findings[0]: line must be a positive integer',
      'checks are for round 2 (verifying earlier findings); round 1 lists findings only',
    ]);
  });
});
