/**
 * File-based PRD store: .orchestry/prds/<name>/v<N>.md — the PRD (Markdown)
 * under a YAML front matter (who, when, note, seen).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import type { PrdVersion } from '../../domain/prd.js';
import type { IPrdStore } from './interfaces.js';
import type { Paths } from './paths.js';
import { atomicWrite, ensureDir } from './fs-utils.js';

const VERSION_FILE = /^v(\d+)\.md$/;

export class PrdStore implements IPrdStore {
  constructor(private readonly paths: Paths) {}

  async save(v: PrdVersion): Promise<void> {
    const dir = this.paths.prdDir(v.name);
    await ensureDir(dir);
    const { content, ...meta } = v;
    await atomicWrite(path.join(dir, `v${v.version}.md`), `---\n${yaml.dump(meta)}---\n\n${content}\n`);
  }

  async get(name: string, version: number): Promise<PrdVersion | null> {
    let text: string;
    try {
      text = await fs.readFile(path.join(this.paths.prdDir(name), `v${version}.md`), 'utf8');
    } catch {
      return null;
    }
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
    if (!m) return null;
    const meta = (yaml.load(m[1]!) ?? {}) as Record<string, unknown>;
    const at = meta['created_at'];
    return {
      name,
      version,
      content: m[2]!.replace(/\r\n/g, '\n').trim(),
      created_by: String(meta['created_by'] ?? ''),
      created_at: at instanceof Date ? at.toISOString() : String(at ?? ''),
      ...(typeof meta['note'] === 'string' ? { note: meta['note'] } : {}),
      ...(typeof meta['task_id'] === 'string' ? { task_id: meta['task_id'] } : {}),
      seen: meta['seen'] !== false,
    };
  }

  async versions(name: string): Promise<PrdVersion[]> {
    let files: string[];
    try {
      files = await fs.readdir(this.paths.prdDir(name));
    } catch {
      return [];
    }
    const numbers = files.map((f) => VERSION_FILE.exec(f)?.[1]).filter((n): n is string => Boolean(n)).map(Number);
    const all = await Promise.all(numbers.map((n) => this.get(name, n)));
    return all.filter((v): v is PrdVersion => v !== null).sort((a, b) => a.version - b.version);
  }

  async names(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.paths.prdsDir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch {
      return [];
    }
  }
}

/** In-memory store (tests, programmatic use). */
export class MemoryPrdStore implements IPrdStore {
  private readonly items = new Map<string, PrdVersion>();

  async save(v: PrdVersion): Promise<void> {
    this.items.set(`${v.name}@${v.version}`, structuredClone(v));
  }

  async get(name: string, version: number): Promise<PrdVersion | null> {
    const v = this.items.get(`${name}@${version}`);
    return v ? structuredClone(v) : null;
  }

  async versions(name: string): Promise<PrdVersion[]> {
    return [...this.items.values()].filter((v) => v.name === name).map((v) => structuredClone(v)).sort((a, b) => a.version - b.version);
  }

  async names(): Promise<string[]> {
    return [...new Set([...this.items.values()].map((v) => v.name))].sort();
  }
}
