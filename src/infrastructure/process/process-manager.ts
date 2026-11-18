/**
 * Process management utilities.
 *
 * Handles spawning subprocesses, PID checks, graceful kill.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { Readable } from 'node:stream';
import { resolveCommand, type ResolvedCommand } from './resolve-command.js';

export interface SpawnResult {
  process: ChildProcess;
  pid: number;
}

export interface ManagedSpawnOptions extends SpawnOptions {
  /**
   * Short-lived command whose result the caller awaits (git, etc.).
   * Foreground processes are neither detached nor unref'd, so they keep the
   * event loop alive until they exit. Default: false (long-lived agent process).
   */
  foreground?: boolean;
  /**
   * POSIX: start the child in its own process group so kill/killWithGrace reach its
   * descendants (e.g. `sh -c "mvn test"` → java). Default: true for background
   * processes, false for foreground ones. Ignored on Windows (tree kill via taskkill).
   */
  processGroup?: boolean;
}

export interface IProcessManager {
  isAlive(pid: number): boolean;
  kill(pid: number, signal?: NodeJS.Signals): void;
  killWithGrace(pid: number, graceMs?: number): Promise<void>;
  spawn(command: string, args: string[], options?: ManagedSpawnOptions): SpawnResult;
}

export interface ProcessManagerOptions {
  platform?: NodeJS.Platform;
  resolve?: (command: string, args: string[]) => ResolvedCommand;
  /**
   * Windows process-tree termination (taskkill /T /F). Resolves to true on success.
   * Non-blocking: taskkill takes ~250 ms per call.
   */
  killTree?: (pid: number) => Promise<boolean>;
}

export class ProcessManager implements IProcessManager {
  private readonly platform: NodeJS.Platform;
  private readonly resolve: (command: string, args: string[]) => ResolvedCommand;
  private readonly killTree: (pid: number) => Promise<boolean>;

  constructor(options: ProcessManagerOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.resolve = options.resolve ?? ((command, args) => resolveCommand(command, args));
    this.killTree = options.killTree ?? taskkillTree;
  }

  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM means process exists but we lack permission to signal it
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return true;
      return false;
    }
  }

  kill(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.platform === 'win32') {
      // Windows has no process groups: terminate just this process (TerminateProcess,
      // synchronous). killWithGrace() — the path agents are stopped through — also
      // terminates descendants via taskkill /T.
      this.killDirect(pid, signal);
      return;
    }

    // Kill entire process group (-pid) to clean up child processes (vitest, playwright, etc.)
    try {
      process.kill(-pid, signal);
    } catch {
      // Group kill failed — fall back to direct PID kill
      try {
        process.kill(pid, signal);
      } catch {
        // Process already dead
      }
    }
  }

  async killWithGrace(pid: number, graceMs: number = 10_000): Promise<void> {
    if (!this.isAlive(pid)) return;

    if (this.platform === 'win32') {
      // No graceful signal on Windows — terminate the whole tree without blocking the event loop.
      if (!(await this.killTree(pid))) this.killDirect(pid, 'SIGTERM');
    } else {
      this.kill(pid, 'SIGTERM');
    }

    const deadline = Date.now() + graceMs;

    while (Date.now() < deadline) {
      if (!this.isAlive(pid)) return;
      await new Promise((r) => setTimeout(r, 200));
    }

    // Force kill if still alive
    this.kill(pid, 'SIGKILL');
  }

  private killDirect(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(pid, signal);
    } catch {
      // Process already dead
    }
  }

  spawn(command: string, args: string[], options?: ManagedSpawnOptions): SpawnResult {
    const { foreground = false, processGroup = !foreground, ...spawnOptions } = options ?? {};
    // A caller-requested shell interprets the command line itself — nothing to resolve.
    const resolved = spawnOptions.shell ? { command, args, shell: false } : this.resolve(command, args);

    const proc = spawn(resolved.command, resolved.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // POSIX: new process group so killWithGrace(-pid) kills all children.
      // Windows: detached would open a separate console window; killWithGrace uses taskkill /T instead.
      detached: processGroup && this.platform !== 'win32',
      windowsHide: true,
      ...spawnOptions,
      ...(resolved.shell ? { shell: true } : {}),
    });

    if (!proc.pid) {
      // The spawn error (ENOENT, bad cwd, …) is emitted asynchronously on `proc`. The caller
      // never receives `proc`, so without a listener it would become an uncaught exception.
      proc.once?.('error', () => {});
      throw new Error(`Failed to spawn process: ${command}`);
    }

    if (!foreground) {
      // Allow parent to exit without waiting for this child.
      // Pipes (stdout/stderr) still hold refs while being read — that's intentional.
      proc.unref();
    }

    return { process: proc, pid: proc.pid };
  }
}

/** Terminate a Windows process tree. taskkill exit 128 = process not found (already gone). */
function taskkillTree(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      child.once('error', () => resolve(false));
      child.once('exit', (code) => resolve(code === 0 || code === 128));
    } catch {
      resolve(false);
    }
  });
}

/**
 * Max stdout line length before truncation (16 KB).
 * First layer of a three-layer cap: readLines (16 KB) → serializeEventData (8 KB) → bus emit (4 KB).
 * Truncated lines produce invalid JSON → adapters' catch block handles gracefully.
 */
const MAX_LINE_LEN = 16384;

/** Cap a string to MAX_LINE_LEN. */
function capLine(s: string): string {
  return s.length > MAX_LINE_LEN ? s.slice(0, MAX_LINE_LEN) : s;
}

/**
 * Read lines from a readable stream as an async generator.
 *
 * Uses `for await` on the raw Readable (proper backpressure) instead of
 * readline.createInterface, which buffers all 'line' events in an unbounded
 * queue even when the consumer is paused — causing OOM under high throughput.
 *
 * Uses Buffer.concat + offset tracking to avoid O(n²) string copies.
 */
export async function* readLines(stream: Readable): AsyncGenerator<string> {
  const chunks: Buffer[] = [];
  let totalLen = 0;

  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string, 'utf-8');
    if (buf.length === 0) continue;
    chunks.push(buf);
    totalLen += buf.length;

    // Concat once per chunk arrival, then scan for newlines with offset tracking
    const buffer = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, totalLen);
    chunks.length = 0;
    totalLen = 0;

    let offset = 0;
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf(0x0a, offset)) !== -1) {
      if (newlineIdx > offset) {
        yield capLine(buffer.toString('utf-8', offset, newlineIdx));
      }
      offset = newlineIdx + 1;
    }

    // Keep unconsumed remainder for next chunk
    if (offset < buffer.length) {
      const remainder = buffer.subarray(offset);
      chunks.push(remainder);
      totalLen = remainder.length;
    }
  }

  // Flush remaining data (last line without trailing newline)
  if (totalLen > 0) {
    const final = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, totalLen);
    yield capLine(final.toString('utf-8'));
  }
}
