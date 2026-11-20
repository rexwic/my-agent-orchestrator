import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { buildLightContainer, type LightContainer } from '../../../src/container.js';
import { validateRole } from '../../../src/domain/role.js';
import { buildDashboardState } from '../../../src/cli/dashboard/state.js';
import { parseAction, describeApproval } from '../../../src/cli/dashboard/actions.js';
import { startDashboardServer } from '../../../src/cli/dashboard/server.js';
import { dashboardPage } from '../../../src/cli/dashboard/page.js';
import type { ApproveTaskOutcome } from '../../../src/application/orchestrator.js';

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

  it('lists tasks in review that wait for a human to approve them', async () => {
    const inReview = async (title: string, extra: Record<string, unknown> = {}) => {
      const t = await c.taskService.create({ title, role: 'backend' });
      await c.taskStore.save({ ...(await c.taskStore.get(t.id))!, status: 'review', ...extra });
      return t.id;
    };
    const now = new Date().toISOString();
    const waiting = await inReview('Manual policy');
    const reviewed = await inReview('Reviewer passed, manual policy', { review: { round: 1, status: 'passed', findings: [], updated_at: now } });
    await inReview('Approved, merging', { approved: true });
    await inReview('Reviewer at work', { review: { round: 1, status: 'pending', findings: [], updated_at: now } });
    await inReview('Planning', { plan_id: 'pln_1' });
    const asked = await inReview('Has a decision');
    await c.decisionService.request({ task_id: asked, source: 'escalation', question: 'Merge it?' });
    await c.taskService.create({ title: 'Still todo' });

    const s = await buildDashboardState(c, { orchestrator: notRunning });

    expect(s.to_approve.sort()).toEqual([waiting, reviewed].sort());
    expect(s.tasks.find((t) => t.title === 'Approved, merging')!.approved).toBe(true);
  });
});

describe('dashboard actions', () => {
  it('validates action bodies', () => {
    expect(parseAction({ type: 'decision_answer', id: 'dec_1', message: 'ok' })).toEqual({ type: 'decision_answer', id: 'dec_1', message: 'ok', action: 'continue', project: false });
    expect(() => parseAction({ type: 'plan_reject', id: 'pln_1' })).toThrow(/feedback \(message\) is required/);
    expect(() => parseAction({ type: 'decision_answer', id: 'd', action: 'merge' })).toThrow(/continue, approve or cancel/);
    expect(() => parseAction({ type: 'rm -rf' })).toThrow(/Unknown action/);
    expect(parseAction({ type: 'task_approve', id: 'tsk_1' })).toEqual({ type: 'task_approve', id: 'tsk_1' });
    expect(parseAction({ type: 'task_reject', id: 'tsk_1', message: ' add a test ' })).toEqual({ type: 'task_reject', id: 'tsk_1', message: 'add a test' });
    expect(() => parseAction({ type: 'task_reject', id: 'tsk_1' })).toThrow(/reason \(message\) is required/);
    expect(() => parseAction({ type: 'task_reject', id: 'tsk_1', message: '   ' })).toThrow(/reason \(message\) is required/);
    expect(() => parseAction({ type: 'task_approve' })).toThrow(/id is required/);
  });

  it('describes every approval outcome', () => {
    expect(describeApproval('t', { status: 'done' })).toMatch(/合併，完成/);
    expect(describeApproval('t', { status: 'queued' })).toMatch(/orchestrator 會同步/);
    expect(describeApproval('t', { status: 'sent_back', reason: 'conflict', files: ['a.java'] })).toMatch(/衝突（a\.java），已退回/);
    expect(describeApproval('t', { status: 'waiting_decision', decisionId: 'dec_9', detail: 'x' })).toMatch(/dec_9/);
    expect(describeApproval('t', { status: 'deferred', detail: 'main moved' })).toMatch(/main moved/);
  });
});

describe('dashboard server', () => {
  let server: http.Server;
  let port: number;
  const ops = { approveTask: vi.fn(async (_id: string): Promise<ApproveTaskOutcome> => ({ status: 'done' })), cancelRunning: vi.fn(async () => {}), discardCancelledWork: vi.fn(async () => {}) };

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

  it('approves a task in review through the orchestrator; a failed merge is an error with a hint', async () => {
    const t = await c.taskService.create({ title: 'Review me' });
    await c.taskStore.save({ ...(await c.taskStore.get(t.id))!, status: 'review', workspace: '/w' });
    const ok = await call('/api/action', { method: 'POST', body: { type: 'task_approve', id: t.id } });
    expect(ok.status).toBe(200);
    expect(ops.approveTask).toHaveBeenCalledWith(t.id);
    expect(JSON.parse(ok.body).message).toMatch(/已核准並合併/);

    ops.approveTask.mockResolvedValueOnce({ status: 'review', detail: 'git merge failed' });
    const failed = await call('/api/action', { method: 'POST', body: { type: 'task_approve', id: t.id } });
    expect(failed.status).toBe(400);
    expect(JSON.parse(failed.body)).toMatchObject({ error: expect.stringMatching(/git merge failed/), hint: expect.stringMatching(/留在審查中/) });

    const todo = await c.taskService.create({ title: 'Not in review' });
    const wrong = await call('/api/action', { method: 'POST', body: { type: 'task_approve', id: todo.id } });
    expect(wrong.status).toBe(400);
    expect(JSON.parse(wrong.body).error).toMatch(/not in review/);
  });

  it('sends a task in review back to its agent with the reason', async () => {
    const t = await c.taskService.create({ title: 'Redo' });
    await c.taskStore.save({ ...(await c.taskStore.get(t.id))!, status: 'review' });
    const r = await call('/api/action', { method: 'POST', body: { type: 'task_reject', id: t.id, message: 'handle an empty cart' } });
    expect(r.status).toBe(200);
    expect(await c.taskStore.get(t.id)).toMatchObject({ status: 'todo', feedback: 'handle an empty cart' });
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
