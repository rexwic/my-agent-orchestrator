/**
 * File-based role store: one YAML file per role in .orchestry/roles/<name>.yml.
 * Roles are validated on read; invalid files are reported, not loaded.
 */

import fs from 'node:fs/promises';
import { validateRole, type Role } from '../../domain/role.js';
import type { IRoleStore, RoleLoadResult } from './interfaces.js';
import type { Paths } from './paths.js';
import { ensureDir, listFiles, readYaml, writeYaml } from './fs-utils.js';

export class RoleStore implements IRoleStore {
  constructor(private readonly paths: Paths) {}

  async save(role: Role): Promise<void> {
    await ensureDir(this.paths.rolesDir);
    await writeYaml(this.paths.rolePath(role.name), role);
  }

  async get(name: string): Promise<Role | null> {
    const raw = await readYaml<unknown>(this.paths.rolePath(name));
    return raw === null ? null : validateRole(raw, name);
  }

  async load(): Promise<RoleLoadResult> {
    await ensureDir(this.paths.rolesDir);
    const files = await listFiles(this.paths.rolesDir, '.yml');
    const result: RoleLoadResult = { roles: [], errors: [] };
    await Promise.all(files.map(async (file) => {
      const name = file.replace(/\.yml$/, '');
      try {
        const role = await this.get(name);
        if (role) result.roles.push(role);
      } catch (err) {
        result.errors.push({ file: `roles/${file}`, message: err instanceof Error ? err.message : String(err) });
      }
    }));
    result.roles.sort((a, b) => a.name.localeCompare(b.name));
    return result;
  }

  async list(): Promise<Role[]> {
    return (await this.load()).roles;
  }

  async delete(name: string): Promise<void> {
    try {
      await fs.unlink(this.paths.rolePath(name));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}
