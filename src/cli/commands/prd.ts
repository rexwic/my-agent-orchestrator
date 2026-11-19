/**
 * `orch prd` command group — versioned product requirements (PRDs).
 *
 *   orch prd "<requirement>"         the PM role drafts a PRD (then a plan is made from it)
 *   orch prd add <name> -f prd.md    save a new version (humans, and the PM agent)
 *   orch prd list / show / diff
 *
 * Versions the PM writes while answering questions are not approved again; they
 * show up as unseen (orch decision list) until a human looks at them.
 */

import type { Command } from 'commander';
import type { LightContainer } from '../../container.js';
import { InvalidArgumentsError } from '../../domain/errors.js';
import type { PrdVersion } from '../../domain/prd.js';
import { printSuccess, printTable, printKeyValue, dim, amber, truncateToWidth } from '../output.js';
import { textDiff } from '../text-diff.js';

async function readSource(file: string): Promise<string> {
  if (file === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return Buffer.concat(chunks).toString('utf8');
  }
  const fs = await import('node:fs/promises');
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    throw new InvalidArgumentsError(`File not found: ${file}`);
  }
}

const isHuman = (): boolean => !process.env.ORCH_AGENT_NAME;

function versionLine(v: PrdVersion): string {
  return `v${v.version} · ${v.created_by} · ${v.created_at}${v.note ? ` · ${v.note}` : ''}`;
}

export function registerPrdCommand(program: Command, container: LightContainer): void {
  const prd = program
    .command('prd')
    .description('Product requirements (PRD) with versions: the PM drafts them, plans are made from them');

  prd
    .command('new [requirement...]', { isDefault: true })
    .description('Have the PM role draft a PRD from a requirement (then a planner plans it)')
    .option('-f, --file <path>', 'Read the requirement from a file')
    .option('--name <name>', 'PRD name (lowercase, e.g. order-discounts); an existing name gets its next version')
    .option('-t, --title <title>', 'Short title')
    .action(async (words: string[], opts) => {
      const requirement = opts.file ? await readSource(opts.file) : words.join(' ');
      const { name, task } = await container.prdService.startDraft({
        requirement,
        ...(opts.name ? { name: opts.name } : {}),
        ...(opts.title ? { title: opts.title } : {}),
      });
      if (container.context.json) {
        console.log(JSON.stringify({ name, task }, null, 2));
        return;
      }
      printSuccess(`The ${container.prdService.pmRole} role drafts PRD "${name}" (task ${task.id})`);
      console.log(dim('  Start agents if none are running: orch run --watch / orch tui'));
      console.log(dim('  When the PM hands it in, a planner plans it; approve the PRD and the plan together with orch plan approve.'));
    });

  prd
    .command('add <name>')
    .description('Save a new version of a PRD (agents: the PM hands in a draft or a change this way)')
    .requiredOption('-f, --file <path>', 'Markdown file ("-" reads stdin)')
    .option('-m, --note <text>', 'What this version covers or changes')
    .action(async (name: string, opts) => {
      const v = await container.prdService.add({
        name,
        content: await readSource(opts.file),
        ...(opts.note ? { note: opts.note } : {}),
        createdBy: process.env.ORCH_AGENT_NAME ?? 'human',
        ...(process.env.ORCH_TASK_ID ? { taskId: process.env.ORCH_TASK_ID } : {}),
      });
      if (container.context.json) {
        console.log(JSON.stringify(v, null, 2));
        return;
      }
      printSuccess(`Saved ${v.name} v${v.version}`);
      if (!isHuman()) console.log('  Saved. Tasks that implement this PRD get this version from their next run.');
    });

  prd
    .command('list')
    .description('List PRDs with their latest version')
    .action(async () => {
      const items = await container.prdService.list();
      if (container.context.json) {
        console.log(JSON.stringify(items, null, 2));
        return;
      }
      if (items.length === 0) {
        console.log('  No PRDs yet. Draft one: orch prd "<requirement>"  ·  or save yours: orch prd add <name> -f prd.md');
        return;
      }
      printTable(
        ['NAME', 'LATEST', 'BY', 'UPDATED', 'NOTE'],
        items.map((p) => [
          p.name,
          `v${p.latest.version}${p.unseen ? ` ${amber(`(${p.unseen} unseen)`)}` : ''}`,
          p.latest.created_by,
          p.latest.created_at.slice(0, 16).replace('T', ' '),
          truncateToWidth(p.latest.note ?? '', 50),
        ]),
      );
    });

  prd
    .command('show <name> [version]')
    .description('Show a PRD (default: its latest version; e.g. orch prd show discount 2)')
    .action(async (name: string, version: string | undefined) => {
      const v = await container.prdService.get(name, version !== undefined ? Number(version.replace(/^v/, '')) : undefined);
      if (container.context.json) {
        console.log(JSON.stringify(v, null, 2));
        return;
      }
      const all = await container.prdService.versions(name);
      printKeyValue([
        ['PRD', `${v.name} v${v.version}${v.version < all.length ? dim(` (latest: v${all.length})`) : ''}`],
        ['Written by', `${v.created_by} · ${v.created_at}`],
        ...(v.note ? [['Note', v.note] as [string, string]] : []),
      ]);
      console.log(`\n${v.content.replace(/^/gm, '  ')}\n`);
      if (all.length > 1) console.log(dim(`  Versions: ${all.map((x) => `v${x.version}`).join(', ')} · changes: orch prd diff ${name}`));
      if (isHuman()) await container.prdService.markSeen(name, v.version);
    });

  prd
    .command('diff <name> [from] [to]')
    .description('What changed between two versions (default: the previous and the latest)')
    .action(async (name: string, from: string | undefined, to: string | undefined) => {
      const all = await container.prdService.versions(name);
      if (all.length === 0) throw new InvalidArgumentsError(`No PRD named "${name}"`, 'List them with: orch prd list');
      const toV = await container.prdService.get(name, to !== undefined ? Number(String(to).replace(/^v/, '')) : undefined);
      const fromN = from !== undefined ? Number(String(from).replace(/^v/, '')) : toV.version - 1;
      if (fromN < 1) {
        console.log(`  ${name} has only v${toV.version}. Show it: orch prd show ${name}`);
        if (isHuman()) await container.prdService.markSeen(name, toV.version);
        return;
      }
      const fromV = await container.prdService.get(name, fromN);
      console.log(`  ${dim('from')} ${versionLine(fromV)}\n  ${dim('to  ')} ${versionLine(toV)}\n`);
      process.stdout.write(await textDiff(fromV.content, toV.content, `v${fromV.version}`, `v${toV.version}`));
      if (isHuman()) await container.prdService.markSeen(name, toV.version);

      // Work finished on an older version may need to follow the change.
      const done = await container.prdService.doneBefore(name, fromV.version + 1);
      if (done.length) {
        console.log(`\n  ${amber(`Done before v${fromV.version + 1}`)} (built on an older version):`);
        for (const t of done) console.log(`    ${t.id}  ${t.title}`);
        console.log(dim(`  If they must follow the change: orch plan new --prd ${name} --since ${fromV.version}   (plans only what changed)`));
      }
    });
}
