/**
 * `orch plan` command group — a requirement, planned by an agent, approved by a human.
 *
 *   orch plan "<requirement>"      (= orch plan new) a planner agent breaks it into tasks
 *   orch plan submit <file>        the planner submits its plan (validated)
 *   orch plan show <id>            the plan: tasks, roles, order, scopes
 *   orch plan approve <id>         create the goal and the tasks
 *   orch plan reject <id> -m "…"   send it back to the planner (next revision)
 *   orch plan cancel <id>
 *
 * Approving / rejecting is also possible with `orch decision answer` on the
 * plan's decision (it shows up in `orch decision list`).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import yaml from 'js-yaml';
import type { LightContainer } from '../../container.js';
import { InvalidArgumentsError } from '../../domain/errors.js';
import type { Plan, PlanStatus } from '../../domain/plan.js';
import { printSuccess, printTable, printKeyValue, printWarning, dim, amber, truncateToWidth } from '../output.js';

const STATUS_LABEL: Record<PlanStatus, string> = {
  planning: 'planning',
  awaiting_approval: 'awaiting approval',
  approved: 'approved',
  cancelled: 'cancelled',
};

function statusText(status: PlanStatus): string {
  return status === 'awaiting_approval' ? amber(STATUS_LABEL[status]) : status === 'cancelled' ? dim(STATUS_LABEL[status]) : STATUS_LABEL[status];
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return truncateToWidth(flat, max);
}

/** What happened to a plan after an answer (also used by `orch decision answer`). */
export function describePlanOutcome(plan: Plan): string {
  switch (plan.status) {
    case 'approved': {
      const n = Object.keys(plan.created_tasks ?? {}).length;
      return `  Plan ${plan.id} approved → ${n} task(s) created under goal ${plan.goal_id}. Start agents (orch run --watch / orch tui) if none are running.`;
    }
    case 'planning':
      return `  Plan ${plan.id} sent back → revision ${plan.revision}, planned by task ${plan.planning_task_id}`;
    case 'cancelled':
      return `  Plan ${plan.id} cancelled`;
    case 'awaiting_approval':
      return `  Plan ${plan.id} still awaits approval`;
  }
}

