/**
 * Configuration domain model.
 *
 * Represents the structure of .orchestry/config.yml
 */

import type { ApprovalPolicy } from './agent.js';
import type { ReviewCriterion, WorkspaceMode } from './task.js';

export interface ProjectConfig {
  name: string;
  description?: string;
}

export interface AgentDefaults {
  adapter: string;
  approval_policy: ApprovalPolicy;
  max_turns: number;
  timeout_ms: number;
  stall_timeout_ms: number;
  workspace_mode: WorkspaceMode;
}

export interface TaskDefaults {
  max_attempts: number;
  priority: number;
}

export interface SchedulingConfig {
  poll_interval_ms: number;
  max_concurrent_agents: number;
  retry_base_delay_ms: number;
  retry_max_delay_ms: number;
}

/**
 * A shell command, either the same on every platform or per platform.
 * Platform keys match `process.platform`; `default` is used when no key matches.
 *
 *   test_pass: "./mvnw -q test"
 *   test_pass: { default: "./mvnw -q test", win32: "mvnw.cmd -q test" }
 */
export type PlatformCommand =
  | string
  | { default?: string; win32?: string; darwin?: string; linux?: string };

export interface ReviewConfig {
  /** Per-criterion timeout. */
  timeout_ms: number;
  /**
   * How many tasks may run their review commands at the same time (default 1).
   * Parallel `mvn test` runs compete for CPU, fixed ports, test databases and ~/.m2.
   */
  max_parallel?: number;
  /** Overrides for the built-in criterion commands (npm test / npx tsc --noEmit / npm run lint). */
  commands: Partial<Record<ReviewCriterion, PlatformCommand>>;
}

export interface OrchestratorConfig {
  project: ProjectConfig;
  defaults: {
    agent: AgentDefaults;
    task: TaskDefaults;
  };
  scheduling: SchedulingConfig;
  /** Auto-review (review_criteria) settings. Optional for configs written before it existed. */
  review?: ReviewConfig;
  prompt?: {
    template?: string;
    system_template?: string;
    user_template?: string;
  };
}

export const DEFAULT_CONFIG: OrchestratorConfig = {
  project: {
    name: 'my-project',
  },
  defaults: {
    agent: {
      adapter: 'claude',
      approval_policy: 'auto',
      max_turns: 50,
      timeout_ms: 3_600_000,
      stall_timeout_ms: 600_000,
      workspace_mode: 'worktree',
    },
    task: {
      max_attempts: 3,
      priority: 3,
    },
  },
  scheduling: {
    poll_interval_ms: 10_000,
    max_concurrent_agents: 6,
    retry_base_delay_ms: 10_000,
    retry_max_delay_ms: 300_000,
  },
  review: {
    timeout_ms: 600_000,
    max_parallel: 1,
    commands: {},
  },
};
