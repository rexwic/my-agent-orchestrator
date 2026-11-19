/**
 * Contract files (a task's `uses`) read from its workspace for the prompt.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export const MAX_CONTRACT_CHARS = 20_000;
export const MAX_CONTRACTS_TOTAL_CHARS = 40_000;

export interface ContractFile {
  path: string;
  /** Empty when missing. */
  content: string;
  missing?: boolean;
  /** Cut to fit the prompt (the agent reads the full file itself). */
  truncated?: boolean;
}

export async function readContractFiles(
  workspace: string,
  paths: readonly string[],
  limits: { each?: number; total?: number } = {},
): Promise<ContractFile[]> {
  const each = limits.each ?? MAX_CONTRACT_CHARS;
  let left = limits.total ?? MAX_CONTRACTS_TOTAL_CHARS;
  const out: ContractFile[] = [];
  for (const p of paths) {
    let text: string;
    try {
      text = await fs.readFile(path.join(workspace, p), 'utf8');
    } catch {
      out.push({ path: p, content: '', missing: true });
      continue;
    }
    const max = Math.max(0, Math.min(each, left));
    const truncated = text.length > max;
    const content = truncated ? text.slice(0, max) : text;
    left -= content.length;
    out.push({ path: p, content, ...(truncated ? { truncated: true } : {}) });
  }
  return out;
}
