/**
 * ReviewRunner — automatic review of completed tasks.
 *
 * Executes review criteria (test_pass, typecheck, lint) as shell commands
 * and returns pass/fail results. The commands come from `review.commands`
 * in .orchestry/config.yml (optionally per platform) and default to the
 * npm/TypeScript commands below, so e.g. a Maven project can configure
 * `test_pass: ./mvnw -q test`.
 *
 * Staged evaluation: criteria are sorted by speed (typecheck → lint → test)
 * and execution stops on first failure (fail-fast) to save compute.
 */

import type { PlatformCommand, ReviewConfig } from '../domain/config.js';
import type { ReviewCriterion, ReviewResult } from '../domain/task.js';
import type { IShellRunner } from '../infrastructure/process/shell-runner.js';

/** Built-in commands, used when config.yml does not override a criterion. */
export const DEFAULT_REVIEW_COMMANDS: Readonly<Record<ReviewCriterion, string>> = {
  test_pass: 'npm test',
  typecheck: 'npx tsc --noEmit',
  lint: 'npm run lint',
};

export const DEFAULT_REVIEW_TIMEOUT_MS = 600_000;

/** Execution order: fastest checks first. */
const CRITERION_ORDER: readonly ReviewCriterion[] = ['typecheck', 'lint', 'test_pass'];

/** Characters of output kept per result (tail — build tools print the failure summary last). */
const RESULT_OUTPUT_CHARS = 2000;

export interface ReviewRunnerOptions {
  cwd: string;
  shell: IShellRunner;
  /** `review` section of the project config. */
  review?: Partial<ReviewConfig>;
  /** Override for tests; defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** When true, stop on first failed criterion (default: true). */
  fail_fast?: boolean;
}

/**
 * Pick the command for a criterion: config override (platform key, then `default`),
 * else the built-in default. Blank or non-string values fall back to the default.
 */
export function resolveReviewCommand(
  criterion: ReviewCriterion,
  commands: Partial<Record<ReviewCriterion, PlatformCommand>> | undefined,
  platform: NodeJS.Platform,
): string {
  const configured = commands?.[criterion];
  let candidate: unknown;
  if (typeof configured === 'string') {
    candidate = configured;
  } else if (configured && typeof configured === 'object') {
    const byPlatform = configured as Record<string, unknown>;
    candidate = typeof byPlatform[platform] === 'string' && (byPlatform[platform] as string).trim()
      ? byPlatform[platform]
      : byPlatform['default'];
  }
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : DEFAULT_REVIEW_COMMANDS[criterion];
}

export class ReviewRunner {
  private readonly cwd: string;
  private readonly shell: IShellRunner;
  private readonly commands: ReviewConfig['commands'] | undefined;
  private readonly timeoutMs: number;
  private readonly platform: NodeJS.Platform;
  private readonly failFast: boolean;

  constructor(options: ReviewRunnerOptions) {
    this.cwd = options.cwd;
    this.shell = options.shell;
    this.commands = options.review?.commands;
    const timeout = options.review?.timeout_ms;
    this.timeoutMs = typeof timeout === 'number' && timeout > 0 ? timeout : DEFAULT_REVIEW_TIMEOUT_MS;
    this.platform = options.platform ?? process.platform;
    this.failFast = options.fail_fast ?? true;
  }

  /**
   * Run criteria in staged order (typecheck → lint → test).
   * In fail-fast mode (default), stops on first failure.
   */
  async runAll(criteria: ReviewCriterion[]): Promise<ReviewResult[]> {
    const sorted = sortCriteria(criteria);
    const results: ReviewResult[] = [];

    for (const criterion of sorted) {
      const result = await this.runCriterion(criterion);
      results.push(result);
      if (this.failFast && !result.passed) break;
    }

    return results;
  }

  /**
   * Check if all results passed.
   */
  static allPassed(results: ReviewResult[]): boolean {
    return results.length > 0 && results.every((r) => r.passed);
  }

  /**
   * Format results into a human-readable report.
   */
  static formatReport(results: ReviewResult[]): string {
    const lines = results.map((r) => {
      const icon = r.passed ? '✓' : '✗';
      return `${icon} ${r.criterion}: ${r.passed ? 'PASSED' : 'FAILED'}\n  ${r.output}`;
    });
    return lines.join('\n\n');
  }

  private async runCriterion(criterion: ReviewCriterion): Promise<ReviewResult> {
    const command = resolveReviewCommand(criterion, this.commands, this.platform);
    const { exitCode, output, timedOut } = await this.shell.run(command, {
      cwd: this.cwd,
      timeoutMs: this.timeoutMs,
    });

    const status = timedOut
      ? `timed out after ${Math.round(this.timeoutMs / 1000)}s`
      : exitCode === null ? 'failed to run' : `exit ${exitCode}`;
    const header = `$ ${command}  (${status})`;
    const body = output.length > RESULT_OUTPUT_CHARS ? `…${output.slice(-RESULT_OUTPUT_CHARS)}` : output;

    return {
      criterion,
      passed: !timedOut && exitCode === 0,
      output: body ? `${header}\n${body}` : header,
    };
  }
}

/** Sort criteria by CRITERION_ORDER (fastest first). */
function sortCriteria(criteria: ReviewCriterion[]): ReviewCriterion[] {
  return [...criteria].sort((a, b) => {
    const ai = CRITERION_ORDER.indexOf(a);
    const bi = CRITERION_ORDER.indexOf(b);
    return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi);
  });
}
