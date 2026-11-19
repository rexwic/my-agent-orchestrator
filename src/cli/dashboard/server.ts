/**
 * Dashboard HTTP server (Node http, no dependencies), bound to 127.0.0.1.
 *
 *   GET  /?token=…           the page
 *   GET  /api/state          everything the page shows
 *   GET  /api/task?id=…      a task with its delivery report and decisions
 *   GET  /api/prd?name=…&version=…&from=…   a PRD version, or a diff
 *   POST /api/action         decisions, plans, PRD seen, task cancel
 *
 * Every /api call carries the token (X-Orch-Token) the page got in its URL, and
 * the Host / Origin must be this server: other web pages open in the browser
 * cannot read the state or act (CSRF, DNS rebinding).
 */

import http from 'node:http';
import type { LightContainer } from '../../container.js';
import { OrchestryError } from '../../domain/errors.js';
import { parseAction, prdDetail, runAction, taskDetail, type OrchestratorOps } from './actions.js';
import { dashboardPage } from './page.js';
import { buildDashboardState, type StateOptions } from './state.js';

export interface DashboardServerOptions {
  container: LightContainer;
  token: string;
  orchestrator: StateOptions['orchestrator'];
  ops: () => Promise<OrchestratorOps>;
}

const MAX_BODY = 256 * 1024;

function send(res: http.ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8'): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('Body must be JSON')); }
    });
    req.on('error', reject);
  });
}

/** Host header is this server (127.0.0.1 / localhost on our port). */
function sameHost(value: string | undefined, port: number): boolean {
  if (!value) return false;
  const host = value.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export function createDashboardHandler(opts: DashboardServerOptions, port: () => number): http.RequestListener {
  const { container: c, token } = opts;
  return (req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (!sameHost(req.headers.host, port())) return send(res, 403, { error: 'Wrong host' });

      if (req.method === 'GET' && url.pathname === '/') {
        if (url.searchParams.get('token') !== token) {
          return send(res, 403, 'Open the link printed by orch dashboard (it carries the access token).', 'text/plain; charset=utf-8');
        }
        return send(res, 200, dashboardPage(token), 'text/html; charset=utf-8');
      }

      if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
      if (req.headers['x-orch-token'] !== token) return send(res, 403, { error: 'Missing or wrong token' });
      const origin = req.headers.origin;
      if (origin !== undefined && !sameHost(origin, port())) return send(res, 403, { error: 'Cross-origin request' });

      try {
        if (req.method === 'GET' && url.pathname === '/api/state') {
          return send(res, 200, await buildDashboardState(c, { orchestrator: opts.orchestrator }));
        }
        if (req.method === 'GET' && url.pathname === '/api/task') {
          return send(res, 200, await taskDetail(c, url.searchParams.get('id') ?? ''));
        }
        if (req.method === 'GET' && url.pathname === '/api/prd') {
          const num = (k: string) => (url.searchParams.get(k) ? Number(url.searchParams.get(k)) : undefined);
          return send(res, 200, await prdDetail(c, url.searchParams.get('name') ?? '', {
            ...(num('version') !== undefined ? { version: num('version') } : {}),
            ...(num('from') !== undefined ? { diffFrom: num('from') } : {}),
          }));
        }
        if (req.method === 'POST' && url.pathname === '/api/action') {
          const action = parseAction(await readBody(req));
          return send(res, 200, { ok: true, message: await runAction(c, action, opts.ops) });
        }
        return send(res, 404, { error: 'Not found' });
      } catch (err) {
        const known = err instanceof OrchestryError;
        return send(res, known ? 400 : 500, {
          error: err instanceof Error ? err.message : String(err),
          ...(known && err.hint ? { hint: err.hint } : {}),
        });
      }
    })();
  };
}

/** Listen on 127.0.0.1:port (0 = any free port); resolves with the port. */
export function startDashboardServer(opts: DashboardServerOptions, port: number): Promise<{ server: http.Server; port: number }> {
  let actual = port;
  const server = http.createServer(createDashboardHandler(opts, () => actual));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      actual = typeof addr === 'object' && addr ? addr.port : port;
      server.off('error', reject);
      resolve({ server, port: actual });
    });
  });
}
