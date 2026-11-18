/**
 * `orch agent` command group.
 *
 * Subcommands: add, list, status, remove, disable, enable, resume
 */

import type { Command } from 'commander';
import type { LightContainer } from '../../container.js';
import { describeQuotaGroup, type QuotaPause } from '../../domain/quota.js';
import {
  statusIcon,
  printSuccess,
  printTable,
  printKeyValue,
  formatTokens,
  dim,
  agentName,
} from '../output.js';
// editor.ts loaded lazily — only needed for agent add --edit and agent edit

export function registerAgentCommand(program: Command, container: LightContainer): void {
  const agent = program
    .command('agent')
    .description('Manage agents');

  // agent add
  agent
    .command('add <name>')
    .description('Add a new agent')
    .requiredOption('--adapter <adapter>', 'Adapter type: claude, opencode, codex, cursor, pi, grok, antigravity, shell')
    .option('--role <role>', 'Agent role description')
    .option('--command <cmd>', 'Shell command (for shell adapter)')
    .option('--model <model>', 'Model name (for AI adapters)')
    .option('--effort <level>', 'Reasoning effort: low, medium, high')
    .option('--max-turns <n>', 'Max turns per run')
    .option('--timeout <ms>', 'Timeout in ms')
    .option('--approval-policy <policy>', 'suggest|auto|manual')
    .option('--workspace-mode <mode>', 'shared|worktree|isolated')
    .option('--skills <skills>', 'Comma-separated list of agent skills')
    .option('-e, --edit', 'Open $EDITOR to write the role description')
    .action(async (name: string, opts) => {
      let role = opts.role;

      if (opts.edit) {
        const { openInEditor, agentToEditorContent, agentFromEditorContent } = await import('../editor.js');
        const initial = agentToEditorContent({ name, command: opts.command, model: opts.model, role });
        const edited = await openInEditor(initial);
        const parsed = agentFromEditorContent(edited);
        if (parsed.name) name = parsed.name;
        if (parsed.command !== undefined) opts.command = parsed.command;
        if (parsed.model) opts.model = parsed.model;
        if (parsed.role) role = parsed.role;
      }

      const a = await container.agentService.create({
        name,
        adapter: opts.adapter,
        role,
        command: opts.command,
        model: opts.model,
        effort: opts.effort,
        max_turns: opts.maxTurns ? parseInt(opts.maxTurns, 10) : undefined,
        timeout_ms: opts.timeout ? parseInt(opts.timeout, 10) : undefined,
        approval_policy: opts.approvalPolicy,
        workspace_mode: opts.workspaceMode,
        skills: opts.skills ? opts.skills.split(',').map((s: string) => s.trim()) : undefined,
      });

      if (container.context.json) {
        console.log(JSON.stringify(a, null, 2));
      } else if (container.context.quiet) {
        console.log(a.id);
      } else {
        printSuccess(`Added agent ${agentName(a.name)} (${a.adapter}) → ${a.id}`);
      }
    });

  // agent shop
  agent
    .command('shop')
    .description('Browse and install pre-built agent templates')
    .option('--list', 'Print all templates (non-interactive)')
    .action(async (opts: { list?: boolean }) => {
      const { AGENT_SHOP_TEMPLATES } = await import('../../domain/agent-shop.js');

      if (opts.list || !process.stdout.isTTY) {
        printTable(
          ['Key', 'Name', 'Tier', 'Skills'],
          AGENT_SHOP_TEMPLATES.map((t) => [t.key, t.name, t.tier, t.skills.slice(0, 2).join(', ')]),
        );
        return;
      }

      const { pickFromShop } = await import('../shop-picker.js');
      const template = await pickFromShop(AGENT_SHOP_TEMPLATES);

      if (!template) {
        console.log('  Cancelled.');
        return;
      }

      const { templateToAgentInput } = await import('../../application/agent-factory.js');
      const defaultAdapter = container.config.defaults.agent.adapter;
      const input = templateToAgentInput(template, defaultAdapter);
      const a = await container.agentService.create(input);

      printSuccess(`Added agent ${agentName(a.name)} (${a.adapter}) → ${a.id}`);
    });

  // agent list
  agent
    .command('list')
    .description('List all agents')
    .action(async () => {
      const agents = await container.agentService.list();

      if (container.context.json) {
        console.log(JSON.stringify(agents, null, 2));
        return;
      }

      if (container.context.quiet) {
        agents.forEach((a) => console.log(a.id));
        return;
      }

      if (agents.length === 0) {
        console.log(`\n  No agents. Add one: ${dim('orch agent add <name> --adapter <adapter>')}\n`);
        return;
      }

      const pauses = await container.quotaService.currentPauses();
      const headers = ['STATUS', 'AGENT', 'ADAPTER', 'TASK', 'TIME'];
      const rows = agents.map((a) => {
        const pause = pauses[container.quotaService.groupOf(a)];
        return [
          pause ? '⏸ paused' : `${statusIcon(a.status)} ${a.status}`,
          agentName(a.name),
          a.adapter,
          a.current_task ?? dim('—'),
          pause ? `until ${formatPauseUntil(pause)}` : dim('—'),
        ];
      });

      console.log();
      printTable(headers, rows);
      const running = agents.filter((a) => a.status === 'running').length;
      console.log(
        `\n  ${agents.length} agents · ${running} running · ${formatTokens(agents.reduce((sum, a) => sum + (a.stats.tokens_used ?? 0), 0))} tokens total\n`,
      );
    });

  // agent status
  agent
    .command('status <id>')
    .description('Show agent details')
    .action(async (id: string) => {
      const a = await container.agentService.get(id);

      if (container.context.json) {
        console.log(JSON.stringify(a, null, 2));
        return;
      }

      console.log(`\n  ${a.name}`);
      console.log(`  ${'═'.repeat(42)}`);
      console.log();

      const pairs: Array<[string, string]> = [
        ['Adapter', `${a.adapter}${a.adapter !== 'shell' && a.config.model ? ` (${a.config.model})` : ''}`],
        ['Status', `${statusIcon(a.status)} ${a.status}`],
        ['Policy', a.config.approval_policy ?? 'auto'],
      ];
      if (a.adapter === 'shell') {
        pairs.splice(1, 0, ['Command', a.config.command ?? '—']);
      } else {
        pairs.splice(2, 0, ['Effort', a.config.effort ?? 'default']);
      }
      if (a.current_task) pairs.push(['Task', a.current_task]);
      if (a.role) pairs.push(['Role', a.role]);
      const group = container.quotaService.groupOf(a);
      const pause = (await container.quotaService.currentPauses())[group];
      pairs.push(['Quota', describeQuotaGroup(group)]);
      if (pause) {
        pairs.push(['Paused', `until ${formatPauseUntil(pause)}${pause.reset_known ? '' : ' (reset time unknown — will probe)'}`]);
        pairs.push(['Reason', pause.reason || '—']);
      }
      if (a.config.skills?.length) pairs.push(['Skills', a.config.skills.join(', ')]);

      printKeyValue(pairs);

      console.log(`\n  Stats\n  ${'─'.repeat(42)}`);
      printKeyValue([
        ['Tasks completed', String(a.stats.tasks_completed)],
        ['Tasks failed', String(a.stats.tasks_failed)],
        ['Total runs', String(a.stats.total_runs)],
        ['Tokens used', formatTokens(a.stats.tokens_used ?? 0)],
      ]);

      console.log();
    });

  // agent edit
  agent
    .command('edit <id>')
    .description('Edit an agent in $EDITOR')
    .action(async (id: string) => {
      const a = await container.agentService.get(id);
      const { openInEditor, agentToEditorContent, agentFromEditorContent } = await import('../editor.js');
      const initial = agentToEditorContent({
        name: a.name,
        command: a.config.command,
        model: a.config.model,
        role: a.role,
      });

      const edited = await openInEditor(initial);
      const parsed = agentFromEditorContent(edited);

      const updated = await container.agentService.update(id, {
        name: parsed.name,
        role: parsed.role,
        command: parsed.command,
        model: parsed.model,
      });

      if (container.context.json) {
        console.log(JSON.stringify(updated, null, 2));
      } else if (container.context.quiet) {
        console.log(updated.id);
      } else {
        printSuccess(`Updated agent ${agentName(updated.name)} (${updated.id})`);
      }
    });

  // agent remove
  agent
    .command('remove <id>')
    .description('Remove an agent')
    .action(async (id: string) => {
      await container.agentService.remove(id);
      printSuccess(`Removed agent ${id}`);
    });

  // agent disable
  agent
    .command('disable <id>')
    .description('Disable an agent')
    .action(async (id: string) => {
      await container.agentService.disable(id);
      printSuccess(`Disabled agent ${id}`);
    });

  // agent enable
  agent
    .command('enable <id>')
    .description('Enable an agent')
    .action(async (id: string) => {
      await container.agentService.enable(id);
      printSuccess(`Enabled agent ${id}`);
    });

  // agent resume
  agent
    .command('resume <id-or-group>')
    .description('Resume an agent paused by a usage limit (resumes every agent on the same account)')
    .action(async (target: string) => {
      const found = await container.agentService.get(target).catch(() => null);
      const group = await container.quotaService.resume(found ?? target);
      if (!group) {
        console.log(`  ${dim('Not paused:')} ${found ? describeQuotaGroup(container.quotaService.groupOf(found)) : target}`);
        return;
      }
      printSuccess(`Resumed ${describeQuotaGroup(group)} — its agents will be dispatched on the next tick`);
    });

  // agent autonomous
  agent
    .command('autonomous <id>')
    .description('Toggle autonomous mode for an agent')
    .option('--on', 'Enable autonomous mode')
    .option('--off', 'Disable autonomous mode')
    .action(async (id: string, opts: { on?: boolean; off?: boolean }) => {
      const current = await container.agentService.get(id);
      const enable = opts.on ? true : opts.off ? false : !current.autonomous;
      const a = await container.agentService.setAutonomous(id, enable);

      if (container.context.json) {
        console.log(JSON.stringify(a, null, 2));
      } else if (container.context.quiet) {
        console.log(a.id);
      } else {
        printSuccess(`Autonomous mode ${enable ? 'enabled' : 'disabled'} for agent ${agentName(a.name)} (${a.id})`);
      }
    });
}

/** Local time a pause ends, with the date when it is not today. */
function formatPauseUntil(pause: QuotaPause): string {
  const until = new Date(pause.until);
  const time = until.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return until.toDateString() === new Date().toDateString() ? time : `${until.toLocaleDateString()} ${time}`;
}
