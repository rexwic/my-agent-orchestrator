/**
 * `orch dashboard` — a web page on this computer to watch the team and act:
 * answer decisions, approve / send back plans, read PRD changes, cancel tasks.
 *
 *   orch dashboard          the page only (an orchestrator runs elsewhere, or not)
 *   orch dashboard --run    the page + the orchestrator in this process
 *
 * Bound to 127.0.0.1; the link carries a one-time token.
 */

import { randomBytes } from 'node:crypto';
import type { Command } from 'commander';
import type { Container } from '../../container.js';
import { checkLock } from '../../infrastructure/storage/lock.js';
import { printSuccess, printWarning, dim } from '../output.js';

const DEFAULT_PORT = 4777;

export function registerDashboardCommand(program: Command, container: Container): void {
  program
    .command('dashboard')
    .description('Web dashboard on this computer: roles, tasks, decisions, plans, PRDs — answer and approve from the browser')
    .option('-p, --port <n>', `Port (default ${DEFAULT_PORT}; any free port if it is taken)`)
    .option('--run', 'Also run the orchestrator in this process (unless one already runs)')
    .option('--no-open', 'Do not open the browser')
    .action(async (opts: { port?: string; run?: boolean; open?: boolean }) => {
      const { startDashboardServer } = await import('../dashboard/server.js');
      const token = randomBytes(18).toString('base64url');
      let inProcess = false;

      const options = {
        container,
        token,
        orchestrator: async () => {
          if (inProcess) return { running: true, pid: process.pid, in_process: true };
          const lock = await checkLock(container.paths.lockPath).catch(() => ({ locked: false as const, pid: undefined }));
          return { running: lock.locked, ...(lock.pid ? { pid: lock.pid } : {}), in_process: false };
        },
        ops: async () => ({
          approveTask: (id: string) => container.orchestrator.approveTask(id),
          cancelRunning: (id: string) => container.orchestrator.cancelTask(id),
          discardCancelledWork: (id: string) => container.orchestrator.discardCancelledWork(id),
        }),
      };

      const wanted = opts.port !== undefined ? Number(opts.port) : DEFAULT_PORT;
      let started: Awaited<ReturnType<typeof startDashboardServer>>;
      try {
        started = await startDashboardServer(options, wanted);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
        started = await startDashboardServer(options, 0);
      }
      const url = `http://127.0.0.1:${started.port}/?token=${token}`;
      printSuccess(`Dashboard: ${url}`);
      console.log(dim('  Only this computer can open it; the link carries its access token. Ctrl+C to stop.'));
      if (opts.open !== false) openBrowser(url);

      if (opts.run) {
        const lock = await checkLock(container.paths.lockPath).catch(() => ({ locked: false, pid: undefined }));
        if (lock.locked) {
          printWarning(`An orchestrator already runs (pid ${lock.pid}); the dashboard only shows and acts.`);
        } else {
          const { StructuredLogger } = await import('../serve/structured-logger.js');
          const logger = new StructuredLogger({ format: 'text', verbose: false, streams: [process.stdout], idleLogInterval: 30 });
          logger.subscribe(container.eventBus);
          await container.orchestrator.startWatch();
          inProcess = true;
          await container.orchestrator.waitForStop();
          inProcess = false;
          started.server.close();
          await logger.flush();
          return;
        }
      }

      await new Promise<void>((resolve) => {
        const stop = () => resolve();
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
      started.server.close();
    });
}

function openBrowser(url: string): void {
  void import('node:child_process').then(({ spawn }) => {
    const [cmd, args] = process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    const child = spawn(cmd, args as string[], { detached: true, stdio: 'ignore', windowsVerbatimArguments: process.platform === 'win32' });
    child.on('error', () => {});
    child.unref();
  }).catch(() => {});
}
