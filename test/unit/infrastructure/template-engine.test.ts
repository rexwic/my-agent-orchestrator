import { describe, it, expect, vi } from 'vitest';
import {
  LiquidTemplateEngine,
  buildPromptContext,
  filterRelevantContext,
  DEFAULT_PROMPT_TEMPLATE,
  DEFAULT_SYSTEM_TEMPLATE,
  DEFAULT_USER_TEMPLATE,
  type RetryContext,
} from '../../../src/infrastructure/template/template-engine.js';
import type { Task } from '../../../src/domain/task.js';
import type { Agent } from '../../../src/domain/agent.js';
import { DEFAULT_CONFIG } from '../../../src/domain/config.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'tsk_test1',
    title: 'Test task',
    description: 'Do something',
    status: 'todo',
    priority: 3,
    labels: [],
    depends_on: [],
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    attempts: 0,
    max_attempts: 3,
    ...overrides,
  };
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agt_test1',
    name: 'test-agent',
    adapter: 'claude',
    config: {
      approval_policy: 'suggest',
      max_turns: 50,
      timeout_ms: 3600000,
      stall_timeout_ms: 300000,
    },
    status: 'idle',
    stats: {
      tasks_completed: 0,
      tasks_failed: 0,
      total_runs: 0,
      total_runtime_ms: 0,
    },
    ...overrides,
  };
}

describe('buildPromptContext', () => {
  it('should not include retry context on first attempt', () => {
    const ctx = buildPromptContext(
      makeTask(),
      makeAgent(),
      1,
      '/workspace',
      DEFAULT_CONFIG,
    );

    expect(ctx.attempt).toBeNull();
    expect(ctx.retry).toBeUndefined();
  });

  it('should include retry context on attempt > 1 when retryContext provided', () => {
    const retryContext: RetryContext = {
      previous_error: 'Process crashed',
      previous_output: 'some output\nmore output',
    };

    const ctx = buildPromptContext(
      makeTask(),
      makeAgent(),
      2,
      '/workspace',
      DEFAULT_CONFIG,
      { allAgents: [], retryContext },
    );

    expect(ctx.attempt).toBe(2);
    expect(ctx.retry).toEqual(retryContext);
  });

  it('should not include retry context on attempt > 1 when retryContext is undefined', () => {
    const ctx = buildPromptContext(
      makeTask(),
      makeAgent(),
      2,
      '/workspace',
      DEFAULT_CONFIG,
      { allAgents: [] },
    );

    expect(ctx.attempt).toBe(2);
    expect(ctx.retry).toBeUndefined();
  });

  it('should ignore retryContext on first attempt even if provided', () => {
    const retryContext: RetryContext = {
      previous_error: 'Some error',
      previous_output: 'output',
    };

    const ctx = buildPromptContext(
      makeTask(),
      makeAgent(),
      1,
      '/workspace',
      DEFAULT_CONFIG,
      { allAgents: [], retryContext },
    );

    expect(ctx.attempt).toBeNull();
    expect(ctx.retry).toBeUndefined();
  });
});

