/** Role duties (what ORCH routes to a role) and role templates (orch role init). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RoleService } from '../../../src/application/role-service.js';
import { PmService } from '../../../src/application/pm-service.js';
import { DecisionService } from '../../../src/application/decision-service.js';
import { TaskService } from '../../../src/application/task-service.js';
import { EventBus } from '../../../src/application/event-bus.js';
import { DEFAULT_CONFIG } from '../../../src/domain/config.js';
import { dutyRole, validateRole, type Role } from '../../../src/domain/role.js';
import { MemoryDecisionStore } from '../../../src/infrastructure/storage/decision-store.js';
import type { IRoleStore } from '../../../src/infrastructure/storage/interfaces.js';
import { loadRoleTemplate, listRoleTemplates } from '../../../src/infrastructure/storage/role-templates.js';
import { createMockAgentStore, createMockTaskStore, makeTask } from './helpers.js';

class MemoryRoleStore implements IRoleStore {
  roles = new Map<string, Role>();
  async save(role: Role) { this.roles.set(role.name, structuredClone(role)); }
  async get(name: string) { return structuredClone(this.roles.get(name)) ?? null; }
  async load() { return { roles: [...this.roles.values()].map((r) => structuredClone(r)), errors: [] }; }
  async list() { return (await this.load()).roles; }
  async delete(name: string) { this.roles.delete(name); }
}

describe('role duties', () => {
  it('validates duties and who a role works with', () => {
    const r = validateRole({ name: 'reviewer', adapter: 'codex', duties: ['review', 'review'], reviews: ['backend', 'frontend'] });
    expect(r).toMatchObject({ duties: ['review'], reviews: ['backend', 'frontend'] });
    expect(() => validateRole({ name: 'x', adapter: 'claude', duties: ['boss'] })).toThrow(/duties must be a list of plan, write_prd/);
    expect(() => validateRole({ name: 'x', adapter: 'claude', reviews: ['backend'] })).toThrow(/reviews needs the review duty/);
    expect(() => validateRole({ name: 'x', adapter: 'claude', duties: ['verify'], bug_owners: ['Back End'] })).toThrow(/bug_owners must be a list of role names/);
  });

  it('the role with a duty: the first declaring it, else the configured name', () => {
    const roles = [validateRole({ name: 'lead', adapter: 'claude', duties: ['plan'] }), validateRole({ name: 'architect', adapter: 'claude', duties: ['plan'] })];
    expect(dutyRole(roles, 'plan', 'planner')).toBe('architect');
    expect(dutyRole(roles, 'answer_questions', 'pm')).toBe('pm');
  });

  it('questions go to the role declaring answer_questions, whatever its name', async () => {
    const roleStore = new MemoryRoleStore();
    for (const r of [{ name: 'product', adapter: 'claude', duties: ['answer_questions'] }, { name: 'writer', adapter: 'claude' }]) await roleStore.save(validateRole(r));
    const taskStore = createMockTaskStore([makeTask({ id: 'tsk_w', status: 'in_progress', role: 'writer', description: 'Write the launch post' })]);
    const eventBus = new EventBus();
    const taskService = new TaskService(taskStore, eventBus, DEFAULT_CONFIG, undefined, createMockAgentStore(), roleStore);
    const decisions = new DecisionService(new MemoryDecisionStore(), taskStore, taskService, eventBus);
    new PmService({ decisionService: decisions, taskService, taskStore, roleStore, eventBus, config: DEFAULT_CONFIG });
    const d = await decisions.request({ task_id: 'tsk_w', source: 'agent', question: 'Formal or casual tone?', requested_by: 'writer-1' });
    expect(d.assignee).toBe('product');
    expect((await taskStore.get(d.triage_task_id!))!.role).toBe('product');
  });
});

describe('role templates', () => {
  let dir: string;
  let saved: string | undefined;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-tpl-'));
    saved = process.env['ORCHESTRY_TEMPLATES_DIR'];
    process.env['ORCHESTRY_TEMPLATES_DIR'] = path.join(dir, 'user');
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env['ORCHESTRY_TEMPLATES_DIR'];
    else process.env['ORCHESTRY_TEMPLATES_DIR'] = saved;
    await fs.rm(dir, { recursive: true, force: true });
  });

  const write = async (sub: string, files: Record<string, string>) => {
    await fs.mkdir(path.join(dir, sub), { recursive: true });
    for (const [f, text] of Object.entries(files)) await fs.writeFile(path.join(dir, sub, f), text);
  };

  it('loads a directory of role files, or a named template from ~/.orchestry/templates', async () => {
    await write('content-team', {
      'template.yml': 'description: Writer, editor, fact checker\n',
      'writer.yml': 'name: writer\nadapter: claude\n',
      'editor.yml': 'name: editor\nadapter: codex\nduties: [review]\nreviews: [writer]\n',
    });
    const fromDir = await loadRoleTemplate(path.join(dir, 'content-team'));
    expect(fromDir.roles.map((r) => r.file)).toEqual(['editor.yml', 'writer.yml']);
    expect(fromDir.description).toBe('Writer, editor, fact checker');

    await write('user/content', { 'writer.yml': 'name: writer\nadapter: claude\n' });
    expect((await loadRoleTemplate('content')).source).toBe(path.join(dir, 'user', 'content'));
    expect((await listRoleTemplates()).map((t) => t.name)).toContain('content');
    await expect(loadRoleTemplate('nope')).rejects.toThrow(/Unknown role template "nope"/);
  });

  it('applies all roles or none; keeps existing roles unless forced', async () => {
    const roleStore = new MemoryRoleStore();
    await roleStore.save(validateRole({ name: 'writer', adapter: 'claude', model: 'opus' }));
    const service = new RoleService(roleStore, createMockAgentStore(), new EventBus(), DEFAULT_CONFIG);
    const tpl = [
      { file: 'writer.yml', data: { name: 'writer', adapter: 'claude', model: 'sonnet' } },
      { file: 'editor.yml', data: { name: 'editor', adapter: 'codex', duties: ['review'], reviews: ['writer'] } },
    ];

    const first = await service.applyTemplate(tpl);
    expect(first).toMatchObject({ created: ['editor'], skipped: ['writer'], overwritten: [] });
    expect(roleStore.roles.get('writer')!.model).toBe('opus');
    expect(first.sync.created).toContain('editor-1');

    const forced = await service.applyTemplate(tpl, { force: true });
    expect(forced.overwritten.sort()).toEqual(['editor', 'writer']);
    expect(roleStore.roles.get('writer')!.model).toBe('sonnet');

    const bad = [
      { file: 'checker.yml', data: { name: 'checker', adapter: 'claude', duties: ['verify'], bug_owners: ['ghost'] } },
      { file: 'broken.yml', data: { name: 'Broken', adapter: 'claude' } },
    ];
    await expect(service.applyTemplate(bad)).rejects.toThrow(/2 problem\(s\)[\s\S]*broken\.yml: Invalid role[\s\S]*checker: bug_owners names "ghost"/);
    expect(roleStore.roles.has('checker')).toBe(false);
    vi.restoreAllMocks();
  });
});
