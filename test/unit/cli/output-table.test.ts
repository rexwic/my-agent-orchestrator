/** Tables line up when cells contain CJK (2-column) characters. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { printTable, printKeyValue, truncateToWidth } from '../../../src/cli/output.js';
import { textDisplayWidth } from '../../../src/tui/text-cursor.js';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

function capture(fn: () => void): string[] {
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  fn();
  const out = spy.mock.calls.map(([s]) => String(s)).join('');
  spy.mockRestore();
  return strip(out).split('\n').filter(Boolean);
}

afterEach(() => vi.restoreAllMocks());

describe('CJK-aware tables', () => {
  it('columns start at the same terminal column on every row', () => {
    const lines = capture(() => printTable(['KEY', 'TITLE', 'ROLE'], [
      ['a', '折扣 API 契約', 'backend'],
      ['bb', 'Discount screen', 'frontend'],
    ]));
    const roleCol = lines.map((l) => {
      const at = l.search(/ROLE|backend|frontend/);
      return textDisplayWidth(l.slice(0, at));
    });
    expect(new Set(roleCol).size).toBe(1);
  });

  it('key/value pairs align with CJK keys', () => {
    const lines = capture(() => printKeyValue([['目標', 'x'], ['Status', 'y']]));
    expect(textDisplayWidth(lines[0]!.slice(0, lines[0]!.indexOf('x')))).toBe(textDisplayWidth(lines[1]!.slice(0, lines[1]!.indexOf('y'))));
  });

  it('truncates by display width', () => {
    expect(truncateToWidth('abcdef', 10)).toBe('abcdef');
    const cut = truncateToWidth('訂單折扣功能支援百分比', 9);
    expect(cut).toBe('訂單折扣…');
    expect(textDisplayWidth(cut)).toBeLessThanOrEqual(9);
  });
});
