import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureCliShim, cliEntryFromArgv, prependPath } from '../../../src/infrastructure/process/cli-shim.js';

const isWindows = process.platform === 'win32';
const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0;

describe('cli shim', () => {
  let dir: string;
  let entry: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orch shim-')); // space on purpose
    entry = path.join(dir, 'cli.cjs');
    await fs.writeFile(entry, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('writes an sh launcher everywhere and an orch.cmd on Windows, only when content changes', async () => {
    const binDir = path.join(dir, 'bin');
    await ensureCliShim({ binDir, execPath: 'C:\\node\\node.exe', entry: 'C:\\app\\cli.js', platform: 'win32' });

    const sh = await fs.readFile(path.join(binDir, 'orch'), 'utf-8');
    const cmd = await fs.readFile(path.join(binDir, 'orch.cmd'), 'utf-8');
    expect(sh).toBe(`#!/bin/sh\nexec 'C:/node/node.exe' 'C:/app/cli.js' "$@"\n`);
    expect(cmd).toBe(`@echo off\r\n"C:\\node\\node.exe" "C:\\app\\cli.js" %*\r\n`);

    const before = (await fs.stat(path.join(binDir, 'orch.cmd'))).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await ensureCliShim({ binDir, execPath: 'C:\\node\\node.exe', entry: 'C:\\app\\cli.js', platform: 'win32' });
    expect((await fs.stat(path.join(binDir, 'orch.cmd'))).mtimeMs).toBe(before);
  });

  it('keeps loader flags (tsx in development) but not others', async () => {
    const binDir = path.join(dir, 'bin');
    await ensureCliShim({
      binDir, execPath: '/usr/bin/node', entry: '/app/src/bin/cli.ts', platform: 'linux',
      execArgv: ['--inspect=9229', '--require', '/tsx/preflight.cjs', '--import', 'file:///tsx/loader.mjs', '--max-old-space-size=4096'],
    });
    const sh = await fs.readFile(path.join(binDir, 'orch'), 'utf-8');
    expect(sh).toContain(`'--require' '/tsx/preflight.cjs' '--import' 'file:///tsx/loader.mjs' '/app/src/bin/cli.ts'`);
    expect(sh).not.toContain('inspect');
    expect(sh).not.toContain('max-old-space');
    await expect(fs.access(path.join(binDir, 'orch.cmd'))).rejects.toThrow();
  });

  it.skipIf(!isWindows)('orch.cmd really runs the CLI with the arguments intact', async () => {
    const binDir = await ensureCliShim({ binDir: path.join(dir, 'bin'), execPath: process.execPath, entry });
    const out = execFileSync('cmd.exe', ['/d', '/s', '/c', `""${path.join(binDir, 'orch.cmd')}" decision request "Money type?" --option BigDecimal"`], { encoding: 'utf-8', windowsVerbatimArguments: true });
    expect(JSON.parse(out)).toEqual(['decision', 'request', 'Money type?', '--option', 'BigDecimal']);
  });

  it.skipIf(!hasSh)('the sh launcher really runs the CLI with the arguments intact', async () => {
    const binDir = await ensureCliShim({ binDir: path.join(dir, 'bin'), execPath: process.execPath, entry });
    const out = execFileSync('sh', [path.join(binDir, 'orch').replace(/\\/g, '/'), 'decision', 'request', 'it\'s "quoted" & spaced'], { encoding: 'utf-8' });
    expect(JSON.parse(out)).toEqual(['decision', 'request', 'it\'s "quoted" & spaced']);
  });

  it('recognizes the orch CLI entry in argv', () => {
    expect(cliEntryFromArgv(['node', '/usr/lib/node_modules/@oxgeneral/orch/dist/cli.js', 'serve'])).toBe(path.resolve('/usr/lib/node_modules/@oxgeneral/orch/dist/cli.js'));
    expect(cliEntryFromArgv(['node', '/repo/src/bin/cli.ts'])).toBe(path.resolve('/repo/src/bin/cli.ts'));
    expect(cliEntryFromArgv(['node', '/repo/node_modules/vitest/vitest.mjs'])).toBeUndefined();
  });
});

describe('prependPath', () => {
  it('reuses the existing PATH key spelling (Windows: Path) instead of adding a second one', () => {
    const env = prependPath({ ORCH_TASK_ID: 'tsk_1' }, 'C:\\proj\\.orchestry\\bin', { Path: 'C:\\Windows' }, 'win32');
    expect(env).toEqual({ ORCH_TASK_ID: 'tsk_1', Path: 'C:\\proj\\.orchestry\\bin;C:\\Windows' });
  });

  it('prepends to a PATH given in the agent env (role env) and uses ":" on posix', () => {
    expect(prependPath({ PATH: '/custom' }, '/proj/.orchestry/bin', { PATH: '/usr/bin' }, 'linux'))
      .toEqual({ PATH: '/proj/.orchestry/bin:/custom' });
  });
});
