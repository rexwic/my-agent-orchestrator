/**
 * ShellRunner against real processes (the platform shell + node).
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import { ProcessManager } from '../../../src/infrastructure/process/process-manager.js';
import { ShellRunner } from '../../../src/infrastructure/process/shell-runner.js';

const node = JSON.stringify(process.execPath);
const runner = new ShellRunner(new ProcessManager());
const cwd = os.tmpdir();

describe('ShellRunner', { timeout: 30_000 }, () => {
  it('returns exit code 0 and captures stdout and stderr', async () => {
    const result = await runner.run(`${node} -e "console.log('out'); console.error('err')"`, { cwd, timeoutMs: 15_000 });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.output).toContain('out');
    expect(result.output).toContain('err');
  });

  it('returns the non-zero exit code', async () => {
    const result = await runner.run(`${node} -e "process.exit(3)"`, { cwd, timeoutMs: 15_000 });

    expect(result.exitCode).toBe(3);
  });

  it('interprets the command line with the shell (&&)', async () => {
    const result = await runner.run(`${node} -e "console.log('a')" && ${node} -e "console.log('b')"`, { cwd, timeoutMs: 15_000 });

    expect(result.exitCode).toBe(0);
    expect(result.output.replace(/\r/g, '')).toMatch(/a\nb/);
  });

  it('runs in the given cwd', async () => {
    const result = await runner.run(`${node} -e "console.log(process.cwd())"`, { cwd, timeoutMs: 15_000 });

    expect(result.output.toLowerCase()).toContain(os.tmpdir().toLowerCase().slice(-10));
  });

  it('times out, kills the process tree and reports timedOut', async () => {
    // Shell → node parent → node child: the child must die too, or a hung build would linger.
    const child = `require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); setTimeout(() => {}, 60000)`;
    const started = Date.now();

    const result = await runner.run(`${node} -e "${child}"`, { cwd, timeoutMs: 1_000 });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('keeps only the tail of very long output', async () => {
    const result = await runner.run(`${node} -e "process.stdout.write('x'.repeat(200000) + 'END')"`, { cwd, timeoutMs: 15_000 });

    expect(result.output.endsWith('END')).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(64 * 1024);
  });
});
