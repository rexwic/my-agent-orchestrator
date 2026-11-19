/**
 * File-based decision store: one YAML file per decision in
 * .orchestry/decisions/<id>.yml — the decision log.
 */

import type { Decision } from '../../domain/decision.js';
import type { IDecisionStore } from './interfaces.js';
import type { Paths } from './paths.js';
import { ensureDir, listFiles, readYaml, writeYaml } from './fs-utils.js';

export class DecisionStore implements IDecisionStore {
  constructor(private readonly paths: Paths) {}

  async save(decision: Decision): Promise<void> {
    await ensureDir(this.paths.decisionsDir);
    await writeYaml(this.paths.decisionPath(decision.id), decision);
  }

  async get(id: string): Promise<Decision | null> {
    return readYaml<Decision>(this.paths.decisionPath(id));
  }

  async list(): Promise<Decision[]> {
    await ensureDir(this.paths.decisionsDir);
    const files = await listFiles(this.paths.decisionsDir, '.yml');
    const decisions = await Promise.all(files.map((f) => this.get(f.replace(/\.yml$/, '')).catch(() => null)));
    return decisions
      .filter((d): d is Decision => d !== null && typeof d.id === 'string')
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
}

/** In-memory store (tests, programmatic use). */
export class MemoryDecisionStore implements IDecisionStore {
  private readonly items = new Map<string, Decision>();

  async save(decision: Decision): Promise<void> {
    this.items.set(decision.id, structuredClone(decision));
  }

  async get(id: string): Promise<Decision | null> {
    const d = this.items.get(id);
    return d ? structuredClone(d) : null;
  }

  async list(): Promise<Decision[]> {
    return [...this.items.values()].map((d) => structuredClone(d)).sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
}
