import { describe, it, expect, vi } from 'vitest';
import {
  ReviewRunner,
  resolveReviewCommand,
  DEFAULT_REVIEW_COMMANDS,
  DEFAULT_REVIEW_TIMEOUT_MS,
} from '../../../src/application/review-runner.js';
import type { ReviewResult } from '../../../src/domain/task.js';
import type { IShellRunner, ShellRunResult } from '../../../src/infrastructure/process/shell-runner.js';

function fakeShell(...results: ShellRunResult[]): IShellRunner & { run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(async () => results.shift() ?? { exitCode: 0, output: 'ok', timedOut: false });
  return { run };
}

const pass: ShellRunResult = { exitCode: 0, output: 'ok', timedOut: false };
const fail: ShellRunResult = { exitCode: 1, output: 'boom', timedOut: false };

describe('resolveReviewCommand', () => {
  it('falls back to the built-in default when nothing is configured', () => {
    expect(resolveReviewCommand('test_pass', undefined, 'linux')).toBe('npm test');
    expect(resolveReviewCommand('typecheck', {}, 'linux')).toBe(DEFAULT_REVIEW_COMMANDS.typecheck);
  });

  it('uses a plain string on every platform', () => {
    const commands = { test_pass: './gradlew test' };
    expect(resolveReviewCommand('test_pass', commands, 'darwin')).toBe('./gradlew test');
    expect(resolveReviewCommand('test_pass', commands, 'win32')).toBe('./gradlew test');
  });

  it('prefers the platform key, then default', () => {
    const commands = { test_pass: { default: './mvnw -q test', win32: 'mvnw.cmd -q test' } };
    expect(resolveReviewCommand('test_pass', commands, 'win32')).toBe('mvnw.cmd -q test');
    expect(resolveReviewCommand('test_pass', commands, 'darwin')).toBe('./mvnw -q test');
  });

  it('falls back to the built-in default when a platform map has no match', () => {
    expect(resolveReviewCommand('lint', { lint: { win32: 'mvnw.cmd checkstyle:check' } }, 'linux')).toBe('npm run lint');
  });

  it('ignores blank and non-string values', () => {
    expect(resolveReviewCommand('test_pass', { test_pass: '   ' }, 'linux')).toBe('npm test');
    expect(resolveReviewCommand('test_pass', { test_pass: { win32: ' ', default: 'mvn test' } }, 'win32')).toBe('mvn test');
    expect(resolveReviewCommand('test_pass', { test_pass: 42 as unknown as string }, 'linux')).toBe('npm test');
  });
});

