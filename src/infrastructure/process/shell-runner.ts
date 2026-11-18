/**
 * Runs a shell command line (review criteria such as `./mvnw -q test`).
 *
 * - Uses the platform shell (cmd.exe on Windows, /bin/sh elsewhere) so config
 *   values like `mvnw.cmd -q test` or `npm test && npm run lint` work as typed.
 * - Keeps only the tail of the output: build tools print the failure summary last.
 * - On timeout, kills the whole process tree (sh → mvn → java), not just the shell.
 */

import type { IProcessManager } from './process-manager.js';

export interface ShellRunOptions {
  cwd: string;
  timeoutMs: number;
}

export interface ShellRunResult {
  /** Exit code, or null when the process could not start or was killed. */
  exitCode: number | null;
  /** Combined stdout + stderr (tail). */
  output: string;
  timedOut: boolean;
}

export interface IShellRunner {
  run(command: string, options: ShellRunOptions): Promise<ShellRunResult>;
}

/** Bytes of combined output retained (tail). */
const OUTPUT_TAIL_BYTES = 64 * 1024;

export class ShellRunner implements IShellRunner {
  constructor(private readonly processManager: IProcessManager) {}

  run(command: string, { cwd, timeoutMs }: ShellRunOptions): Promise<ShellRunResult> {
    return new Promise((resolve) => {
      let spawned: ReturnType<IProcessManager['spawn']>;
      try {
        spawned = this.processManager.spawn(command, [], {
          cwd,
          shell: true,
          foreground: true,   // keep the event loop alive while we await it
          processGroup: true, // POSIX: lets the timeout kill reach the shell's children
        });
      } catch (err) {
        resolve({ exitCode: null, output: err instanceof Error ? err.message : String(err), timedOut: false });
        return;
      }

      const { process: proc, pid } = spawned;
      let buf = Buffer.alloc(0);
      const append = (chunk: Buffer | string): void => {
        const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf-8');
        buf = Buffer.concat([buf, next]);
        if (buf.length > OUTPUT_TAIL_BYTES) buf = Buffer.from(buf.subarray(buf.length - OUTPUT_TAIL_BYTES));
      };
      proc.stdout?.on('data', append);
      proc.stderr?.on('data', append);

      let timedOut = false;
      let settled = false;
      const finish = (exitCode: number | null, extra?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const output = buf.toString('utf-8').trim();
        resolve({ exitCode, output: extra ? `${output}\n${extra}`.trim() : output, timedOut });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        void this.processManager.killWithGrace(pid, 2_000).catch(() => {});
      }, timeoutMs);

      proc.once('error', (err) => finish(null, err.message));
      proc.once('close', (code) => finish(timedOut ? null : code));
    });
  }
}
