/**
 * `orch review` — reviews by a reviewer role (a role with the review duty).
 *
 *   orch review submit [review.yml]   the reviewer hands in its findings ($ORCH_TASK_ID = its review task)
 *   orch review show <task>           findings and rounds of a reviewed task
 */

import type { Command } from 'commander';
import type { LightContainer } from '../../container.js';
import { InvalidArgumentsError } from '../../domain/errors.js';
import { describeFinding, MAX_REVIEW_ROUNDS } from '../../domain/review.js';
import { printSuccess, printKeyValue, printWarning, dim, amber } from '../output.js';

export function registerReviewCommand(program: Command, container: LightContainer): void {
  const review = program
    .command('review')
    .description('Reviews by a reviewer role: submit findings, show a review');

  review
    .command('submit [file]')
    .description('Submit the findings of your review task (reviewers: then end your run)')
    .option('--task <id>', 'Review task (default: $ORCH_TASK_ID)')
    .action(async (file: string | undefined, opts: { task?: string }) => {
      const reviewTaskId = opts.task ?? process.env.ORCH_TASK_ID;
      if (!reviewTaskId) throw new InvalidArgumentsError('Which review task? Pass --task <id> (reviewers run with $ORCH_TASK_ID set)');
      const fs = await import('node:fs/promises');
      const yaml = (await import('js-yaml')).default;
      const source = file ?? 'review.yml';
      let text: string;
      try {
        text = await fs.readFile(source, 'utf8');
      } catch {
        throw new InvalidArgumentsError(`Review file not found: ${source}`, 'Write your findings (YAML) to that file first');
      }
      let raw: unknown;
      try {
        raw = yaml.load(text) ?? {};
      } catch (err) {
        throw new InvalidArgumentsError(`${source} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
      }
      const r = await container.reviewService.submit({ reviewTaskId, raw, by: process.env.ORCH_AGENT_NAME ?? 'human' });
      if (container.context.json) {
        console.log(JSON.stringify(r, null, 2));
        return;
      }
      for (const n of r.notes) printWarning(n);
      if (r.verdict === 'passed') printSuccess(`Review passed: ${r.task.id} "${r.task.title}"${r.findings.length ? ` (${r.findings.length} non-blocking finding(s) recorded)` : ''}`);
      else if (r.escalated) printSuccess(`Findings still open after ${MAX_REVIEW_ROUNDS} rounds — a human decides about ${r.task.id}`);
      else printSuccess(`Sent back to the author with the must-fix findings: ${r.task.id} "${r.task.title}"`);
      if (process.env.ORCH_AGENT_NAME) console.log('  End your run now with a short summary.');
    });

  review
    .command('show <task>')
    .description('Findings and rounds of a reviewed task')
    .action(async (taskId: string) => {
      const task = await container.taskService.get(taskId);
      if (container.context.json) {
        console.log(JSON.stringify(task.review ?? null, null, 2));
        return;
      }
      const r = task.review;
      if (!r) {
        console.log(`  ${task.id} has not been reviewed.`);
        return;
      }
      printKeyValue([
        ['Task', `${task.id} ${task.title}`],
        ['Round', `${r.round} of ${MAX_REVIEW_ROUNDS}`],
        ['Status', r.status === 'passed' ? 'passed' : amber(r.status)],
        ...(r.reviewer ? [['Reviewer', r.reviewer] as [string, string]] : []),
        ...(r.review_task_id ? [['Review task', r.review_task_id] as [string, string]] : []),
      ]);
      if (r.summary) console.log(`\n  ${r.summary}`);
      if (r.findings.length) {
        console.log(`\n  Findings\n  ${'─'.repeat(42)}`);
        for (const f of r.findings) {
          const check = r.checks?.find((c) => c.id === f.id);
          console.log(`  ${describeFinding(f)}${check ? dim(check.fixed ? '  ✓ fixed' : '  ✗ not fixed') : ''}`);
        }
      }
    });
}
