/**
 * `orch role` command group.
 *
 * A role is the single source of configuration for a kind of worker
 * (adapter, model, effort, prompt, …) and keeps `replicas` agents
 * (`<role>-1`, `<role>-2`, …). Edit .orchestry/roles/<name>.yml directly or use
 * these commands; `orch serve`/`orch run` apply changes on their next tick.
 *
 * Subcommands: add, list, show, scale, remove, sync
 */

import type { Command } from 'commander';
import type { LightContainer } from '../../container.js';
import type { ApprovalPolicy, ReasoningEffort } from '../../domain/agent.js';
import type { RoleSyncResult } from '../../application/role-service.js';
import type { ReviewCriterion, WorkspaceMode } from '../../domain/task.js';
import { InvalidArgumentsError } from '../../domain/errors.js';
import { describeQuotaGroup } from '../../domain/quota.js';
import { printSuccess, printTable, printKeyValue, dim, statusIcon } from '../output.js';

const list = (value?: string): string[] | undefined =>
  value ? value.split(',').map((s) => s.trim()).filter(Boolean) : undefined;

function parseReplicas(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentsError(`--replicas must be a non-negative integer, got "${value}"`);
  return n;
}

function printSync(result: RoleSyncResult): void {
  if (result.created.length) console.log(`  ${dim('created')}  ${result.created.join(', ')}`);
  if (result.updated.length) console.log(`  ${dim('updated')}  ${result.updated.join(', ')}`);
  if (result.removed.length) console.log(`  ${dim('removed')}  ${result.removed.join(', ')}`);
  if (result.pendingRemoval.length) console.log(`  ${dim('busy — removed when idle')}  ${result.pendingRemoval.join(', ')}`);
  for (const e of result.errors) console.log(`  ${dim('invalid')}  ${e.file}: ${e.message}`);
}

