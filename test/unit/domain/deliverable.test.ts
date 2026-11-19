import { describe, it, expect } from 'vitest';
import { validateReport, needsDeliveryReport, parseDeliveryStatus, DEFAULT_REPORT_SECTIONS } from '../../../src/domain/deliverable.js';
import { matchesPattern, normalizeRelativePath } from '../../../src/domain/scope.js';
import type { Task } from '../../../src/domain/task.js';

const good = `# Report
## Summary
Added the discount API.

## Verification
mvn test: 12 passed.

## Open issues
None.
`;

describe('validateReport', () => {
  it('accepts a report with every default section', () => {
    expect(validateReport(good, DEFAULT_REPORT_SECTIONS)).toEqual([]);
  });

  it('reports missing and empty sections', () => {
    const report = '## Summary\nDone.\n\n## Verification\n\n## Next\nx';
    expect(validateReport(report, DEFAULT_REPORT_SECTIONS)).toEqual([
      'Section "## Verification" is empty',
      'Missing section "## Open issues"',
    ]);
  });

  it('matches headings case-insensitively by prefix, at any level', () => {
    const report = '### summary of work\nok\n## VERIFICATION (manual)\nclicked it\n# Open issues / risks\n- none';
    expect(validateReport(report, DEFAULT_REPORT_SECTIONS)).toEqual([]);
  });

  it('a subsection counts as content of its parent section', () => {
    expect(validateReport('## Summary\n### Backend\nx\n## Verification\nok\n## Open issues\nnone', DEFAULT_REPORT_SECTIONS)).toEqual([]);
  });

  it('ignores headings inside code fences', () => {
    expect(validateReport('## Summary\n```\n## Verification\n```\n', ['Summary', 'Verification'])).toEqual(['Missing section "## Verification"']);
  });

  it('role sections (any language)', () => {
    expect(validateReport('## 重現步驟\n1. 打開頁面\n## 證據\n截圖', ['重現步驟', '證據'])).toEqual([]);
  });

  it('empty report', () => {
    expect(validateReport('  \n', DEFAULT_REPORT_SECTIONS)).toEqual(['The report is empty']);
  });
});

describe('needsDeliveryReport', () => {
  const task = { id: 't', labels: [] } as unknown as Task;
  it('agents must report; shell roles, paperwork and autonomous tasks do not; config can turn it off', () => {
    expect(needsDeliveryReport(task, 'claude', true)).toBe(true);
    expect(needsDeliveryReport(task, 'claude', false)).toBe(false);
    expect(needsDeliveryReport(task, 'shell', true)).toBe(false);
    expect(needsDeliveryReport({ ...task, plan_id: 'pln_1' }, 'claude', true)).toBe(false);
    expect(needsDeliveryReport({ ...task, prd_draft: 'discount' }, 'claude', true)).toBe(false);
    expect(needsDeliveryReport({ ...task, triage_decision_id: 'dec_1' }, 'claude', true)).toBe(false);
    expect(needsDeliveryReport({ ...task, labels: ['autonomous'] }, 'claude', true)).toBe(false);
  });
});

describe('parseDeliveryStatus', () => {
  it('accepts the three statuses only', () => {
    expect(parseDeliveryStatus('Blocked')).toBe('blocked');
    expect(() => parseDeliveryStatus('finished')).toThrow(/done, partial, blocked/);
  });
});

describe('matchesPattern', () => {
  it('globs and plain paths', () => {
    expect(matchesPattern('docs/api/discount.yaml', 'docs/api/**')).toBe(true);
    expect(matchesPattern('docs/api/discount.yaml', 'docs/**/*.yaml')).toBe(true);
    expect(matchesPattern('docs/discount.yaml', 'docs/**/*.yaml')).toBe(true);
    expect(matchesPattern('docs/api/discount.yaml', 'docs/*.yaml')).toBe(false);
    expect(matchesPattern('docs/api/discount.yaml', 'docs/api/discount.yaml')).toBe(true);
    expect(matchesPattern('docs/api/discount.yaml', 'docs/api')).toBe(true);
    expect(matchesPattern('docs/apis/x.yaml', 'docs/api')).toBe(false);
    expect(matchesPattern('src/a.ts', 'src/?.ts')).toBe(true);
  });

  it('normalizes Windows separators on both sides', () => {
    expect(matchesPattern('docs\\api\\discount.yaml', './docs/api/*.yaml')).toBe(true);
    expect(normalizeRelativePath(' .\\docs\\x.md ')).toBe('docs/x.md');
  });
});
