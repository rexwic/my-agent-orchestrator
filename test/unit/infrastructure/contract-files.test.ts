import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readContractFiles } from '../../../src/infrastructure/workspace/contract-files.js';

let dir: string;
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-contracts-'));
  await fs.mkdir(path.join(dir, 'docs'), { recursive: true });
  await fs.writeFile(path.join(dir, 'docs/a.yaml'), 'a'.repeat(30));
  await fs.writeFile(path.join(dir, 'docs/b.yaml'), 'b'.repeat(30));
});
afterAll(() => fs.rm(dir, { recursive: true, force: true }));

describe('readContractFiles', () => {
  it('reads each file, cuts to the per-file and total limits, marks missing files', async () => {
    const files = await readContractFiles(dir, ['docs/a.yaml', 'docs/b.yaml', 'docs/none.yaml'], { each: 20, total: 35 });
    expect(files).toEqual([
      { path: 'docs/a.yaml', content: 'a'.repeat(20), truncated: true },
      { path: 'docs/b.yaml', content: 'b'.repeat(15), truncated: true },
      { path: 'docs/none.yaml', content: '', missing: true },
    ]);
  });

  it('small files are given whole', async () => {
    expect(await readContractFiles(dir, ['docs/a.yaml'])).toEqual([{ path: 'docs/a.yaml', content: 'a'.repeat(30) }]);
  });
});
