/**
 * Cross-platform command resolution.
 *
 * On Windows, Node's spawn/execFile (without a shell) only finds `.exe`/`.com`
 * files on PATH. CLIs installed via npm are `.cmd` shims, so `spawn('codex')`
 * fails with ENOENT. Running them through `shell: true` is not an option for
 * agent prompts: cmd.exe cannot carry newlines in arguments and would expand
 * `%VAR%` / metacharacters.
 *
 * Strategy on win32:
 *  1. Look the command up on PATH × PATHEXT.
 *  2. `.exe` / `.com` → spawn as-is (Node finds it too).
 *  3. npm `.cmd` shim → parse the target script out of the shim and spawn
 *     `node <script> ...args` directly — no cmd.exe involved.
 *  4. Any other `.cmd` / `.bat` → run via the shell, quoting arguments and
 *     rejecting characters cmd.exe cannot pass through safely.
 *
 * On every other platform this is the identity function.
 */

import { execFile, spawn, type ChildProcess, type ExecFileOptions, type SpawnOptions } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export interface ResolvedCommand {
  command: string;
  args: string[];
  /** True when the command must be run through cmd.exe. */
  shell: boolean;
}

export interface ResolveDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  execPath: string;
  isFile(p: string): boolean;
  readFile(p: string): string;
}

const defaultDeps: ResolveDeps = {
  platform: process.platform,
  env: process.env,
  execPath: process.execPath,
  isFile: (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
  readFile: (p) => readFileSync(p, 'utf-8'),
};

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * npm cmd-shim target: the last quoted `%dp0%\...` / `%~dp0\...` path followed by `%*`.
 *   modern: "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
 *   legacy: "%~dp0\node.exe"  "%~dp0\..\foo\bin\foo.js" %*
 */
const NPM_SHIM_TARGET = /"%~?dp0%?\\([^"]+)"\s+%\*/i;

/** Characters cmd.exe cannot pass through a quoted argument without re-interpreting them. */
const CMD_UNSAFE = /["%\r\n]/;
/** Characters that require quoting for cmd.exe. */
const CMD_NEEDS_QUOTES = /[\s&|<>^()]/;

const resolutionCache = new Map<string, ResolvedCommand | null>();

/** Clear the resolution cache (tests). */
export function clearResolveCache(): void {
  resolutionCache.clear();
}

export function resolveCommand(
  command: string,
  args: readonly string[],
  deps: ResolveDeps = defaultDeps,
): ResolvedCommand {
  if (deps.platform !== 'win32') {
    return { command, args: [...args], shell: false };
  }

  const useCache = deps === defaultDeps;
  const cacheKey = `${command}\0${getEnv(deps.env, 'PATH') ?? ''}`;
  let base: ResolvedCommand | null | undefined = useCache ? resolutionCache.get(cacheKey) : undefined;
  if (base === undefined) {
    base = resolveWin32(command, deps);
    if (useCache && base) resolutionCache.set(cacheKey, base);
  }

  // Not found on PATH: pass through unchanged so spawn reports ENOENT as before.
  if (!base) return { command, args: [...args], shell: false };

  if (base.shell) {
    return {
      command: quoteForCmd(base.command, command),
      args: args.map((a) => quoteForCmd(a, command)),
      shell: true,
    };
  }
  return { command: base.command, args: [...base.args, ...args], shell: false };
}

/** Resolve the command itself (without call-site args). Returns null if not found. */
function resolveWin32(command: string, deps: ResolveDeps): ResolvedCommand | null {
  const found = findOnPath(command, deps);
  if (!found) return null;

  const ext = path.win32.extname(found).toLowerCase();
  if (ext === '.exe' || ext === '.com') {
    // Node resolves these itself — keep the original name for stable logs/tests.
    return { command, args: [], shell: false };
  }

  if (ext === '.cmd' || ext === '.bat') {
    let content = '';
    try {
      content = deps.readFile(found);
    } catch {
      // unreadable — fall back to shell
    }
    const match = NPM_SHIM_TARGET.exec(content);
    if (match?.[1]) {
      const dir = path.win32.dirname(found);
      const target = path.win32.join(dir, match[1]);
      const targetExt = path.win32.extname(target).toLowerCase();
      if (targetExt === '.exe' || targetExt === '.com') {
        return { command: target, args: [], shell: false };
      }
      const localNode = path.win32.join(dir, 'node.exe');
      const node = deps.isFile(localNode) ? localNode : deps.execPath;
      return { command: node, args: [target], shell: false };
    }
  }

  return { command: found, args: [], shell: true };
}

function findOnPath(command: string, deps: ResolveDeps): string | null {
  const exts = (getEnv(deps.env, 'PATHEXT') ?? DEFAULT_PATHEXT)
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  const hasExt = exts.includes(path.win32.extname(command).toLowerCase());
  const candidatesFor = (base: string): string[] =>
    hasExt ? [base] : exts.map((e) => base + e);

  // Explicit path (relative or absolute) — don't search PATH.
  if (command.includes('/') || command.includes('\\')) {
    return candidatesFor(command).find((c) => deps.isFile(c)) ?? null;
  }

  const dirs = (getEnv(deps.env, 'PATH') ?? '').split(';').map((d) => d.replace(/^"|"$/g, '')).filter(Boolean);
  for (const dir of dirs) {
    for (const candidate of candidatesFor(path.win32.join(dir, command))) {
      if (deps.isFile(candidate)) return candidate;
    }
  }
  return null;
}

/** Windows env vars are case-insensitive. */
function getEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name && env[k] !== undefined);
  return key ? env[key] : undefined;
}

function quoteForCmd(arg: string, command: string): string {
  if (CMD_UNSAFE.test(arg)) {
    throw new Error(
      `Cannot pass argument to "${command}" through cmd.exe: it contains a quote, percent sign or newline. ` +
      'Install a native executable or npm-installed version of the CLI instead.',
    );
  }
  return arg === '' || CMD_NEEDS_QUOTES.test(arg) ? `"${arg}"` : arg;
}

/**
 * spawn() with Windows command resolution. Same signature as child_process.spawn.
 */
export function spawnCommand(command: string, args: readonly string[], options: SpawnOptions = {}): ChildProcess {
  const resolved = resolveCommand(command, args);
  return spawn(resolved.command, resolved.args, {
    windowsHide: true,
    ...options,
    ...(resolved.shell ? { shell: true } : {}),
  });
}

/**
 * Promise-based execFile() with Windows command resolution.
 * Rejects with the original error (stdout/stderr attached) on non-zero exit.
 */
export function execCommand(
  command: string,
  args: readonly string[],
  options?: ExecFileOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let resolved: ResolvedCommand;
    try {
      resolved = resolveCommand(command, args);
    } catch (err) {
      reject(err);
      return;
    }
    const callback = (err: Error | null, stdout: string | Buffer, stderr: string | Buffer): void => {
      if (err) {
        reject(Object.assign(err, { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
      } else {
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      }
    };
    const opts = resolved.shell ? { ...options, shell: true } : options;
    if (opts) {
      execFile(resolved.command, resolved.args, { windowsHide: true, ...opts }, callback);
    } else {
      execFile(resolved.command, resolved.args, callback);
    }
  });
}
