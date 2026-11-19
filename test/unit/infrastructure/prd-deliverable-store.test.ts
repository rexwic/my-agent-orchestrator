/** File stores for PRD versions and delivery reports: Markdown under a YAML front matter. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Paths } from '../../../src/infrastructure/storage/paths.js';
import { PrdStore } from '../../../src/infrastructure/storage/prd-store.js';
import { DeliverableStore } from '../../../src/infrastructure/storage/deliverable-store.js';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-stores-')); });
afterEach(() => fs.rm(root, { recursive: true, force: true }));

describe('PrdStore', () => {
  it('round-trips versions as .orchestry/prds/<name>/v<N>.md', async () => {
    const store = new PrdStore(new Paths(root));
    await store.save({ name: 'discount', version: 1, content: '# 折扣\n---\nrules', created_by: 'human', created_at: '2026-11-19T10:00:00.000Z', seen: true });
    await store.save({ name: 'discount', version: 2, content: '# 折扣 v2', created_by: 'pm-1', created_at: '2026-11-19T11:00:00.000Z', note: 'cap', task_id: 'tsk_a', seen: false });
    expect(await store.names()).toEqual(['discount']);
    const versions = await store.versions('discount');
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions[0]).toEqual({ name: 'discount', version: 1, content: '# 折扣\n---\nrules', created_by: 'human', created_at: '2026-11-19T10:00:00.000Z', seen: true });
    expect(versions[1]).toMatchObject({ note: 'cap', task_id: 'tsk_a', seen: false });
    const file = await fs.readFile(path.join(root, '.orchestry', 'prds', 'discount', 'v2.md'), 'utf8');
    expect(file).toMatch(/^---\n[\s\S]*created_by: pm-1[\s\S]*---\n\n# 折扣 v2\n$/);
    expect(await store.versions('none')).toEqual([]);
  });
});

describe('DeliverableStore', () => {
  it('round-trips the report and keeps one per task', async () => {
    const store = new DeliverableStore(new Paths(root));
    const report = '## Summary\nDone\n\n## Verification\nok';
    await store.save({ task_id: 'tsk_a', status: 'partial', report, submitted_by: 'backend-1', submitted_at: '2026-11-19T10:00:00.000Z' });
    expect(await store.get('tsk_a')).toEqual({ task_id: 'tsk_a', status: 'partial', report, submitted_by: 'backend-1', submitted_at: '2026-11-19T10:00:00.000Z' });
    await store.save({ task_id: 'tsk_a', status: 'done', report: 'new', submitted_by: 'backend-1', submitted_at: '2026-11-19T11:00:00.000Z' });
    expect(await store.get('tsk_a')).toMatchObject({ status: 'done', report: 'new' });
    expect(await store.get('tsk_none')).toBeNull();
  });
});
