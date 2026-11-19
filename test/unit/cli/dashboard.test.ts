import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { buildLightContainer, type LightContainer } from '../../../src/container.js';
import { validateRole } from '../../../src/domain/role.js';
import { buildDashboardState } from '../../../src/cli/dashboard/state.js';
import { parseAction } from '../../../src/cli/dashboard/actions.js';
import { startDashboardServer } from '../../../src/cli/dashboard/server.js';
import { dashboardPage } from '../../../src/cli/dashboard/page.js';

let root: string;
let c: LightContainer;
const notRunning = async () => ({ running: false, in_process: false });

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-dash-'));
  await fs.mkdir(path.join(root, '.orchestry'), { recursive: true });
  c = await buildLightContainer({ projectRoot: root, json: false, quiet: true, noColor: true, ascii: true });
  for (const name of ['backend', 'pm']) await c.roleStore.save(validateRole({ name, adapter: 'claude', model: 'opus', description: name }));
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

describe('dashboard state', () => {
  it('roles, tasks with what they wait for and their delivery, decisions split by who holds them', async () => {
    const contract = await c.taskService.create({ title: 'API contract', role: 'backend' });
    const be = await c.taskService.create({ title: 'API', role: 'backend', depends_on: [contract.id], uses: ['docs/api.yaml'] });
    await c.taskStore.save({ ...(await c.taskStore.get(contract.id))!, status: 'in_progress' });
    await c.deliverableService.submit({ taskId: contract.id, report: '## Summary\nx\n## Verification\ny\n## Open issues\nnone', status: 'partial', submittedBy: 'backend-1' });
    const asked = await c.decisionService.request({ task_id: be.id, source: 'agent', question: 'Percent?', requested_by: 'backend-1' });
    const gate = await c.decisionService.request({ task_id: contract.id, source: 'gate', question: 'Start?' });

    const s = await buildDashboardState(c, { orchestrator: notRunning });

    expect(s.roles.map((r) => r.name).sort()).toEqual(['backend', 'pm']);
    expect(s.roles.find((r) => r.name === 'backend')).toMatchObject({ adapter: 'claude', model: 'opus', replicas: 1, agents: [] });
    const row = s.tasks.find((t) => t.id === be.id)!;
    expect(row).toMatchObject({ waiting_for: ['API contract'], uses: ['docs/api.yaml'], kind: 'work' });
    expect(s.tasks.find((t) => t.id === contract.id)!.delivery).toMatchObject({ status: 'partial', by: 'backend-1' });
    // The PM role exists: the agent's question is held by it, the gate is the human's.
    expect(s.decisions.with_roles.map((d) => d.id)).toEqual([asked.id]);
    expect(s.decisions.mine.map((d) => d.id)).toEqual([gate.id]);
    expect(s.decisions.mine[0]!.task_title).toBe('API contract');
    expect(s.tasks.some((t) => t.kind === 'pm-answer')).toBe(true);
    expect(s.orchestrator).toEqual({ running: false, in_process: false, running_tasks: 1 });
  });
});

describe('dashboard actions', () => {
  it('validates action bodies', () => {
    expect(parseAction({ type: 'decision_answer', id: 'dec_1', message: 'ok' })).toEqual({ type: 'decision_answer', id: 'dec_1', message: 'ok', action: 'continue', project: false });
    expect(() => parseAction({ type: 'plan_reject', id: 'pln_1' })).toThrow(/feedback \(message\) is required/);
    expect(() => parseAction({ type: 'decision_answer', id: 'd', action: 'merge' })).toThrow(/continue, approve or cancel/);
    expect(() => parseAction({ type: 'rm -rf' })).toThrow(/Unknown action/);
  });
});

describe('dashboard server', () => {
  let server: http.Server;
  let port: number;
  const ops = { approveTask: vi.fn(async () => ({ status: 'done' })), cancelRunning: vi.fn(async () => {}), discardCancelledWork: vi.fn(async () => {}) };

  beforeEach(async () => {
    const started = await startDashboardServer({ container: c, token: 'tok', orchestrator: notRunning, ops: async () => ops }, 0);
    server = started.server;
    port = started.port;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  function call(pathname: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
      const req = http.request({
        host: '127.0.0.1', port, path: pathname, method: opts.method ?? 'GET',
        headers: { 'X-Orch-Token': 'tok', ...(data ? { 'Content-Type': 'application/json' } : {}), ...opts.headers },
      }, (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  it('serves the page only with the token', async () => {
    expect((await call('/')).status).toBe(403);
    const ok = await call('/?token=tok');
    expect(ok.status).toBe(200);
    expect(ok.body).toContain('<title>ORCH Dashboard</title>');
  });

  it('refuses API calls without the token, from another origin or another host name', async () => {
    expect((await call('/api/state', { headers: { 'X-Orch-Token': 'nope' } })).status).toBe(403);
    expect((await call('/api/state', { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await call('/api/state', { headers: { Host: 'evil.example' } })).status).toBe(403);
    const ok = await call('/api/state', { headers: { Origin: `http://localhost:${port}` } });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toHaveProperty('tasks');
  });

  it('answers a decision; errors come back with their hint', async () => {
    const t = await c.taskService.create({ title: 'Gate', needs_decision: true });
    const d = await c.decisionService.request({ task_id: t.id, source: 'gate', question: 'Start?' });
    const r = await call('/api/action', { method: 'POST', body: { type: 'decision_answer', id: d.id, message: 'go', action: 'approve' } });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).message).toMatch(/→ todo/);
    expect((await c.taskStore.get(t.id))!.status).toBe('todo');

    const again = await call('/api/action', { method: 'POST', body: { type: 'decision_answer', id: d.id, message: 'go' } });
    expect(again.status).toBe(400);
    expect(JSON.parse(again.body).error).toMatch(/already answered/);
  });

  it('cancelling a task with a worktree also removes it', async () => {
    const t = await c.taskService.create({ title: 'X' });
    await c.taskStore.save({ ...(await c.taskStore.get(t.id))!, status: 'review', workspace: '/w' });
    const r = await call('/api/action', { method: 'POST', body: { type: 'task_cancel', id: t.id } });
    expect(r.status).toBe(200);
    expect(ops.discardCancelledWork).toHaveBeenCalledWith(t.id);
    expect((await c.taskStore.get(t.id))!.status).toBe('cancelled');
  });

  it('task detail and PRD diff', async () => {
    const t = await c.taskService.create({ title: 'Detail' });
    expect(JSON.parse((await call(`/api/task?id=${t.id}`)).body).task.title).toBe('Detail');
    await c.prdService.add({ name: 'discount', content: 'a' });
    await c.prdService.add({ name: 'discount', content: 'a\nb', createdBy: 'pm-1' });
    const prd = JSON.parse((await call('/api/prd?name=discount&version=2&from=1')).body);
    expect(prd.diff).toContain('+b');
    expect(prd.version.version).toBe(2);
  });
});

describe('dashboard page', () => {
  it('embeds the token and its script is valid JavaScript', () => {
    const html = dashboardPage('a"b');
    expect(html).toContain('var TOKEN = "a\\"b";');
    const script = /<script>([\s\S]*)<\/script>/.exec(html)![1]!;
    expect(() => new Function(script)).not.toThrow();
  });
});
