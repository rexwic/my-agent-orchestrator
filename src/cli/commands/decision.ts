/**
 * `orch decision` command group — things a human decides.
 *
 * Agents ask with `orch decision request` (the task comes from $ORCH_TASK_ID)
 * and stop; ORCH opens one when a send-back loop hits its limit; a task added
 * with `--needs-decision` waits for one before it starts. The task waits in
 * `waiting_decision` until `orch decision answer`.
 *
 * Subcommands: list, show, request, answer
 */

import type { Command } from 'commander';
import type { LightContainer } from '../../container.js';
import type { Decision, DecisionAction } from '../../domain/decision.js';
import { describeAnswer } from '../../domain/decision.js';
import { InvalidArgumentsError } from '../../domain/errors.js';
import { printSuccess, printTable, printKeyValue, dim, amber } from '../output.js';

const SOURCE_LABEL: Record<Decision['source'], string> = {
  escalation: 'loop limit',
  agent: 'agent asked',
  gate: 'gate',
  plan: 'plan',
  delivery: 'delivery',
  review: 'review',
  bug: 'bug',
};

const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

function oneLine(text: string, max = 70): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function registerDecisionCommand(program: Command, container: LightContainer): void {
  const decision = program
    .command('decision')
    .description('Decisions for a human: agent questions, loop escalations, gates');

  decision
    .command('list')
    .description('List pending decisions (--all: also answered ones)')
    .option('-a, --all', 'Include answered decisions')
    .option('--task <id>', 'Only decisions on this task')
    .action(async (opts) => {
      const items = await container.decisionService.list({
        ...(opts.all ? {} : { status: 'pending' as const, assignee: 'human' }),
        ...(opts.task ? { taskId: opts.task } : {}),
      });
      const withRoles = opts.all ? [] : (await container.decisionService.list({ status: 'pending' })).filter((d) => d.assignee);
      const unseen = await container.prdService.unseen().catch(() => []);
      if (container.context.json) {
        console.log(JSON.stringify(items, null, 2));
        return;
      }
      const notices = (): void => {
        if (withRoles.length) {
          console.log(dim(`\n  ${withRoles.length} question(s) are with ${[...new Set(withRoles.map((d) => d.assignee))].join(', ')} first (they answer or escalate to you): orch decision list --all`));
        }
        for (const [name, versions] of groupBy(unseen, (v) => v.name)) {
          const last = versions.at(-1)!;
          console.log(`  ${amber('PRD changed')}: ${name} v${versions.map((v) => v.version).join(', v')} (${last.created_by}${last.note ? `: ${oneLine(last.note, 60)}` : ''}) → orch prd diff ${name}`);
        }
      };
      if (items.length === 0) {
        console.log(opts.all ? '  No decisions yet.' : '  No pending decisions.');
        notices();
        return;
      }
      printTable(
        ['ID', 'STATUS', 'TASK', 'FROM', 'QUESTION'],
        items.map((d) => [
          d.id,
          d.status === 'pending' ? amber('pending') : dim('answered'),
          d.task_id ?? '—',
          `${SOURCE_LABEL[d.source]}${d.requested_by && d.source === 'agent' ? ` (${d.requested_by})` : ''}${d.assignee ? amber(` → ${d.assignee}`) : ''}`,
          d.status === 'answered'
            ? `${oneLine(d.question, 50)} ${dim('→')} ${oneLine(describeAnswer(d), 30)}${d.answer?.answered_by && d.answer.answered_by !== 'human' ? dim(` (${d.answer.answered_by})`) : ''}`
            : oneLine(d.question),
        ]),
      );
      if (!opts.all) console.log(dim(`\n  Answer: orch decision answer <id> --choose <option> | -m "<answer>" [--approve | --cancel] [--project]`));
      notices();
    });

  decision
    .command('show <id>')
    .description('Show a decision with its options and background')
    .action(async (id: string) => {
      const d = await container.decisionService.get(id);
      if (container.context.json) {
        console.log(JSON.stringify(d, null, 2));
        return;
      }
      const pairs: Array<[string, string]> = [
        ['Decision', d.id],
        ['Status', d.status === 'pending' ? amber('pending') : 'answered'],
        ['From', `${SOURCE_LABEL[d.source]} · ${d.requested_by}`],
        ['Task', d.task_id ?? '—'],
        ['Asked', d.created_at],
      ];
      if (d.assignee) pairs.push(['With', amber(`${d.assignee} (task ${d.triage_task_id ?? '?'}) — it answers or escalates to you; you can still answer it`)]);
      if (d.answer) {
        pairs.push(['Answer', describeAnswer(d)], ['Action', d.answer.action], ['Scope', d.answer.scope], ['Answered', `${d.answer.answered_at}${d.answer.answered_by ? ` by ${d.answer.answered_by}` : ''}`]);
      }
      printKeyValue(pairs);
      console.log(`\n  ${d.question}`);
      if (d.options.length) {
        console.log('');
        d.options.forEach((o, i) => console.log(`  ${i + 1}. ${o}`));
      }
      if (d.context) console.log(`\n${dim('  Background')}\n${d.context.replace(/^/gm, '  ')}`);
      if (d.status === 'pending') {
        console.log(dim(`\n  orch decision answer ${d.id} ${d.options.length ? '--choose <n|option> ' : ''}-m "<answer>"   (continue the task)`));
        console.log(dim(`  orch decision answer ${d.id} --approve | --cancel          add --project to make it a project-wide rule`));
      }
    });

  decision
    .command('request <question>')
    .description('Ask a human to decide; the task waits until answered (agents: then end your run)')
    .option('--task <id>', 'Task this is about (default: $ORCH_TASK_ID)')
    .option('-o, --option <choice>', 'A possible answer (repeatable)', collect, [])
    .option('--context <text>', 'Background the human needs')
    .action(async (question: string, opts) => {
      const agentName = process.env.ORCH_AGENT_NAME;
      const taskId: string | undefined = opts.task ?? process.env.ORCH_TASK_ID;
      const created = await container.decisionService.request({
        question,
        options: opts.option,
        ...(opts.context ? { context: opts.context } : {}),
        ...(taskId ? { task_id: taskId } : {}),
        source: agentName ? 'agent' : 'gate',
        requested_by: agentName ?? 'human',
      });
      if (container.context.json) {
        console.log(JSON.stringify(created, null, 2));
        return;
      }
      printSuccess(`Requested ${created.id}${taskId ? ` — task ${taskId} waits for the answer` : ''}`);
      if (agentName) console.log('  Stop here: end your run with a short summary. You will be resumed with the answer.');
    });

  decision
    .command('escalate <id>')
    .description('Hand a question you hold (as the PM) to a human, saying why')
    .requiredOption('-m, --message <why>', 'Why a human must decide, and the options you see')
    .action(async (id: string, opts) => {
      const by = process.env.ORCH_AGENT_NAME;
      if (!by) throw new InvalidArgumentsError('Only an agent holding the question escalates it; as a human, answer it: orch decision answer ' + id);
      const d = await container.decisionService.escalate(id, { by, note: opts.message });
      if (container.context.json) {
        console.log(JSON.stringify(d, null, 2));
        return;
      }
      printSuccess(`Escalated ${id} to a human`);
      console.log('  End your run with a short summary.');
    });

  decision
    .command('answer <id>')
    .description('Answer a pending decision; the task continues (or is approved / cancelled)')
    .option('-c, --choose <option>', 'One of the options (its text or number)')
    .option('-m, --message <text>', 'Your answer / instructions')
    .option('--approve', 'Approve: a task as it is (synced, verified, merged), a gate (it starts), a plan (its tasks are created)')
    .option('--cancel', 'Cancel the task')
    .option('--project', 'A project-wide rule: every agent sees it from now on')
    .action(async (id: string, opts) => {
      if (opts.approve && opts.cancel) throw new InvalidArgumentsError('Use either --approve or --cancel, not both');
      const action: DecisionAction = opts.approve ? 'approve' : opts.cancel ? 'cancel' : 'continue';
      const agent = process.env.ORCH_AGENT_NAME;
      const result = await container.decisionService.answer(id, {
        choice: opts.choose,
        message: opts.message,
        action,
        scope: opts.project ? 'project' : 'task',
      }, agent ? { agent } : {});
      if (agent && !container.context.json) {
        printSuccess(`Answered ${id}: ${describeAnswer(result.decision)}`);
        console.log('  The teammate continues with your answer. End your run with a short summary.');
        return;
      }

      if (container.context.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      const taskId = result.decision.task_id;
      printSuccess(`Answered ${id}: ${describeAnswer(result.decision)}${opts.project ? ' (project-wide)' : ''}`);
      if (result.decision.plan_id) {
        const { describePlanOutcome } = await import('./plan.js');
        console.log(describePlanOutcome(await container.planService.get(result.decision.plan_id)));
        return;
      }
      if (!taskId) return;
      if (result.stillPending > 0) {
        console.log(`  Task ${taskId} still waits for ${result.stillPending} other decision(s).`);
        return;
      }
      if (!result.task) {
        console.log(dim(`  Task ${taskId} was not waiting for a decision; the answer is recorded for its next run.`));
        return;
      }
      if (result.task.status === 'todo') console.log(`  Task ${taskId} → todo (an agent ${action === 'approve' ? 'starts it' : 'continues with your answer'})`);
      if (result.task.status === 'cancelled') {
        if (result.task.workspace) {
          const { buildFullContainer } = await import('../../container.js');
          await (await buildFullContainer(container.context)).orchestrator.discardCancelledWork(taskId);
        }
        console.log(`  Task ${taskId} → cancelled${result.task.workspace ? ' (its worktree and branch are removed)' : ''}`);
      }
      if (result.task.status === 'review' && result.task.approved) {
        // Integration (sync main, review, merge) needs the full container.
        const { buildFullContainer } = await import('../../container.js');
        const full = await buildFullContainer(container.context);
        const outcome = await full.orchestrator.approveTask(taskId);
        console.log(`  Task ${taskId} approved → ${outcome.status === 'queued' ? 'the running orchestrator merges it' : outcome.status}${'detail' in outcome ? ` (${outcome.detail})` : ''}`);
      }
    });
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  return map;
}
