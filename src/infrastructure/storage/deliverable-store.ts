/**
 * File-based delivery reports: .orchestry/deliverables/<task>.md — the
 * agent's Markdown report under a YAML front matter (status, who, when).
 */

import fs from 'node:fs/promises';
import yaml from 'js-yaml';
import type { Deliverable, DeliveryStatus } from '../../domain/deliverable.js';
import type { IDeliverableStore } from './interfaces.js';
import type { Paths } from './paths.js';
import { atomicWrite, ensureDir } from './fs-utils.js';

export class DeliverableStore implements IDeliverableStore {
  constructor(private readonly paths: Paths) {}

  async save(d: Deliverable): Promise<void> {
    await ensureDir(this.paths.deliverablesDir);
    const meta = yaml.dump({ task_id: d.task_id, status: d.status, submitted_by: d.submitted_by, submitted_at: d.submitted_at });
    await atomicWrite(this.paths.deliverablePath(d.task_id), `---\n${meta}---\n\n${d.report.replace(/\r\n/g, '\n').trim()}\n`);
  }

  async get(taskId: string): Promise<Deliverable | null> {
    let text: string;
    try {
      text = await fs.readFile(this.paths.deliverablePath(taskId), 'utf8');
    } catch {
      return null;
    }
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
    if (!m) return null;
    const meta = yaml.load(m[1]!) as Record<string, unknown> | null;
    if (!meta || typeof meta['status'] !== 'string') return null;
    return {
      task_id: String(meta['task_id'] ?? taskId),
      status: meta['status'] as DeliveryStatus,
      submitted_by: String(meta['submitted_by'] ?? ''),
      submitted_at: meta['submitted_at'] instanceof Date ? meta['submitted_at'].toISOString() : String(meta['submitted_at'] ?? ''),
      report: m[2]!.replace(/^\n+/, '').replace(/\n+$/, ''),
    };
  }
}

/** In-memory store (tests, programmatic use). */
export class MemoryDeliverableStore implements IDeliverableStore {
  private readonly items = new Map<string, Deliverable>();

  async save(d: Deliverable): Promise<void> {
    this.items.set(d.task_id, structuredClone(d));
  }

  async get(taskId: string): Promise<Deliverable | null> {
    const d = this.items.get(taskId);
    return d ? structuredClone(d) : null;
  }
}