describe('buildPromptContext team listing', () => {
  const multilineRole = 'Senior Backend Developer\n## WORKFLOW\n1) Step one\n2) Step two\n## RULES\n- Rule A\n- Rule B';
  const longFirstLine = 'A'.repeat(100);

  it('passes full role for other agents', () => {
    const current = makeAgent({ id: 'agt_me', name: 'Me', role: 'My full role' });
    const other = makeAgent({ id: 'agt_other', name: 'Other', role: multilineRole });

    const ctx = buildPromptContext(
      makeTask(),
      current,
      1,
      '/workspace',
      DEFAULT_CONFIG,
      { allAgents: [current, other] },
    );

    const otherInCtx = ctx.agents.find((a) => a.id === 'agt_other')!;
    expect(otherInCtx.role).toBe(multilineRole);
  });

  it('passes long role without truncation', () => {
    const other = makeAgent({ id: 'agt_long', name: 'Long', role: longFirstLine });
    const current = makeAgent({ id: 'agt_me', name: 'Me' });

    const ctx = buildPromptContext(
      makeTask(),
      current,
      1,
      '/workspace',
      DEFAULT_CONFIG,
      { allAgents: [current, other] },
    );

    const longInCtx = ctx.agents.find((a) => a.id === 'agt_long')!;
    expect(longInCtx.role).toBe(longFirstLine);
  });

  it('excludes current agent role from team listing', () => {
    const current = makeAgent({ id: 'agt_me', name: 'Me', role: multilineRole });

    const ctx = buildPromptContext(
      makeTask(),
      current,
      1,
      '/workspace',
      DEFAULT_CONFIG,
      { allAgents: [current] },
    );

    const meInCtx = ctx.agents.find((a) => a.id === 'agt_me')!;
    expect(meInCtx.role).toBeUndefined();
  });

  it('preserves undefined role', () => {
    const other = makeAgent({ id: 'agt_norole', name: 'NoRole', role: undefined });
    const current = makeAgent({ id: 'agt_me', name: 'Me' });

    const ctx = buildPromptContext(
      makeTask(),
      current,
      1,
      '/workspace',
      DEFAULT_CONFIG,
      { allAgents: [current, other] },
    );

    const noRoleInCtx = ctx.agents.find((a) => a.id === 'agt_norole')!;
    expect(noRoleInCtx.role).toBeUndefined();
  });

  it('keeps short single-line role as-is', () => {
    const other = makeAgent({ id: 'agt_short', name: 'Short', role: 'QA Engineer' });
    const current = makeAgent({ id: 'agt_me', name: 'Me' });

    const ctx = buildPromptContext(
      makeTask(),
      current,
      1,
      '/workspace',
      DEFAULT_CONFIG,
      { allAgents: [current, other] },
    );

    const shortInCtx = ctx.agents.find((a) => a.id === 'agt_short')!;
    expect(shortInCtx.role).toBe('QA Engineer');
  });
});

describe('LiquidTemplateEngine timeout', () => {
  it('renders normally within timeout', async () => {
    const engine = new LiquidTemplateEngine({ renderTimeoutMs: 5000 });
    const ctx = buildPromptContext(
      makeTask(),
      makeAgent(),
      1,
      '/workspace',
      DEFAULT_CONFIG,
    );
    const result = await engine.render('Hello {{ agent.name }}', ctx);
    expect(result).toBe('Hello test-agent');
  });

  it('accepts default constructor (no options)', () => {
    const engine = new LiquidTemplateEngine();
    expect(engine).toBeDefined();
  });

  it('disables timeout when renderTimeoutMs is 0', async () => {
    const engine = new LiquidTemplateEngine({ renderTimeoutMs: 0 });
    const ctx = buildPromptContext(
      makeTask(),
      makeAgent(),
      1,
      '/workspace',
      DEFAULT_CONFIG,
    );
    const result = await engine.render('Hello {{ agent.name }}', ctx);
    expect(result).toBe('Hello test-agent');
  });
});

describe('LiquidTemplateEngine with retry context', () => {
  const engine = new LiquidTemplateEngine();

  it('should render retry section when retry context is present', async () => {
    const ctx = buildPromptContext(
      makeTask(),
      makeAgent({ name: 'Backend A', role: 'developer' }),
      2,
      '/workspace',
      DEFAULT_CONFIG,
      {
        allAgents: [],
        retryContext: {
          previous_error: 'npm test failed with exit code 1',
          previous_output: 'FAIL src/app.test.ts\nError: assertion failed',
        },
      },
    );

    const result = await engine.render(DEFAULT_PROMPT_TEMPLATE, ctx);

    expect(result).toContain('Previous attempt failed');
    expect(result).toContain('npm test failed with exit code 1');
    expect(result).toContain('FAIL src/app.test.ts');
    expect(result).toContain('Do NOT repeat the same steps');
    expect(result).toContain('Attempt: 2');
  });

  it('should not render retry section on first attempt', async () => {
    const ctx = buildPromptContext(
      makeTask(),
      makeAgent({ name: 'Backend A' }),
      1,
      '/workspace',
      DEFAULT_CONFIG,
    );

    const result = await engine.render(DEFAULT_PROMPT_TEMPLATE, ctx);

    expect(result).not.toContain('Previous attempt failed');
    expect(result).not.toContain('previous_error');
  });

  it('should render retry section without output when output is empty', async () => {
    const ctx = buildPromptContext(
      makeTask(),
      makeAgent({ name: 'Backend A' }),
      3,
      '/workspace',
      DEFAULT_CONFIG,
      {
        allAgents: [],
        retryContext: {
          previous_error: 'Agent stalled',
          previous_output: '',
        },
      },
    );

    const result = await engine.render(DEFAULT_PROMPT_TEMPLATE, ctx);

    expect(result).toContain('Previous attempt failed');
    expect(result).toContain('Agent stalled');
    expect(result).toContain('Attempt: 3');
    // Empty output should not render "Last output" block
    expect(result).not.toContain('Last output');
  });
});