export function registerRoleCommand(program: Command, container: LightContainer): void {
  const role = program
    .command('role')
    .description('Manage roles — model/effort/prompt per role, N agents each');

  role
    .command('add <name>')
    .description('Create a role and its agents')
    .requiredOption('--adapter <adapter>', 'claude, codex, antigravity, opencode, cursor, pi, grok, shell')
    .option('--model <model>', 'Model for every agent of this role')
    .option('--effort <level>', 'Reasoning effort: low, medium, high')
    .option('--replicas <n>', 'Number of agents (default 1)')
    .option('-d, --description <text>', 'What this role does (used in prompts)')
    .option('--system-prompt <text>', 'System prompt for this role')
    .option('--skills <skills>', 'Comma-separated skills')
    .option('--approval-policy <policy>', 'suggest | auto | manual')
    .option('--workspace-mode <mode>', 'shared | worktree | isolated')
    .option('--review-criteria <criteria>', 'Default review criteria for its tasks: test_pass,typecheck,lint')
    .option('--quota-group <group>', 'Override the quota group (account) these agents share')
    .option('--command <cmd>', 'Shell adapter only: command to run')
    .action(async (name: string, opts) => {
      const reviewCriteria = list(opts.reviewCriteria) as ReviewCriterion[] | undefined;
      const { role: created, sync } = await container.roleService.create({
        name,
        adapter: opts.adapter,
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.effort ? { effort: opts.effort as ReasoningEffort } : {}),
        ...(opts.replicas !== undefined ? { replicas: parseReplicas(opts.replicas) } : {}),
        ...(opts.description ? { description: opts.description } : {}),
        ...(opts.systemPrompt ? { system_prompt: opts.systemPrompt } : {}),
        ...(opts.skills ? { skills: list(opts.skills) } : {}),
        ...(opts.approvalPolicy ? { approval_policy: opts.approvalPolicy as ApprovalPolicy } : {}),
        ...(opts.workspaceMode ? { workspace_mode: opts.workspaceMode as WorkspaceMode } : {}),
        ...(reviewCriteria ? { task_defaults: { review_criteria: reviewCriteria } } : {}),
        ...(opts.quotaGroup ? { quota_group: opts.quotaGroup } : {}),
        ...(opts.command ? { command: opts.command } : {}),
      });
      printSuccess(`Added role ${created.name} (${created.adapter}${created.model ? `, ${created.model}` : ''}) × ${created.replicas}`);
      printSync(sync);
      console.log(`  ${dim(`Edit: .orchestry/roles/${created.name}.yml · Use: orch task add "…" --role ${created.name}`)}`);
    });

  role
    .command('list')
    .description('List roles with their agents')
    .action(async () => {
      const [{ roles, errors }, agents, pauses] = await Promise.all([
        container.roleService.load(),
        container.agentService.list(),
        container.quotaService.currentPauses(),
      ]);

      if (container.context.json) {
        console.log(JSON.stringify({ roles, errors }, null, 2));
        return;
      }
      if (roles.length === 0 && errors.length === 0) {
        console.log(`\n  No roles. Add one: ${dim('orch role add backend --adapter claude --model sonnet --replicas 2')}\n`);
        return;
      }

      const rows = roles.map((r) => {
        const instances = agents.filter((a) => a.role_id === r.name);
        const running = instances.filter((a) => a.status === 'running').length;
        const paused = instances.filter((a) => container.quotaService.groupOf(a) in pauses).length;
        const state = [`${running} busy`, ...(paused ? [`${paused} paused`] : [])].join(' · ');
        return [
          r.name,
          r.adapter,
          [r.model, r.effort].filter(Boolean).join(' / ') || dim('default'),
          `${instances.length}/${r.replicas}`,
          state,
          dutyText(r) || dim('—'),
        ];
      });
      console.log();
      printTable(['ROLE', 'ADAPTER', 'MODEL / EFFORT', 'AGENTS', 'STATE', 'DUTIES'], rows);
      for (const e of errors) console.log(`\n  ${dim('invalid')} ${e.file}: ${e.message}`);
      console.log();
    });

  role
    .command('show <name>')
    .description('Show a role and its agents')
    .action(async (name: string) => {
      const r = await container.roleService.get(name);
      const instances = await container.roleService.instances(name);
      if (container.context.json) {
        console.log(JSON.stringify({ role: r, agents: instances }, null, 2));
        return;
      }
      const pauses = await container.quotaService.currentPauses();

      console.log(`\n  ${r.name}${r.description ? ` — ${r.description}` : ''}`);
      console.log(`  ${'═'.repeat(42)}\n`);
      const pairs: Array<[string, string]> = [
        ['Adapter', r.adapter],
        ['Model', r.model ?? 'default'],
        ['Effort', r.effort ?? 'default'],
        ['Replicas', String(r.replicas)],
        ['Policy', r.approval_policy ?? 'project default'],
        ['Workspace', r.workspace_mode ?? 'project default'],
      ];
      if (r.task_defaults?.review_criteria?.length) pairs.push(['Review', r.task_defaults.review_criteria.join(', ')]);
      if (r.skills?.length) pairs.push(['Skills', r.skills.join(', ')]);
      if (dutyText(r)) pairs.push(['Duties', dutyText(r)]);
      if (instances[0]) pairs.push(['Quota', describeQuotaGroup(container.quotaService.groupOf(instances[0]))]);
      printKeyValue(pairs);

      if (instances.length) {
        console.log(`\n  Agents\n  ${'─'.repeat(42)}`);
        printTable(['AGENT', 'STATUS', 'TASK', 'DONE', 'FAILED'], instances.map((a) => [
          a.name,
          container.quotaService.groupOf(a) in pauses ? '⏸ paused' : `${statusIcon(a.status)} ${a.status}`,
          a.current_task ?? dim('—'),
          String(a.stats.tasks_completed),
          String(a.stats.tasks_failed),
        ]));
      }
      console.log();
    });

  role
    .command('scale <name> <replicas>')
    .description('Change the number of agents for a role (idle agents are removed first)')
    .action(async (name: string, replicas: string) => {
      const { role: r, sync } = await container.roleService.scale(name, parseReplicas(replicas)!);
      printSuccess(`${r.name} → ${r.replicas} agent(s)`);
      printSync(sync);
    });

  role
    .command('remove <name>')
    .description('Delete a role and its idle agents (busy ones are removed when they finish)')
    .action(async (name: string) => {
      const sync = await container.roleService.remove(name);
      printSuccess(`Removed role ${name}`);
      printSync(sync);
    });

  role
    .command('init <template>')
    .description('Add a team of roles from a template: a built-in one, ~/.orchestry/templates/<name>, or a directory of role .yml files')
    .option('--force', 'Overwrite roles that already exist')
    .action(async (template: string, opts: { force?: boolean }) => {
      const { loadRoleTemplate } = await import('../../infrastructure/storage/role-templates.js');
      const t = await loadRoleTemplate(template);
      const r = await container.roleService.applyTemplate(t.roles, { force: Boolean(opts.force) });
      if (container.context.json) {
        console.log(JSON.stringify({ template: t.name, source: t.source, ...r }, null, 2));
        return;
      }
      printSuccess(`Template ${t.name} (${t.source})`);
      if (r.created.length) console.log(`  Added:       ${r.created.join(', ')}`);
      if (r.overwritten.length) console.log(`  Overwritten: ${r.overwritten.join(', ')}`);
      if (r.skipped.length) console.log(`  Kept (already exist; --force to overwrite): ${r.skipped.join(', ')}`);
      printSync(r.sync);
      console.log(dim('  See them with: orch role list   ·   edit .orchestry/roles/<name>.yml to adjust'));
    });

  role
    .command('templates')
    .description('List role templates (built-in and ~/.orchestry/templates)')
    .action(async () => {
      const { listRoleTemplates, userTemplatesDir } = await import('../../infrastructure/storage/role-templates.js');
      const list = await listRoleTemplates();
      if (container.context.json) {
        console.log(JSON.stringify(list, null, 2));
        return;
      }
      if (list.length) printTable(['TEMPLATE', 'ROLES', 'SOURCE', 'DESCRIPTION'], list.map((t) => [t.name, String(t.roles), t.source, t.description ?? '']));
      else console.log('  No templates.');
      console.log(dim(`\n  Your own: put role .yml files in ${userTemplatesDir()}/<name>/ — or pass a directory: orch role init ./my-team`));
    });

  role
    .command('sync')
    .description('Apply role files to agents now (serve/run also do this every tick)')
    .action(async () => {
      const sync = await container.roleService.sync();
      const changed = sync.created.length + sync.updated.length + sync.removed.length;
      printSuccess(changed ? 'Agents updated from roles' : 'Agents already match roles');
      printSync(sync);
    });
}

/** "review (backend, frontend) · verify (bugs → backend, frontend)" */
function dutyText(r: import('../../domain/role.js').Role): string {
  return (r.duties ?? []).map((d) => (d === 'review' && r.reviews?.length ? `review (${r.reviews.join(', ')})`
    : d === 'verify' && r.bug_owners?.length ? `verify (bugs → ${r.bug_owners.join(', ')})` : d)).join(' · ');
}
