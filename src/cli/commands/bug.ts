/**
 * `orch bug` — bugs filed by a verifying role (QA).
 *
 *   orch bug add "<title>" --owner <role> --repro … --expected … --actual … [--contract <file>]
 *   orch bug reassign <bug> --to <role> -m "<why>"    once; a second hand-off goes to a human
 *   orch bug verify <bug> --fixed | --not-fixed -m "<what you saw>"
 *   orch bug list [--all]
 */

import type { Command } from 'commander';
import type { LightContainer } from '../../container.js';
import { InvalidArgumentsError } from '../../domain/errors.js';
import { isTerminal } from '../../domain/transitions.js';
import { printSuccess, printTable, dim, amber, statusIcon } from '../output.js';

const agentName = (): string => process.env.ORCH_AGENT_NAME ?? 'human';

export function registerBugCommand(program: Command, container: LightContainer): void {
  const bug = program
    .command('bug')
    .description('Bugs: filed by a verifying role (QA) for exactly one owner role');

  bug
    .command('add <title>')
    .description('File a bug for one owner role (verifiers: from your task; humans: anywhere)')
    .requiredOption('--owner <role>', 'The one role that must fix it')
    .requiredOption('--repro <steps>', 'Steps to reproduce')
    .requiredOption('--expected <text>', 'What should happen')
    .requiredOption('--actual <text>', 'What happens instead')
    .option('--contract <file>', 'Contract file that decides who is right (e.g. docs/api/discount.yaml)')
    .option('--evidence <text>', 'Logs, output, screenshots paths')
    .option('--task <id>', 'Your verification task (default: $ORCH_TASK_ID)')
    .action(async (title: string, opts) => {
      const task = await container.bugService.add(
        { title, owner: opts.owner, repro: opts.repro, expected: opts.expected, actual: opts.actual, contract: opts.contract, evidence: opts.evidence },
        { ...(opts.task ?? process.env.ORCH_TASK_ID ? { taskId: opts.task ?? process.env.ORCH_TASK_ID } : {}), by: agentName() },
      );
      if (container.context.json) {
        console.log(JSON.stringify(task, null, 2));
        return;
      }
      printSuccess(`Filed ${task.id} for ${task.role}: ${task.title}`);
    });

  bug
    .command('reassign <bug>')
    .description('Hand a bug to another role, saying why (once; a second hand-off goes to a human)')
    .requiredOption('--to <role>', 'The role that should fix it')
    .requiredOption('-m, --message <why>', 'Why it is not your role\'s bug')
    .action(async (id: string, opts: { to: string; message: string }) => {
      const r = await container.bugService.reassign({ bugTaskId: id, to: opts.to, reason: opts.message, by: agentName() });
      if (container.context.json) {
        console.log(JSON.stringify(r, null, 2));
        return;
      }
      if (r.result === 'decision') printSuccess(`${id} was handed off already — a human picks the owner (${r.decisionId})`);
      else if (r.result === 'after_run') printSuccess(`${id} goes to ${opts.to} when your run ends`);
      else printSuccess(`${id} → ${opts.to}`);
      if (process.env.ORCH_AGENT_NAME) console.log('  End your run now with a short summary.');
    });

  bug
    .command('verify <bug>')
    .description('Re-verify a bug: --fixed, or --not-fixed -m "<what you saw>"')
    .option('--fixed', 'It works now')
    .option('--not-fixed', 'Still broken')
    .option('-m, --message <text>', 'What you checked / what you saw')
    .action(async (id: string, opts: { fixed?: boolean; notFixed?: boolean; message?: string }) => {
      if (Boolean(opts.fixed) === Boolean(opts.notFixed)) throw new InvalidArgumentsError('Use exactly one of --fixed / --not-fixed');
      const task = await container.bugService.verify({
        bugTaskId: id, fixed: Boolean(opts.fixed), ...(opts.message ? { note: opts.message } : {}), by: agentName(),
        ...(process.env.ORCH_TASK_ID ? { verifyTaskId: process.env.ORCH_TASK_ID } : {}),
      });
      if (container.context.json) {
        console.log(JSON.stringify(task, null, 2));
        return;
      }
      printSuccess(`${id}: ${opts.fixed ? 'fixed' : 'still broken'}`);
    });

  bug
    .command('list')
    .description('List open bugs (--all: also closed ones)')
    .option('-a, --all', 'Include closed bugs')
    .action(async (opts: { all?: boolean }) => {
      const bugs = (await container.taskStore.list()).filter((t) => t.bug && (opts.all || !isTerminal(t.status)));
      if (container.context.json) {
        console.log(JSON.stringify(bugs, null, 2));
        return;
      }
      if (!bugs.length) {
        console.log(opts.all ? '  No bugs.' : '  No open bugs.');
        return;
      }
      printTable(['BUG', 'STATUS', 'OWNER', 'TITLE', 'HAND-OFFS', 'VERIFIED'], bugs.map((t) => [
        t.id,
        `${statusIcon(t.status)} ${t.status}`,
        t.role ?? '—',
        t.title.replace(/^Bug: /, ''),
        String(t.bug!.reassigned?.length ?? 0),
        t.bug!.verified ? (t.bug!.verified.fixed ? 'fixed' : amber('not fixed')) : dim('—'),
      ]));
    });
}
