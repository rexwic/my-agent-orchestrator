/**
 * File-based plan store: one YAML file per plan in .orchestry/plans/<id>.yml.
 */

import type { Plan } from '../../domain/plan.js';
import type { IPlanStore } from './interfaces.js';
import type { Paths } from './paths.js';
import { ensureDir, listFiles, readYaml, writeYaml } from './fs-utils.js';

export class PlanStore implements IPlanStore {
  constructor(private readonly paths: Paths) {}

  async save(plan: Plan): Promise<void> {
    await ensureDir(this.paths.plansDir);
    await writeYaml(this.paths.planPath(plan.id), plan);
  }

  async get(id: string): Promise<Plan | null> {
    return readYaml<Plan>(this.paths.planPath(id));
  }

  async list(): Promise<Plan[]> {
    await ensureDir(this.paths.plansDir);
    const files = await listFiles(this.paths.plansDir, '.yml');
    const plans = await Promise.all(files.map((f) => this.get(f.replace(/\.yml$/, '')).catch(() => null)));
    return plans
      .filter((p): p is Plan => p !== null && typeof p.id === 'string')
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
}

/** In-memory store (tests, programmatic use). */
export class MemoryPlanStore implements IPlanStore {
  private readonly items = new Map<string, Plan>();

  async save(plan: Plan): Promise<void> {
    this.items.set(plan.id, structuredClone(plan));
  }

  async get(id: string): Promise<Plan | null> {
    const p = this.items.get(id);
    return p ? structuredClone(p) : null;
  }

  async list(): Promise<Plan[]> {
    return [...this.items.values()].map((p) => structuredClone(p)).sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
}
