/**
 * `orch task` command group.
 *
 * Subcommands: add, list, show, edit, assign, cancel, retry
 */

import type { Command } from 'commander';
import type { LightContainer } from '../../container.js';
import { WorkspaceError } from '../../domain/errors.js';
import {
  statusIcon,
  priorityLabel,
  printError,
  printSuccess,
  printTable,
  printKeyValue,
  formatDurationSince,
  formatTokens,
  filePath,
  dim,
  agentName,
  amber,
} from '../output.js';
// editor.ts loaded lazily — only needed for task add --edit and task edit

export function registerTaskCommand(program: Command, container: LightContainer): void {
  const task = program
    .command('task')
    .description('Manage tasks');

  // task add
  task
    .command('add <title>')
    .description('Create a new task')
    .option('-d, --description <desc>', 'Task description')
    .option('-p, --priority <n>', 'Priority (1-4)', '3')
    .option('-l, --labels <labels>', 'Comma-separated labels')
    .option('--depends-on <ids>', 'Comma-separated dependency task IDs')
    .option('--max-attempts <n>', 'Max retry attempts')
    .option('--workspace-mode <mode>', 'Workspace mode: shared|worktree|isolated')
    .option('--role <role>', 'Role that should do it — any idle instance of the role may take it')
    .option('--assignee <agent-id>', 'Assign to a specific agent')
    .option('--review-criteria <criteria>', 'Comma-separated auto-review criteria: test_pass,typecheck,lint')
    .option('--scope <patterns>', 'Comma-separated glob patterns for file scope (e.g. src/auth/**,src/session/**)')
    .option('--goal-id <goalId>', 'Associate task with a goal')
    .option('--attach <paths>', 'Comma-separated file paths to attach (screenshots, docs)')
    .option('--needs-decision [question]', 'Gate: a human must approve (orch decision answer) before it starts')
    .option('-e, --edit', 'Open $EDITOR to write the description')
    .action(async (title: string, opts) => {
      let description = opts.description;
      if (opts.edit) {
        const { openInEditor, toEditorContent, fromEditorContent } = await import('../editor.js');
        const content = await openInEditor(
          toEditorContent({ title, priority: parseInt(opts.priority, 10), description }),
        );
        const parsed = fromEditorContent(content);
        description = parsed.description;
      }

      const task = await container.taskService.create({
        title,
        description,
        priority: parseInt(opts.priority, 10),
        labels: opts.labels?.split(',').map((s: string) => s.trim()),
        depends_on: opts.dependsOn?.split(',').map((s: string) => s.trim()),
        max_attempts: opts.maxAttempts ? parseInt(opts.maxAttempts, 10) : undefined,
        workspace_mode: opts.workspaceMode,
        role: opts.role,
        assignee: opts.assignee,
        review_criteria: opts.reviewCriteria?.split(',').map((s: string) => s.trim()),
        scope: opts.scope?.split(',').map((s: string) => s.trim()),
        goalId: opts.goalId,
        attachments: opts.attach?.split(',').map((s: string) => s.trim()),
        needs_decision: Boolean(opts.needsDecision),
      });

      let gate: import('../../domain/decision.js').Decision | undefined;
      if (opts.needsDecision) {
        gate = await container.decisionService.request({
          task_id: task.id,
          source: 'gate',
          question: typeof opts.needsDecision === 'string' ? opts.needsDecision : `Start "${task.title}"?`,
          requested_by: 'human',
        });
      }

      if (container.context.json) {
        console.log(JSON.stringify(task, null, 2));
      } else if (container.context.quiet) {
        console.log(task.id);
      } else {
        printSuccess(`Created ${task.id} "${task.title}"`);
        if (gate) console.log(`  Waits for decision ${gate.id} — start it with: orch decision answer ${gate.id} -m "go"`);
      }
    });

  // task list
  task
    .command('list')
    .description('List all tasks')
    .option('--status <status>', 'Filter by status')
    .action(async (opts) => {
      const tasks = await container.taskService.list(
        opts.status ? { status: opts.status } : undefined,
      );

      if (container.context.json) {
        console.log(JSON.stringify(tasks, null, 2));
        return;
      }

      if (container.context.quiet) {
        tasks.forEach((t) => console.log(t.id));
        return;
      }

      if (tasks.length === 0) {
        console.log(`\n  No tasks. Create one: ${dim('orch task add "Title"')}\n`);
        return;
      }

      const headers = ['STATUS', 'PRI', 'TASK', 'AGENT', 'TIME'];
      const rows = tasks.map((t) => {
        const time = (t.status === 'in_progress' || t.status === 'done') && t.updated_at
          ? formatDurationSince(t.updated_at)
          : dim('—');

        return [
          `${statusIcon(t.status)} ${t.status}`,
          priorityLabel(t.priority),
          t.title.slice(0, 35),
          t.assignee ? agentName(t.assignee) : dim('—'),
          time,
        ];
      });

      console.log();
      printTable(headers, rows);
      const running = tasks.filter((t) => t.status === 'in_progress').length;
      const review = tasks.filter((t) => t.status === 'review').length;
      const done = tasks.filter((t) => t.status === 'done').length;
      console.log(
        `\n  ${tasks.length} tasks${running ? ` · ${running} running` : ''}${review ? ` · ${review} review` : ''}${done ? ` · ${done} done` : ''}\n`,
      );
    });

  // task show
  task
    .command('show <id>')
    .description('Show task details')
    .action(async (id: string) => {
      const t = await container.taskService.get(id);

      if (container.context.json) {
        console.log(JSON.stringify(t, null, 2));
        return;
      }

      console.log(`\n  ${t.title}`);
      console.log(`  ${'═'.repeat(42)}`);
      console.log();

      const pairs: Array<[string, string]> = [
        ['Status', `${statusIcon(t.status)} ${t.status} · attempt ${t.attempts}/${t.max_attempts}`],
        ['Priority', priorityLabel(t.priority)],
      ];
      if (t.role) pairs.push(['Role', t.role]);
      if (t.assignee) pairs.push(['Agent', agentName(t.assignee)]);
      if (t.labels.length) pairs.push(['Labels', t.labels.join(', ')]);
      if (t.scope?.length) pairs.push(['Scope', t.scope.join(', ')]);
      if (t.workspace_mode) pairs.push(['Workspace', t.workspace_mode]);
      if (t.workspace) pairs.push(['Path', filePath(t.workspace)]);
      if (t.review_criteria?.length) pairs.push(['Review', t.review_criteria.join(', ')]);
      if (t.feedback) pairs.push(['Feedback', t.feedback]);
      pairs.push(['Created', t.created_at]);

      printKeyValue(pairs);

      const decisions = await container.decisionService.list({ taskId: t.id });
      if (decisions.length) {
        const { describeAnswer } = await import('../../domain/decision.js');
        console.log(`\n  Decisions\n  ${'─'.repeat(42)}`);
        for (const d of decisions) {
          console.log(d.status === 'pending'
            ? `  ${amber('pending')}   ${d.id}  ${d.question}`
            : `  ${dim('answered')}  ${d.id}  ${d.question} → ${describeAnswer(d)}`);
        }
      }

      if (t.attachments?.length) {
        console.log(`\n  Attachments (${t.attachments.length})\n  ${'─'.repeat(42)}`);
        for (const a of t.attachments) {
          console.log(`    ${filePath(a)}`);
        }
      }

      if (t.description) {
        console.log(`\n  Description\n  ${'─'.repeat(42)}`);
        for (const line of t.description.split('\n')) {
          console.log(`  ${line}`);
        }
      }

      if (t.proof) {
        console.log(`\n  Result\n  ${'─'.repeat(42)}`);
        if (t.proof.branch) console.log(`  Branch:        ${t.proof.branch}`);
        if (t.proof.pr_url) console.log(`  PR:            ${t.proof.pr_url}`);
        if (t.proof.files_changed.length) {
          console.log(`  Files changed:`);
          for (const f of t.proof.files_changed) {
            console.log(`    • ${f}`);
          }
        }
        if (t.proof.test_results) {
          console.log(`  Test results:`);
          for (const line of t.proof.test_results.split('\n')) {
            console.log(`    ${line}`);
          }
        }
        if (t.proof.agent_summary) {
          console.log(`  Agent summary:`);
          for (const line of t.proof.agent_summary.split('\n')) {
            console.log(`    ${line}`);
          }
        }
      }

      const delivered = await container.deliverableService.get(t.id).catch(() => null);
      if (delivered) {
        console.log(`\n  Delivery report · ${delivered.status === 'done' ? 'done' : amber(delivered.status)} · ${delivered.submitted_by} · ${delivered.submitted_at}\n  ${'─'.repeat(42)}`);
        for (const line of delivered.report.split('\n')) console.log(`  ${line}`);
      }

      if (t.review_results?.length) {
        console.log(`\n  Review Results\n  ${'─'.repeat(42)}`);
        for (const r of t.review_results) {
          const icon = r.passed ? '✓' : '✗';
          console.log(`  ${icon} ${r.criterion}: ${r.passed ? 'passed' : 'failed'}`);
          if (r.output) {
            for (const line of r.output.split('\n')) {
              console.log(`    ${line}`);
            }
          }
        }
      }

      console.log();
    });

  // task edit
  task
    .command('edit <id>')
    .description('Open task in $EDITOR to modify title, priority and description')
    .action(async (id: string) => {
      const existing = await container.taskService.get(id);
      const { openInEditor, toEditorContent, fromEditorContent } = await import('../editor.js');
      const attachmentNote = existing.attachments?.length
        ? `\n# Attachments: ${existing.attachments.join(', ')}`
        : '';
      const initial = toEditorContent({
        title: existing.title,
        priority: existing.priority,
        description: existing.description,
      }) + attachmentNote;

      const content = await openInEditor(initial);
      const parsed = fromEditorContent(content);

      // Only update fields that changed
      const fields: { title?: string; description?: string; priority?: number } = {};
      if (parsed.title && parsed.title !== existing.title) fields.title = parsed.title;
      if (parsed.priority && parsed.priority !== existing.priority) fields.priority = parsed.priority;
      if (parsed.description !== undefined && parsed.description !== existing.description) {
        fields.description = parsed.description ?? '';
      }

      if (Object.keys(fields).length === 0) {
        console.log('  No changes.');
        return;
      }

      const updated = await container.taskService.update(id, fields);
      printSuccess(`Updated ${updated.id} "${updated.title}"`);
    });

  // task assign
  task
    .command('assign <task-id> <agent-id>')
    .description('Assign task to agent')
    .action(async (taskId: string, agentId: string) => {
      const t = await container.taskService.assign(taskId, agentId);
      printSuccess(`Assigned ${t.id} → ${t.assignee ?? agentId}`);
    });

  // task cancel
  task
    .command('cancel <id>')
    .description('Cancel a task')
    .action(async (id: string) => {
      const task = await container.taskService.get(id);

      if (task.status === 'in_progress') {
        // Running task — need orchestrator to kill agent process, clean state, finish run
        const { buildFullContainer } = await import('../../container.js');
        const full = await buildFullContainer(container.context);
        await full.orchestrator.cancelTask(id);
      } else {
        await container.taskService.cancel(id);
      }
      printSuccess(`Cancelled ${id}`);
    });

  // task approve
  task
    .command('approve <id>')
    .description('Approve a task in review: merges the latest main into its worktree branch, re-reviews if main moved, merges it, marks it done')
    .action(async (id: string) => {
      // Integration (git sync, review commands, merge) needs the full container.
      const { buildFullContainer } = await import('../../container.js');
      const full = await buildFullContainer(container.context);
      const outcome = await full.orchestrator.approveTask(id);
      switch (outcome.status) {
        case 'done':
          printSuccess(`Approved ${id} — merged, done`);
          return;
        case 'queued':
          printSuccess(`Approved ${id} — the running orchestrator will sync, verify and merge it`);
          return;
        case 'sent_back':
          printSuccess(outcome.reason === 'conflict'
            ? `Approved ${id}, but merging main into it conflicts (${(outcome.files ?? []).join(', ')}) — sent back to its agent`
            : `Approved ${id}, but review failed after merging main — sent back to its agent`);
          return;
        case 'waiting_decision':
          printSuccess(`Approved ${id}, but it hit the send-back limit — waiting for decision ${outcome.decisionId} (orch decision show ${outcome.decisionId})`);
          return;
        case 'deferred':
          printSuccess(`Approved ${id} — not merged yet (${outcome.detail}); the orchestrator retries it`);
          return;
        case 'review':
          throw new WorkspaceError(
            `Could not merge ${id}: ${outcome.detail}`,
            'The task stays in review and its worktree is kept. Fix it in the worktree (or reject the task), then approve again.',
          );
        default:
          printSuccess(`Approved ${id}`);
      }
    });

  // task reject
  task
    .command('reject <id>')
    .description('Reject a task and send it back for rework')
    .option('-r, --reason <reason>', 'Feedback for the agent explaining what to fix')
    .action(async (id: string, opts) => {
      await container.taskService.reject(id, opts.reason);
      printSuccess(`Rejected ${id} → todo${opts.reason ? ` (reason: ${opts.reason})` : ''}`);
    });

  // task retry
  task
    .command('retry <id>')
    .description('Retry a failed task')
    .action(async (id: string) => {
      await container.taskService.retry(id);
      printSuccess(`Reset ${id} to todo`);
    });

  // task deliver
  task
    .command('deliver [file]')
    .description('Hand in the delivery report of your task (agents: do this before ending your run). "-" reads stdin')
    .requiredOption('-s, --status <status>', 'done | partial | blocked')
    .option('--task <id>', 'Task (default: $ORCH_TASK_ID)')
    .action(async (file: string | undefined, opts) => {
      const { parseDeliveryStatus } = await import('../../domain/deliverable.js');
      const { InvalidArgumentsError } = await import('../../domain/errors.js');
      const taskId: string | undefined = opts.task ?? process.env.ORCH_TASK_ID;
      if (!taskId) throw new InvalidArgumentsError('Which task? Pass --task <id> (agents run with $ORCH_TASK_ID set)');
      const status = parseDeliveryStatus(opts.status);
      const source = file ?? 'report.md';
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      let report: string;
      if (source === '-') {
        report = await readStdin();
      } else {
        try {
          report = await fs.readFile(source, 'utf8');
        } catch {
          throw new InvalidArgumentsError(`Report file not found: ${source}`, 'Write the report (Markdown) to that file first, or pass "-" to read it from stdin');
        }
      }
      const cwd = process.cwd();
      const files = await gitFiles(cwd, ['--cached', '--others', '--exclude-standard']);
      const agent = process.env.ORCH_AGENT_NAME;
      const d = await container.deliverableService.submit({
        taskId, report, status, submittedBy: agent ?? 'human', ...(files ? { files } : {}),
      });

      // The report lives in ORCH, not in the project: remove an untracked report file so it is not committed.
      let removed = false;
      if (source !== '-') {
        const abs = path.resolve(source);
        const rel = path.relative(cwd, abs).replace(/\\/g, '/');
        const tracked = await gitFiles(cwd, ['--cached']);
        if (!rel.startsWith('..') && !path.isAbsolute(rel) && tracked && !tracked.includes(rel)) {
          removed = await fs.rm(abs).then(() => true, () => false);
        }
      }

      if (container.context.json) {
        console.log(JSON.stringify(d, null, 2));
        return;
      }
      printSuccess(`Delivered ${taskId} (${status})${removed ? ` — ${source} removed from the workspace (the report is kept by ORCH)` : ''}`);
      if (agent) console.log(status === 'done' ? '  Now end your run with a short summary.' : '  A human decides how to go on. End your run now with a short summary.');
    });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

/** `git ls-files -z <args>` in `cwd` ('/'-separated paths), or undefined outside a git repository. */
async function gitFiles(cwd: string, args: string[]): Promise<string[] | undefined> {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile('git', ['ls-files', '-z', ...args], { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? undefined : stdout.split('\0').filter(Boolean));
    });
  });
}