async function readPlanFile(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await fs.readFile(path.resolve(file), 'utf8');
  } catch {
    throw new InvalidArgumentsError(`Cannot read plan file: ${file}`, 'Write the plan to a YAML file first, e.g. plan.yml');
  }
  try {
    return yaml.load(text);
  } catch (err) {
    throw new InvalidArgumentsError(`${file} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function registerPlanCommand(program: Command, container: LightContainer): void {
  const plan = program
    .command('plan')
    .description('Plan a requirement with a planner agent; approve the plan to create its tasks');

  plan
    .command('new [requirement...]', { isDefault: true })
    .description('Start planning a requirement (a planner agent breaks it into tasks)')
    .option('-f, --file <path>', 'Read the requirement from a file (e.g. a PRD)')
    .option('-t, --title <title>', 'Short title (default: first line of the requirement)')
    .option('--role <name>', 'Planner role (default: config planner.role, else "planner")')
    .option('--prd <name>', 'Plan the latest version of this PRD (orch prd list)')
    .action(async (words: string[] | undefined, opts) => {
      let requirement = (words ?? []).join(' ').trim();
      let prd: { name: string; version: number } | undefined;
      if (opts.prd) {
        const v = await container.prdService.get(opts.prd);
        prd = { name: v.name, version: v.version };
        requirement = [requirement, v.content].filter(Boolean).join('\n\n');
      }
      if (opts.file) {
        const fromFile = await fs.readFile(path.resolve(opts.file), 'utf8').catch(() => {
          throw new InvalidArgumentsError(`Cannot read requirement file: ${opts.file}`);
        });
        requirement = [requirement, fromFile.trim()].filter(Boolean).join('\n\n');
      }
      if (!requirement) {
        throw new InvalidArgumentsError('Describe the requirement', 'orch plan "<requirement>"  or  orch plan new -f requirement.md');
      }
      const { plan: created, task } = await container.planService.start({
        requirement,
        ...(opts.role ? { role: opts.role } : {}),
        ...(opts.title ? { title: opts.title } : {}),
        ...(prd ? { prd } : {}),
      });
      if (container.context.json) {
        console.log(JSON.stringify({ plan: created, task }, null, 2));
        return;
      }
      if (container.context.quiet) {
        console.log(created.id);
        return;
      }
      printSuccess(`Plan ${created.id} started — task ${task.id} for the ${created.role} role`);
      console.log(dim('  The planner submits a plan; you approve it with: orch plan approve ' + created.id));
      console.log(dim('  Follow it with: orch plan show ' + created.id + '   (agents must be running: orch run --watch / orch tui)'));
    });

  plan
    .command('list')
    .description('List plans (--all: also approved and cancelled ones)')
    .option('-a, --all', 'Include approved and cancelled plans')
    .action(async (opts) => {
      const plans = (await container.planService.list())
        .filter((p) => opts.all || p.status === 'planning' || p.status === 'awaiting_approval');
      if (container.context.json) {
        console.log(JSON.stringify(plans, null, 2));
        return;
      }
      if (plans.length === 0) {
        console.log(opts.all ? '  No plans yet.' : '  No open plans. (orch plan list --all for every plan)');
        return;
      }
      printTable(
        ['ID', 'STATUS', 'REV', 'TASKS', 'TITLE'],
        plans.map((p) => [
          p.id,
          statusText(p.status),
          String(p.revision),
          p.draft ? String(p.draft.tasks.length) : '—',
          oneLine(p.draft?.goal ?? p.title, 60),
        ]),
      );
    });

  plan
    .command('show <id>')
    .description('Show a plan: its tasks, roles, order and scopes (id: plan or planning task)')
    .action(async (id: string) => {
      const p = await container.planService.get(id);
      if (container.context.json) {
        console.log(JSON.stringify(p, null, 2));
        return;
      }
      const planner = await container.taskStore.get(p.planning_task_id);
      const pairs: Array<[string, string]> = [
        ['Plan', p.id],
        ['Status', statusText(p.status)],
        ['Revision', String(p.revision)],
        ['Planner', `${p.role} · task ${p.planning_task_id}${planner ? ` (${planner.status})` : ''}`],
      ];
      if (p.submitted_at) pairs.push(['Submitted', `${p.submitted_at} by ${p.submitted_by ?? '?'}`]);
      if (p.decision_id) pairs.push(['Decision', p.decision_id]);
      if (p.goal_id) pairs.push(['Goal', p.goal_id]);
      if (p.prd) pairs.push(['PRD', `${p.prd.name} v${p.prd.version}${p.status === 'awaiting_approval' ? amber(' — approved together with this plan') : ''}`]);
      printKeyValue(pairs);
      console.log(`\n${dim(p.prd ? `  Requirement (PRD ${p.prd.name} v${p.prd.version})` : '  Requirement')}\n${p.requirement.slice(0, 2000).replace(/^/gm, '  ')}`);
      if (p.prd && p.requirement.length > 2000) console.log(dim(`  … the whole PRD: orch prd show ${p.prd.name} ${p.prd.version}`));
      if (p.feedback && p.status === 'planning') console.log(`\n${dim('  Sent back with')}\n  ${p.feedback}`);

      if (!p.draft) {
        console.log(dim('\n  Nothing submitted yet.'));
        return;
      }
      console.log(`\n  ${p.draft.goal}`);
      if (p.draft.summary) console.log(dim(`  ${p.draft.summary.replace(/\n/g, '\n  ')}`));
      console.log('');
      const created = p.created_tasks ?? {};
      printTable(
        ['KEY', 'ROLE', 'TITLE', 'AFTER', 'SCOPE', 'CONTRACT', 'CHECKS', p.status === 'approved' ? 'TASK' : 'GATE'],
        p.draft.tasks.map((t) => [
          t.key,
          t.role,
          oneLine(t.title, 40),
          t.depends_on.join(', ') || '—',
          oneLine(t.scope?.join(', ') ?? '—', 30),
          oneLine([...(t.produces ?? []).map((p) => '→ ' + p), ...(t.uses ?? []).map((u) => '← ' + u)].join(', ') || '—', 34),
          t.review_criteria?.join(', ') ?? '—',
          p.status === 'approved' ? (created[t.key] ?? '—') : (t.needs_decision ? amber('asks you') : ''),
        ]),
      );
      if (p.draft.tasks.some((t) => t.produces?.length || t.uses?.length)) {
        console.log(dim('  CONTRACT: → files the task produces · ← contract files it follows and must not change'));
      }
      if (p.status === 'awaiting_approval') {
        const check = await container.planService.validate(p.draft, p);
        for (const w of [...check.errors, ...check.warnings]) printWarning(w);
        console.log(dim(`\n  Task details: orch plan show ${p.id} --json`));
        console.log(`  orch plan approve ${p.id}   ${dim('· create these tasks')}`);
        console.log(`  orch plan reject ${p.id} -m "<what to change>"   ${dim('· back to the planner')}`);
        console.log(`  orch plan cancel ${p.id}`);
      }
    });

  plan
    .command('submit [file]')
    .description('Submit a plan file (planner agents; the plan comes from $ORCH_TASK_ID)')
    .option('--plan <id>', 'Plan to submit to (default: from $ORCH_TASK_ID, or the only open plan)')
    .action(async (file: string | undefined, opts) => {
      const raw = await readPlanFile(file ?? 'plan.yml');
      const agentName = process.env.ORCH_AGENT_NAME;
      const { plan: submitted, decision, warnings } = await container.planService.submit({
        raw,
        ...(opts.plan ? { planId: opts.plan } : {}),
        ...(process.env.ORCH_TASK_ID ? { taskId: process.env.ORCH_TASK_ID } : {}),
        submittedBy: agentName ?? 'human',
      });
      if (container.context.json) {
        console.log(JSON.stringify({ plan: submitted, decision, warnings }, null, 2));
        return;
      }
      printSuccess(`Plan ${submitted.id} accepted: ${submitted.draft!.tasks.length} task(s) — waits for a human to approve it (${decision.id})`);
      for (const w of warnings) printWarning(w);
      if (agentName) console.log('  Done: end your run with a short summary of the plan.');
    });

  plan
    .command('approve <id>')
    .description('Approve the submitted plan: create its goal and tasks')
    .option('-m, --message <text>', 'Note recorded with the approval')
    .action(async (id: string, opts) => {
      const approved = await container.planService.approve(id, opts.message);
      if (container.context.json) {
        console.log(JSON.stringify(approved, null, 2));
        return;
      }
      printSuccess(`Approved ${approved.id}`);
      console.log(describePlanOutcome(approved));
    });

  plan
    .command('reject <id>')
    .description('Send the submitted plan back to the planner with feedback')
    .requiredOption('-m, --message <text>', 'What to change')
    .action(async (id: string, opts) => {
      const revised = await container.planService.revise(id, opts.message);
      if (container.context.json) {
        console.log(JSON.stringify(revised, null, 2));
        return;
      }
      printSuccess(`Sent ${revised.id} back`);
      console.log(describePlanOutcome(revised));
    });

  plan
    .command('cancel <id>')
    .description('Drop a plan (and stop its planner)')
    .action(async (id: string) => {
      const cancelled = await container.planService.cancel(id);
      if (container.context.json) {
        console.log(JSON.stringify(cancelled, null, 2));
        return;
      }
      printSuccess(`Cancelled ${cancelled.id}`);
    });
}
