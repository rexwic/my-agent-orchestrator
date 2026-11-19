/**
 * Role templates: a set of role definitions applied with `orch role init`.
 *
 * A template is found, in this order, as:
 *   1. a directory path (its *.yml files, one role each),
 *   2. ~/.orchestry/templates/<name>/ (shared by all your projects),
 *   3. a built-in template (src/domain/role-templates.ts).
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { BUILTIN_ROLE_TEMPLATES } from '../../domain/role-templates.js';
import { InvalidArgumentsError } from '../../domain/errors.js';

export interface LoadedRoleTemplate {
  name: string;
  /** Where it came from: a directory or "built-in". */
  source: string;
  description?: string;
  /** Raw role definitions (validated when applied), with the file they came from. */
  roles: Array<{ file: string; data: unknown }>;
}

/** ~/.orchestry/templates (override with ORCHESTRY_TEMPLATES_DIR). */
export function userTemplatesDir(): string {
  const override = process.env['ORCHESTRY_TEMPLATES_DIR']?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), '.orchestry', 'templates');
}

async function isDir(p: string): Promise<boolean> {
  return fs.stat(p).then((s) => s.isDirectory(), () => false);
}

async function readDir(dir: string): Promise<LoadedRoleTemplate['roles']> {
  const files = (await fs.readdir(dir)).filter((f) => /\.ya?ml$/i.test(f) && !/^template\.ya?ml$/i.test(f)).sort();
  if (!files.length) throw new InvalidArgumentsError(`No role files (*.yml) in ${dir}`);
  return Promise.all(files.map(async (f) => {
    const text = await fs.readFile(path.join(dir, f), 'utf8');
    try {
      return { file: f, data: yaml.load(text) };
    } catch (err) {
      throw new InvalidArgumentsError(`${path.join(dir, f)} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
    }
  }));
}

async function description(dir: string): Promise<string | undefined> {
  const meta = await fs.readFile(path.join(dir, 'template.yml'), 'utf8').then((t) => yaml.load(t) as Record<string, unknown> | null, () => null);
  return typeof meta?.['description'] === 'string' ? meta['description'] : undefined;
}

export async function loadRoleTemplate(nameOrPath: string, cwd = process.cwd()): Promise<LoadedRoleTemplate> {
  const asPath = path.resolve(cwd, nameOrPath);
  if (await isDir(asPath)) {
    return { name: path.basename(asPath), source: asPath, description: await description(asPath), roles: await readDir(asPath) };
  }
  if (/^[a-z0-9][a-z0-9_-]*$/i.test(nameOrPath)) {
    const user = path.join(userTemplatesDir(), nameOrPath);
    if (await isDir(user)) {
      return { name: nameOrPath, source: user, description: await description(user), roles: await readDir(user) };
    }
    const builtin = BUILTIN_ROLE_TEMPLATES[nameOrPath];
    if (builtin) {
      return { name: nameOrPath, source: 'built-in', description: builtin.description, roles: builtin.roles.map((r) => ({ file: `${String(r['name'])}.yml`, data: r })) };
    }
  }
  const known = (await listRoleTemplates()).map((t) => t.name);
  throw new InvalidArgumentsError(`Unknown role template "${nameOrPath}"`, `Templates: ${known.join(', ') || 'none'} — or pass a directory of role .yml files`);
}

export async function listRoleTemplates(): Promise<Array<{ name: string; source: string; description?: string; roles: number }>> {
  const out: Array<{ name: string; source: string; description?: string; roles: number }> = Object.entries(BUILTIN_ROLE_TEMPLATES).map(([name, t]) => ({ name, source: 'built-in', description: t.description, roles: t.roles.length }));
  const dir = userTemplatesDir();
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const roles = await readDir(path.join(dir, e.name)).catch(() => null);
    if (roles) out.push({ name: e.name, source: path.join(dir, e.name), description: await description(path.join(dir, e.name)), roles: roles.length });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
