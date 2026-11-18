import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RoleService } from '../../../src/application/role-service.js';
import { EventBus } from '../../../src/application/event-bus.js';
import { DEFAULT_CONFIG } from '../../../src/domain/config.js';
import { validateRole, type Role } from '../../../src/domain/role.js';
import type { IRoleStore, RoleLoadResult } from '../../../src/infrastructure/storage/interfaces.js';
import { RoleStore } from '../../../src/infrastructure/storage/role-store.js';
import { Paths } from '../../../src/infrastructure/storage/paths.js';
import { createMockAgentStore, makeAgent } from './helpers.js';

class MemoryRoleStore implements IRoleStore {
  roles = new Map<string, Role>();
  invalid: RoleLoadResult['errors'] = [];
  async save(role: Role) { this.roles.set(role.name, structuredClone(role)); }
  async get(name: string) { return structuredClone(this.roles.get(name)) ?? null; }
  async load() { return { roles: [...this.roles.values()].map((r) => structuredClone(r)), errors: this.invalid }; }
  async list() { return (await this.load()).roles; }
  async delete(name: string) { this.roles.delete(name); }
}

function setup(existing = [] as ReturnType<typeof makeAgent>[]) {
  const roleStore = new MemoryRoleStore();
  const agentStore = createMockAgentStore(existing);
  const eventBus = new EventBus();
  const events: any[] = [];
  eventBus.onAny((e: any) => events.push(e));
  const service = new RoleService(roleStore, agentStore, eventBus, DEFAULT_CONFIG);
  const names = async () => (await agentStore.list()).map((a) => a.name).sort();
  return { service, roleStore, agentStore, events, names };
}

describe('RoleService', () => {
  it('creates a role with its replicas, configured from the role', async () => {
    const { service, agentStore, events } = setup();

    const { sync } = await service.create({ name: 'backend', adapter: 'claude', model: 'sonnet', effort: 'high', replicas: 2, description: 'Spring backend' });

    expect(sync.created).toEqual(['backend-1', 'backend-2']);
    const agents = await agentStore.list();
    expect(agents.every((a) => a.role_id === 'backend' && a.adapter === 'claude' && a.role === 'Spring backend')).toBe(true);
    expect(agents[0]!.config).toMatchObject({ model: 'sonnet', effort: 'high' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'role:synced', created: ['backend-1', 'backend-2'] }));
  });

  it('rejects duplicate and invalid roles', async () => {
    const { service } = setup();
    await service.create({ name: 'qa', adapter: 'codex' });
    await expect(service.create({ name: 'qa', adapter: 'codex' })).rejects.toThrow(/already exists/);
    await expect(service.create({ name: 'Bad Name', adapter: 'codex' })).rejects.toThrow(/name/);
  });

  it('overwrites instance config when the role file changes (no per-instance overrides)', async () => {
    const { service, roleStore, agentStore } = setup();
    await service.create({ name: 'backend', adapter: 'claude', model: 'sonnet', replicas: 2 });
    const tampered = (await agentStore.getByName('backend-1'))!;
    tampered.config.model = 'opus';
    await agentStore.save(tampered);
    await roleStore.save(validateRole({ name: 'backend', adapter: 'claude', model: 'haiku', effort: 'low', replicas: 2 }));

    const sync = await service.sync();

    expect(sync.updated.sort()).toEqual(['backend-1', 'backend-2']);
    for (const a of await agentStore.list()) expect(a.config).toMatchObject({ model: 'haiku', effort: 'low' });
    expect((await service.sync()).updated).toEqual([]); // idempotent
  });

  it('scales down from the highest instance, keeping busy agents until they are idle', async () => {
    const { service, agentStore, names } = setup();
    await service.create({ name: 'backend', adapter: 'claude', replicas: 3 });
    const busy = (await agentStore.getByName('backend-3'))!;
    busy.status = 'running';
    busy.current_task = 'tsk_1';
    await agentStore.save(busy);

    const { sync } = await service.scale('backend', 1);

    expect(sync.removed).toEqual(['backend-2']);
    expect(sync.pendingRemoval).toEqual(['backend-3']);
    expect(await names()).toEqual(['backend-1', 'backend-3']);

    busy.status = 'idle';
    busy.current_task = undefined;
    await agentStore.save(busy);
    expect((await service.sync()).removed).toEqual(['backend-3']);
    expect(await names()).toEqual(['backend-1']);
  });

  it('fills the lowest free names when scaling up and skips names taken by other agents', async () => {
    const { service, names } = setup([makeAgent({ id: 'agt_manual', name: 'backend-1', adapter: 'codex' })]);

    await service.create({ name: 'backend', adapter: 'claude', replicas: 2 });

    expect(await names()).toEqual(['backend-1', 'backend-2', 'backend-3']);
  });

  it('removes idle instances of a deleted role, but never touches agents of an invalid role file', async () => {
    const { service, roleStore, names } = setup();
    await service.create({ name: 'backend', adapter: 'claude', replicas: 1 });
    await service.create({ name: 'qa', adapter: 'codex', replicas: 1 });

    // qa.yml now fails validation (e.g. a typo): its agent must survive
    roleStore.roles.delete('qa');
    roleStore.invalid = [{ file: 'roles/qa.yml', message: 'effort must be one of low, medium, high' }];
    const sync = await service.sync();
    expect(sync.removed).toEqual([]);
    expect(sync.errors).toHaveLength(1);
    expect(await names()).toEqual(['backend-1', 'qa-1']);

    // backend.yml deleted: its agent goes
    await service.remove('backend');
    expect(await names()).toEqual(['qa-1']);
  });

  it('leaves agents without a role alone', async () => {
    const { service, names } = setup([makeAgent({ id: 'agt_x', name: 'reviewer', adapter: 'claude' })]);
    await service.sync();
    expect(await names()).toEqual(['reviewer']);
  });
});

describe('RoleStore (files)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-roles-'));
    await fs.mkdir(path.join(dir, '.orchestry'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('round-trips roles and reports invalid files instead of loading them', async () => {
    const paths = new Paths(dir);
    const store = new RoleStore(paths);
    await store.save(validateRole({ name: 'backend', adapter: 'claude', model: 'sonnet', replicas: 2 }));
    await fs.writeFile(path.join(paths.rolesDir, 'qa.yml'), 'name: qa\nadapter: codex\neffort: extreme\n');
    await fs.writeFile(path.join(paths.rolesDir, 'mismatch.yml'), 'name: other\nadapter: codex\n');

    const { roles, errors } = await store.load();

    expect(roles.map((r) => r.name)).toEqual(['backend']);
    expect(roles[0]).toMatchObject({ model: 'sonnet', replicas: 2 });
    expect(errors.map((e) => e.file).sort()).toEqual(['roles/mismatch.yml', 'roles/qa.yml']);
    await store.delete('backend');
    expect(await store.get('backend')).toBeNull();
  });
});
