/**
 * Launchers for the orch CLI in .orchestry/bin/, put first on every agent's
 * PATH so agents can run `orch decision request …` whether or not orch is
 * installed globally. They start the same CLI (and Node) that runs ORCH.
 *
 * Windows gets both `orch.cmd` (cmd / PowerShell) and an `orch` sh script
 * (Git Bash, which Claude Code uses); other platforms get the sh script.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir } from '../storage/fs-utils.js';

export interface CliShimOptions {
  binDir: string;
  /** Node binary (process.execPath). */
  execPath: string;
  /** Node flags the CLI runs with, e.g. a tsx loader in development (process.execArgv). */
  execArgv?: string[];
  /** The CLI entry script (dist/cli.js, or src/bin/cli.ts under tsx). */
  entry: string;
  platform?: NodeJS.Platform;
}

const ENTRY_NAME = /^(cli|orch|orchestry|ao)(\.(c|m)?[jt]s)?$/i;

/** The orch CLI entry script this process runs, if it is one. */
export function cliEntryFromArgv(argv: readonly string[] = process.argv): string | undefined {
  const entry = argv[1];
  return entry && ENTRY_NAME.test(path.basename(entry)) ? path.resolve(entry) : undefined;
}

/** Write the launchers (only when their content changed). Returns the bin directory. */
export async function ensureCliShim(opts: CliShimOptions): Promise<string> {
  const platform = opts.platform ?? process.platform;
  // Loader flags only (e.g. tsx --import/--require); not inspector or similar.
  const flags = keepLoaderFlags(opts.execArgv ?? []);
  await ensureDir(opts.binDir);

  const slash = (p: string) => p.replace(/\\/g, '/');
  const sh = `#!/bin/sh\nexec ${[opts.execPath, ...flags, opts.entry].map((a) => shQuote(slash(a))).join(' ')} "$@"\n`;
  await writeIfChanged(path.join(opts.binDir, 'orch'), sh, 0o755);

  if (platform === 'win32') {
    const cmd = `@echo off\r\n${[opts.execPath, ...flags, opts.entry].map(cmdQuote).join(' ')} %*\r\n`;
    await writeIfChanged(path.join(opts.binDir, 'orch.cmd'), cmd);
  }
  return opts.binDir;
}

/**
 * Env with `dir` first on PATH, using the PATH key's existing spelling
 * (Windows has `Path`; two differently-cased keys would conflict).
 */
export function prependPath(env: Record<string, string | undefined>, dir: string, base: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')
    ?? Object.keys(base).find((k) => k.toUpperCase() === 'PATH')
    ?? 'PATH';
  const current = env[key] ?? base[key] ?? '';
  const delimiter = platform === 'win32' ? ';' : ':';
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) result[k] = v;
  result[key] = current ? `${dir}${delimiter}${current}` : dir;
  return result;
}

function keepLoaderFlags(execArgv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < execArgv.length; i++) {
    const arg = execArgv[i]!;
    if (/^--(import|require|loader|experimental-loader)$/.test(arg) && execArgv[i + 1] !== undefined) {
      out.push(arg, execArgv[++i]!);
    } else if (/^--(import|require|loader|experimental-loader)=/.test(arg) || /^-r$/.test(arg)) {
      out.push(arg);
      if (arg === '-r' && execArgv[i + 1] !== undefined) out.push(execArgv[++i]!);
    }
  }
  return out;
}

function shQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function cmdQuote(arg: string): string {
  return `"${arg.replace(/"/g, '""')}"`;
}

async function writeIfChanged(file: string, content: string, mode?: number): Promise<void> {
  const current = await fs.readFile(file, 'utf-8').catch(() => null);
  if (current === content) return;
  await fs.writeFile(file, content, mode === undefined ? undefined : { mode });
  if (mode !== undefined) await fs.chmod(file, mode).catch(() => {});
}