describe('ReviewRunner', () => {
  describe('runAll', () => {
    it('runs each criterion through the shell in the given cwd', async () => {
      const shell = fakeShell(pass, pass);
      const runner = new ReviewRunner({ cwd: '/proj', shell, platform: 'linux' });

      const results = await runner.runAll(['test_pass', 'typecheck']);

      expect(results.map((r) => [r.criterion, r.passed])).toEqual([['typecheck', true], ['test_pass', true]]);
      expect(shell.run).toHaveBeenCalledWith('npx tsc --noEmit', { cwd: '/proj', timeoutMs: DEFAULT_REVIEW_TIMEOUT_MS });
      expect(shell.run).toHaveBeenCalledWith('npm test', { cwd: '/proj', timeoutMs: DEFAULT_REVIEW_TIMEOUT_MS });
    });

    it('sorts criteria: typecheck → lint → test_pass', async () => {
      const shell = fakeShell();
      const runner = new ReviewRunner({ cwd: '/proj', shell, platform: 'linux' });

      const results = await runner.runAll(['test_pass', 'lint', 'typecheck']);

      expect(results.map((r) => r.criterion)).toEqual(['typecheck', 'lint', 'test_pass']);
    });

    it('stops on first failure in fail-fast mode (default)', async () => {
      const shell = fakeShell(fail);
      const runner = new ReviewRunner({ cwd: '/proj', shell, platform: 'linux' });

      const results = await runner.runAll(['typecheck', 'test_pass']);

      expect(results).toHaveLength(1);
      expect(results[0]!.passed).toBe(false);
      expect(shell.run).toHaveBeenCalledTimes(1);
    });

    it('runs all criteria when fail_fast is false', async () => {
      const shell = fakeShell(fail, pass);
      const runner = new ReviewRunner({ cwd: '/proj', shell, platform: 'linux', fail_fast: false });

      const results = await runner.runAll(['typecheck', 'test_pass']);

      expect(results.map((r) => r.passed)).toEqual([false, true]);
    });

    it('uses configured commands and timeout', async () => {
      const shell = fakeShell();
      const runner = new ReviewRunner({
        cwd: '/svc',
        shell,
        platform: 'win32',
        review: { timeout_ms: 900_000, commands: { test_pass: { default: './mvnw -q test', win32: 'mvnw.cmd -q test' } } },
      });

      await runner.runAll(['test_pass']);

      expect(shell.run).toHaveBeenCalledWith('mvnw.cmd -q test', { cwd: '/svc', timeoutMs: 900_000 });
    });

    it('records the command and exit code in the output', async () => {
      const runner = new ReviewRunner({ cwd: '/proj', shell: fakeShell({ exitCode: 1, output: 'Tests run: 3, Failures: 1', timedOut: false }), platform: 'linux' });

      const [result] = await runner.runAll(['test_pass']);

      expect(result!.output).toBe('$ npm test  (exit 1)\nTests run: 3, Failures: 1');
    });

    it('treats a timeout as a failure even with exit code 0', async () => {
      const runner = new ReviewRunner({
        cwd: '/proj',
        shell: fakeShell({ exitCode: 0, output: '', timedOut: true }),
        platform: 'linux',
        review: { timeout_ms: 5_000 },
      });

      const [result] = await runner.runAll(['test_pass']);

      expect(result!.passed).toBe(false);
      expect(result!.output).toContain('timed out after 5s');
    });

    it('treats a command that could not start as a failure', async () => {
      const runner = new ReviewRunner({ cwd: '/proj', shell: fakeShell({ exitCode: null, output: 'spawn ENOENT', timedOut: false }), platform: 'linux' });

      const [result] = await runner.runAll(['lint']);

      expect(result!.passed).toBe(false);
      expect(result!.output).toContain('failed to run');
    });

    it('keeps the tail of long output (failure summaries are printed last)', async () => {
      const output = 'x'.repeat(5000) + 'BUILD FAILURE';
      const runner = new ReviewRunner({ cwd: '/proj', shell: fakeShell({ exitCode: 1, output, timedOut: false }), platform: 'linux' });

      const [result] = await runner.runAll(['test_pass']);

      expect(result!.output.endsWith('BUILD FAILURE')).toBe(true);
      expect(result!.output.length).toBeLessThan(2100);
    });
  });

  describe('allPassed', () => {
    it('returns true when all passed', () => {
      expect(ReviewRunner.allPassed([{ criterion: 'test_pass', passed: true, output: '' }])).toBe(true);
    });

    it('returns false when any failed or when empty', () => {
      const results: ReviewResult[] = [
        { criterion: 'test_pass', passed: true, output: '' },
        { criterion: 'lint', passed: false, output: '' },
      ];
      expect(ReviewRunner.allPassed(results)).toBe(false);
      expect(ReviewRunner.allPassed([])).toBe(false);
    });
  });

  describe('formatReport', () => {
    it('formats results with icons', () => {
      const report = ReviewRunner.formatReport([
        { criterion: 'typecheck', passed: true, output: 'ok' },
        { criterion: 'test_pass', passed: false, output: 'boom' },
      ]);
      expect(report).toContain('✓ typecheck: PASSED');
      expect(report).toContain('✗ test_pass: FAILED');
    });
  });
});