describe('filterRelevantContext', () => {
  it('returns empty object for empty context', () => {
    const result = filterRelevantContext({}, { agentName: 'Backend A' });
    expect(result).toEqual({});
  });

  it('prioritizes goal_id prefix match', () => {
    const ctx: Record<string, string> = {
      'goal_abc-progress': 'done 3/5 tasks',
      'unrelated-key': 'some value',
      'other-goal-key': 'other value',
    };
    const result = filterRelevantContext(ctx, { agentName: 'Backend A', goalId: 'goal_abc' });
    const keys = Object.keys(result);
    expect(keys[0]).toBe('goal_abc-progress');
  });

  it('prioritizes agent name match in key', () => {
    const ctx: Record<string, string> = {
      'backend-a-status': 'ready',
      'qa-status': 'waiting',
    };
    const result = filterRelevantContext(ctx, { agentName: 'Backend A' });
    const keys = Object.keys(result);
    // backend a matches agent name, should be first
    expect(keys[0]).toBe('backend-a-status');
  });

  it('matches agent name in value', () => {
    const ctx: Record<string, string> = {
      'some-result': 'Backend A completed the fix',
      'other-result': 'QA passed all tests',
    };
    const result = filterRelevantContext(ctx, { agentName: 'Backend A' });
    const keys = Object.keys(result);
    expect(keys[0]).toBe('some-result');
  });

  it('matches scope paths', () => {
    const ctx: Record<string, string> = {
      'tui-fix': 'fixed TUI rendering',
      'api-refactor': 'refactored src/api endpoints',
    };
    const result = filterRelevantContext(ctx, {
      agentName: 'Backend A',
      taskScope: ['src/api/**'],
    });
    const keys = Object.keys(result);
    expect(keys[0]).toBe('api-refactor');
  });

  it('matches role-prefix keywords', () => {
    const ctx: Record<string, string> = {
      'backend-dedup-done': 'dedup completed',
      'frontend-fix': 'UI fix applied',
      'qa-result': 'tests passed',
    };
    const result = filterRelevantContext(ctx, { agentName: 'Backend A' });
    const keys = Object.keys(result);
    expect(keys[0]).toBe('backend-dedup-done');
  });

  it('limits to MAX_CONTEXT_ENTRIES (15)', () => {
    const ctx: Record<string, string> = {};
    for (let i = 0; i < 30; i++) {
      ctx[`key-${i}`] = `value-${i}`;
    }
    const result = filterRelevantContext(ctx, { agentName: 'Backend A' });
    expect(Object.keys(result).length).toBeLessThanOrEqual(15);
  });

  it('passes long values without truncation', () => {
    const longValue = 'x'.repeat(600);
    const ctx: Record<string, string> = {
      'long-entry': longValue,
    };
    const result = filterRelevantContext(ctx, { agentName: 'Backend A' });
    expect(result['long-entry']).toBe(longValue);
  });

  it('includes zero-score entries when under limit', () => {
    const ctx: Record<string, string> = {
      'random-key-1': 'value1',
      'random-key-2': 'value2',
    };
    const result = filterRelevantContext(ctx, { agentName: 'Backend A' });
    expect(Object.keys(result).length).toBe(2);
  });

  it('front-end agent matches tui- and frontend- prefixes', () => {
    const ctx: Record<string, string> = {
      'tui-fix': 'TUI fix applied',
      'frontend-design': 'new design',
      'backend-status': 'ready',
    };
    const result = filterRelevantContext(ctx, { agentName: 'Front-End' });
    const keys = Object.keys(result);
    // tui- and frontend- should score higher than backend-
    expect(keys.indexOf('tui-fix')).toBeLessThan(keys.indexOf('backend-status'));
    expect(keys.indexOf('frontend-design')).toBeLessThan(keys.indexOf('backend-status'));
  });

  it('buildPromptContext applies filtering to shared_context', () => {
    const ctx: Record<string, string> = {};
    for (let i = 0; i < 30; i++) {
      ctx[`unrelated-${i}`] = 'x'.repeat(600);
    }
    ctx['goal_test-progress'] = 'goal progress';

    const result = buildPromptContext(
      makeTask({ goalId: 'goal_test' }),
      makeAgent({ name: 'Backend A' }),
      1,
      '/workspace',
      DEFAULT_CONFIG,
      { sharedContext: ctx },
    );

    // Should be filtered by relevance (max 15 entries)
    expect(Object.keys(result.shared_context!).length).toBeLessThanOrEqual(15);
    // Goal context should be prioritized
    expect(result.shared_context!['goal_test-progress']).toBe('goal progress');
  });

  it('boosts bug-/perf-/docs- prefix entries slightly', () => {
    const ctx: Record<string, string> = {
      'bug-123': 'critical bug found',
      'perf-baseline': 'CLI 40ms',
      'random-stuff': 'nothing relevant',
    };
    const result = filterRelevantContext(ctx, { agentName: 'Reviewer' });
    const keys = Object.keys(result);
    // bug- and perf- should come before random-stuff
    expect(keys.indexOf('bug-123')).toBeLessThan(keys.indexOf('random-stuff'));
    expect(keys.indexOf('perf-baseline')).toBeLessThan(keys.indexOf('random-stuff'));
  });
});

