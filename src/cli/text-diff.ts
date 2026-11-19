/**
 * Text diff for the CLI (PRD versions): git diff --no-index on two temp files.
 */

/** Unified diff of two texts (git diff --no-index), or both texts when git is unavailable. */
export async function textDiff(a: string, b: string, labelA: string, labelB: string): Promise<string> {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { execFile } = await import('node:child_process');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-prd-'));
  try {
    await fs.writeFile(path.join(dir, labelA), `${a}\n`);
    await fs.writeFile(path.join(dir, labelB), `${b}\n`);
    const out = await new Promise<string | null>((resolve) => {
      execFile('git', ['diff', '--no-index', '--no-color', labelA, labelB], { cwd: dir, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        // Exit code 1 means "different".
        resolve(err && (err as { code?: unknown }).code !== 1 ? null : stdout);
      });
    });
    if (out === null) return `--- ${labelA}\n${a}\n+++ ${labelB}\n${b}\n`;
    return out.split('\n').filter((l) => !/^(diff --git|index |--- |\+\+\+ )/.test(l)).join('\n');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