describe('system/user template split', () => {
  const engine = new LiquidTemplateEngine({ renderTimeoutMs: 5000 });

  const ctx = buildPromptContext(
    makeTask({ title: 'Fix bug', description: 'Fix the login bug', labels: ['auto'] }),
    makeAgent({ name: 'Backend A', role: 'Senior Dev' }),
    1,
    '/workspace',
    DEFAULT_CONFIG,
    { allAgents: [makeAgent({ name: 'Backend A', role: 'Senior Dev' })] },
  );

  it('DEFAULT_PROMPT_TEMPLATE equals system + user concatenation', () => {
    expect(DEFAULT_PROMPT_TEMPLATE).toBe(DEFAULT_SYSTEM_TEMPLATE + '\n' + DEFAULT_USER_TEMPLATE);
  });

  it('system template contains agent identity and CLI reference', async () => {
    const rendered = await engine.render(DEFAULT_SYSTEM_TEMPLATE, ctx);
    expect(rendered).toContain('You are Backend A (Senior Dev)');
    expect(rendered).toContain('orch task add');
    expect(rendered).toContain('orch msg send');
    expect(rendered).toContain('orch context set');
    expect(rendered).toContain('## Rules');
  });

  it('system template does NOT contain task-specific content', async () => {
    const rendered = await engine.render(DEFAULT_SYSTEM_TEMPLATE, ctx);
    expect(rendered).not.toContain('## Task:');
    expect(rendered).not.toContain('Fix bug');
    expect(rendered).not.toContain('## Context');
    expect(rendered).not.toContain('## Team');
  });

  it('user template contains task details and team listing', async () => {
    const rendered = await engine.render(DEFAULT_USER_TEMPLATE, ctx);
    expect(rendered).toContain('## Task: Fix bug');
    expect(rendered).toContain('Fix the login bug');
    expect(rendered).toContain('Priority: 3');
    expect(rendered).toContain('## Team');
    expect(rendered).toContain('Backend A');
  });

  it('user template does NOT contain rules or CLI reference', async () => {
    const rendered = await engine.render(DEFAULT_USER_TEMPLATE, ctx);
    expect(rendered).not.toContain('## Rules');
    expect(rendered).not.toContain('## Orchestrator CLI');
  });

  it('system template includes autonomous mode when task has auto label', async () => {
    const autoCtx = buildPromptContext(
      makeTask({ labels: ['autonomous'], goalId: 'goal_123' }),
      makeAgent(),
      1,
      '/workspace',
      DEFAULT_CONFIG,
    );
    const rendered = await engine.render(DEFAULT_SYSTEM_TEMPLATE, autoCtx);
    expect(rendered).toContain('## Autonomous Goal Mode');
    expect(rendered).toContain('goal_123');
  });

  it('system template omits autonomous mode for regular tasks', async () => {
    const rendered = await engine.render(DEFAULT_SYSTEM_TEMPLATE, ctx);
    expect(rendered).not.toContain('## Autonomous Goal Mode');
  });

  it('user template includes goal context when provided', async () => {
    const goalCtx = buildPromptContext(
      makeTask(),
      makeAgent(),
      1,
      '/workspace',
      DEFAULT_CONFIG,
      {
        goal: {
          id: 'goal_abc',
          title: 'Ship v1',
          description: 'Release version 1.0',
          status: 'active',
          task_names: ['[done] Setup', '[todo] Deploy'],
        },
      },
    );
    const rendered = await engine.render(DEFAULT_USER_TEMPLATE, goalCtx);
    expect(rendered).toContain('## Goal: Ship v1');
    expect(rendered).toContain('Release version 1.0');
  });

  it('user template includes feedback when provided', async () => {
    const fbCtx = buildPromptContext(
      makeTask(),
      makeAgent(),
      1,
      '/workspace',
      DEFAULT_CONFIG,
      { feedback: 'Fix the error handling' },
    );
    const rendered = await engine.render(DEFAULT_USER_TEMPLATE, fbCtx);
    expect(rendered).toContain('## Review Feedback');
    expect(rendered).toContain('Fix the error handling');
  });

  it('user template lists binding decisions and how to request one', async () => {
    const ctx = buildPromptContext(makeTask({ id: 'tsk_dec' }), makeAgent(), 1, '/workspace', DEFAULT_CONFIG, {
      decisions: [
        { question: 'Money type?', answer: 'BigDecimal', project_wide: true },
        { question: 'Page size?', answer: '50', project_wide: false },
      ],
    });
    const rendered = await engine.render(DEFAULT_USER_TEMPLATE, ctx);
    expect(rendered).toContain('## Decisions (binding)');
    expect(rendered).toContain('- Money type? → **BigDecimal** (project-wide)');
    expect(rendered).toMatch(/- Page size\? → \*\*50\*\*\r?\n/);
    expect(rendered).toContain('orch decision request "<question>"');
    expect(rendered).toContain('tsk_dec');
  });

  it('user template gives a planning task its roles, rules, format and the plan sent back', async () => {
    const ctx = buildPromptContext(makeTask({ id: 'tsk_pl' }), makeAgent(), 1, '/workspace', DEFAULT_CONFIG, {
      planning: {
        plan_id: 'pln_1', revision: 2, max_tasks: 12,
        roles: [{ name: 'backend', description: 'Java/Spring', agents: 2 }, { name: 'qa', agents: 1 }],
        previous_plan: 'goal: Old goal',
      },
    });
    const rendered = await engine.render(DEFAULT_USER_TEMPLATE, ctx);
    expect(rendered).toContain('## Your job: plan the work, do not implement it');
    expect(rendered).toContain('- `backend` (2 agents) — Java/Spring');
    expect(rendered).toMatch(/- `qa` \(1 agent\)\r?\n/);
    expect(rendered).toContain('At most 12 tasks');
    expect(rendered).toContain('orch plan submit plan.yml');
    expect(rendered).toContain('API contract');
    expect(rendered).toContain('## Your previous plan (revision 1, sent back)');
    expect(rendered).toContain('goal: Old goal');
  });

  it('user template has no planning section for other tasks', async () => {
    const rendered = await engine.render(DEFAULT_USER_TEMPLATE, buildPromptContext(makeTask(), makeAgent(), 1, '/workspace', DEFAULT_CONFIG));
    expect(rendered).not.toContain('Your job: plan');
  });

  it('user template asks for a delivery report with the required sections and files', async () => {
    const ctx = buildPromptContext(makeTask(), makeAgent(), 1, '/workspace', DEFAULT_CONFIG, {
      delivery: { sections: ['Summary', '證據'], produces: ['docs/api/discount.yaml', 'src/fe/**'] },
    });
    const rendered = await engine.render(DEFAULT_USER_TEMPLATE, ctx);
    expect(rendered).toContain('## Before you finish: delivery report');
    expect(rendered).toMatch(/- `## Summary`\r?\n- `## 證據`/);
    expect(rendered).toContain('This task must produce: `docs/api/discount.yaml`, `src/fe/**`.');
    expect(rendered).toContain('orch task deliver report.md --status <status>');
  });

  it('user template gives a task the PRD it implements', async () => {
    const ctx = buildPromptContext(makeTask(), makeAgent(), 1, '/workspace', DEFAULT_CONFIG, {
      prd: { name: 'discount', version: 3, content: '# Discount\n1. Percent, max 50%', truncated: true },
    });
    const rendered = await engine.render(DEFAULT_USER_TEMPLATE, ctx);
    expect(rendered).toContain('## Product requirements (PRD discount v3)');
    expect(rendered).toContain('1. Percent, max 50%');
    expect(rendered).toContain('orch prd show discount');
    expect(rendered).not.toContain('write the PRD');
  });

  it('user template tells the PM how to draft a PRD (with the current version to update)', async () => {
    const ctx = buildPromptContext(makeTask(), makeAgent(), 1, '/workspace', DEFAULT_CONFIG, {
      prd: { name: 'discount', version: 1, content: '# v1 text', drafting: { next_version: 2 } },
    });
    const rendered = await engine.render(DEFAULT_USER_TEMPLATE, ctx);
    expect(rendered).toContain('## Your job: write the PRD, do not implement it');
    expect(rendered).toContain('named `discount`, version 2');
    expect(rendered).toContain('orch prd add discount -f prd.md');
    expect(rendered).toContain('### Current PRD (discount v1)');
    expect(rendered).not.toContain('## Product requirements (PRD');
  });

  it("user template tells the PM how to answer or escalate a teammate's question", async () => {
    const ctx = buildPromptContext(makeTask(), makeAgent(), 1, '/workspace', DEFAULT_CONFIG, {
      prd: { name: 'discount', version: 2, content: 'x' },
      triage: { decision_id: 'dec_q', question: 'Percent or fixed?', options: ['percent', 'fixed'], asked_by: 'backend-1', asking_task: { id: 'tsk_be', title: 'Discount API' } },
    });
    const rendered = await engine.render(DEFAULT_USER_TEMPLATE, ctx);
    expect(rendered).toContain("## Your job: answer a teammate's question");
    expect(rendered).toContain('backend-1 asked `dec_q` while working on "Discount API" (tsk_be)');
    expect(rendered).toContain('**Options:** 1. percent · 2. fixed');
    expect(rendered).toContain('orch decision answer dec_q -m "<answer>"');
    expect(rendered).toContain('orch prd add discount -f prd.md -m "<what changed, for dec_q>"');
    expect(rendered).toContain('orch decision escalate dec_q');
  });

  it('user template gives the contracts the task follows, as authoritative', async () => {
    const ctx = buildPromptContext(makeTask(), makeAgent(), 1, '/workspace', DEFAULT_CONFIG, {
      contracts: [
        { path: 'docs/api/discount.yaml', content: 'openapi: 3.0.0\npaths: {}', truncated: true },
        { path: 'docs/api/missing.yaml', content: '', missing: true },
      ],
    });
    const rendered = await engine.render(DEFAULT_USER_TEMPLATE, ctx);
    expect(rendered).toContain('## Contracts (authoritative)');
    expect(rendered).toContain('do NOT change them');
    expect(rendered).toMatch(/### `docs\/api\/discount\.yaml`\r?\n~~~~\r?\nopenapi: 3\.0\.0\r?\npaths: \{\}\r?\n~~~~\r?\n\(cut to fit/);
    expect(rendered).toContain('### `docs/api/missing.yaml`\n(not found in your workspace yet');
    const plain = await engine.render(DEFAULT_USER_TEMPLATE, buildPromptContext(makeTask(), makeAgent(), 1, '/workspace', DEFAULT_CONFIG));
    expect(plain).not.toContain('## Contracts');
  });

  it('user template shows what dependencies delivered; no delivery sections without them', async () => {
    const ctx = buildPromptContext(makeTask(), makeAgent(), 1, '/workspace', DEFAULT_CONFIG, {
      upstream: [{ task_id: 'tsk_up', title: 'API contract', status: 'done', report: '#### Summary\nWrote docs/api/discount.yaml' }],
    });
    const rendered = await engine.render(DEFAULT_USER_TEMPLATE, ctx);
    expect(rendered).toContain('## What your dependencies delivered');
    expect(rendered).toContain('### API contract (done)');
    expect(rendered).toContain('Wrote docs/api/discount.yaml');
    expect(rendered).not.toContain('Before you finish');

    const plain = await engine.render(DEFAULT_USER_TEMPLATE, buildPromptContext(makeTask(), makeAgent(), 1, '/workspace', DEFAULT_CONFIG));
    expect(plain).not.toContain('What your dependencies delivered');
  });

  it('user template has no decisions section when there are none', async () => {
    const rendered = await engine.render(DEFAULT_USER_TEMPLATE, buildPromptContext(makeTask(), makeAgent(), 1, '/workspace', DEFAULT_CONFIG));
    expect(rendered).not.toContain('## Decisions (binding)');
    expect(rendered).toContain('## When a human must decide');
  });

  it('user template includes retry context on attempt > 1', async () => {
    const retryCtx = buildPromptContext(
      makeTask(),
      makeAgent(),
      2,
      '/workspace',
      DEFAULT_CONFIG,
      { retryContext: { previous_error: 'timeout', previous_output: 'partial' } },
    );
    const rendered = await engine.render(DEFAULT_USER_TEMPLATE, retryCtx);
    expect(rendered).toContain('## Previous attempt failed');
    expect(rendered).toContain('timeout');
  });
});
