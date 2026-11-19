/**
 * Template engine for prompt construction.
 *
 * Uses LiquidJS for Liquid-compatible templating with
 * task, agent, project, and run context variables.
 */

import type { Liquid } from 'liquidjs';
import type { Agent } from '../../domain/agent.js';
import type { GoalStatus } from '../../domain/goal.js';
import type { OrchestratorConfig } from '../../domain/config.js';
import { AUTONOMOUS_LABEL, type Task } from '../../domain/task.js';

export interface ITemplateEngine {
  render(template: string, context: PromptContext): Promise<string>;
}

export interface AgentInfo {
  id: string;
  name: string;
  role?: string;
  adapter: string;
}

export interface RetryContext {
  previous_error: string;
  previous_output: string;
}

export interface GoalContext {
  id: string;
  title: string;
  description: string;
  status: GoalStatus;
  task_names: string[];
  progress?: string;
}

export interface PromptContext {
  project: {
    name: string;
    description?: string;
  };
  task: {
    id: string;
    title: string;
    description: string;
    priority: number;
    labels: string[];
    scope?: string[];
    is_autonomous: boolean;
    goal_id?: string;
  };
  agent: {
    id: string;
    name: string;
    role?: string;
  };
  agents: AgentInfo[];
  attempt: number | null;
  workspace_path: string;
  retry?: RetryContext;
  feedback?: string;
  /** Decisions a human made that this agent must follow. */
  decisions?: Array<{ question: string; answer: string; project_wide: boolean }>;
  /** Planning task (`orch plan`): roles to plan with, limits, the plan sent back. */
  planning?: {
    plan_id: string;
    revision: number;
    max_tasks: number;
    roles: Array<{ name: string; description?: string; agents: number }>;
    previous_plan?: string;
  };
  /** The delivery report this run must end with. */
  delivery?: { sections: string[]; produces: string[] };
  /** Contract files the task follows (uses), read from its workspace. */
  contracts?: import('../workspace/contract-files.js').ContractFile[];
  /** The PRD the task implements, or drafts (`drafting`). */
  prd?: { name: string; version: number; content?: string; truncated?: boolean; drafting?: { next_version: number } };
  /** PM task: the teammate's question to answer. */
  triage?: { decision_id: string; question: string; options: string[]; context?: string; asked_by: string; asking_task?: { id: string; title: string } };
  /** Reports of the tasks this one depends on. */
  upstream?: Array<{ task_id: string; title: string; status: string; report: string }>;
  shared_context?: Record<string, string>;
  messages?: Array<{
    id: string;
    from: string;
    subject: string;
    body: string;
    sent_at: string;
    reply_to?: string;
  }>;
  goal?: GoalContext;
}

export class LiquidTemplateEngine implements ITemplateEngine {
  private engine: Liquid | undefined;
  private readonly renderTimeoutMs: number;

  constructor(options?: { renderTimeoutMs?: number }) {
    this.renderTimeoutMs = options?.renderTimeoutMs ?? 5_000;
  }

  private async getEngine(): Promise<Liquid> {
    if (!this.engine) {
      const { Liquid } = await import('liquidjs');
      this.engine = new Liquid({
        strictFilters: false,
        strictVariables: false,
      });
    }
    return this.engine;
  }

  async render(template: string, context: PromptContext): Promise<string> {
    const engine = await this.getEngine();
    const renderPromise = engine.parseAndRender(template, context);

    if (this.renderTimeoutMs <= 0) {
      return renderPromise;
    }

    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Template render timed out after ${this.renderTimeoutMs}ms`)),
        this.renderTimeoutMs,
      );
    });

    try {
      return await Promise.race([renderPromise, timeoutPromise]);
    } finally {
      clearTimeout(timer!);
    }
  }
}

/** Max number of context entries injected into a single prompt. */
const MAX_CONTEXT_ENTRIES = 15;

export interface ContextFilterInput {
  agentName: string;
  agentRole?: string;
  goalId?: string;
  taskScope?: string[];
}

/**
 * Score and filter shared context entries by relevance to the current agent/task.
 * Returns at most MAX_CONTEXT_ENTRIES entries, sorted by relevance then freshness.
 */
export function filterRelevantContext(
  allContext: Record<string, string>,
  filter: ContextFilterInput,
): Record<string, string> {
  const entries = Object.entries(allContext);
  if (entries.length === 0) return {};

  const agentLower = filter.agentName.toLowerCase();
  // Derive role keyword(s) from agent name — e.g. "Backend A" → "backend"
  const roleKeywords = extractRoleKeywords(agentLower, filter.agentRole);

  type Scored = { key: string; value: string; score: number };
  const scored: Scored[] = [];

  for (const [key, value] of entries) {
    let score = 0;
    const keyLower = key.toLowerCase();

    // 1. Goal match (highest priority)
    if (filter.goalId && keyLower.startsWith(filter.goalId.toLowerCase())) {
      score += 10;
    }

    // 2. Agent name match — context key or value mentions this agent
    if (keyLower.includes(agentLower) || value.toLowerCase().includes(agentLower)) {
      score += 8;
    }

    // 3. Scope path match — context mentions paths from task scope
    if (filter.taskScope?.length) {
      for (const scopePattern of filter.taskScope) {
        const scopeBase = scopePattern.replace(/\*+/g, '').replace(/\/+$/, '');
        if (scopeBase && (keyLower.includes(scopeBase.toLowerCase()) || value.toLowerCase().includes(scopeBase.toLowerCase()))) {
          score += 6;
          break;
        }
      }
    }

    // 4. Role-prefix match — e.g. "backend-*" keys for backend agents
    for (const kw of roleKeywords) {
      if (keyLower.startsWith(kw + '-') || keyLower.startsWith(kw + '_')) {
        score += 4;
        break;
      }
    }

    // 5. Generic project-wide context (bug-, perf-, stability-, docs-) gets a small boost
    if (/^(bug|perf|stability|docs|arch|spec)-/i.test(key)) {
      score += 1;
    }

    scored.push({ key, value, score });
  }

  // Sort by score desc; entries with score 0 are excluded unless we have fewer than limit
  scored.sort((a, b) => b.score - a.score);

  // Take top entries: all with score > 0, then pad with score-0 up to limit
  const relevant = scored.filter((e) => e.score > 0).slice(0, MAX_CONTEXT_ENTRIES);
  if (relevant.length < MAX_CONTEXT_ENTRIES) {
    const remaining = scored.filter((e) => e.score === 0).slice(0, MAX_CONTEXT_ENTRIES - relevant.length);
    relevant.push(...remaining);
  }

  // Build result — pass values through as-is (no truncation)
  const result: Record<string, string> = {};
  for (const { key, value } of relevant) {
    result[key] = value;
  }
  return result;
}

/**
 * Extract role keywords from agent name and role for prefix matching.
 * "Backend A" → ["backend"], "QA B" → ["qa"], "Front-End" → ["front-end", "frontend", "tui"]
 */
function extractRoleKeywords(agentNameLower: string, role?: string): string[] {
  const keywords: string[] = [];
  // First word of agent name (e.g. "backend", "qa", "reviewer", "cto")
  const firstWord = agentNameLower.split(/[\s_-]/)[0];
  if (firstWord && firstWord.length > 1) {
    keywords.push(firstWord);
  }
  // Special mappings
  if (agentNameLower.includes('front') || agentNameLower.includes('tui')) {
    keywords.push('front-end', 'frontend', 'tui');
  }
  if (agentNameLower.includes('market') || agentNameLower.includes('cmo')) {
    keywords.push('marketer', 'marketing', 'cmo');
  }
  // Extract from role first line
  if (role) {
    const roleFirstWord = role.toLowerCase().split(/[\s_-]/)[0];
    if (roleFirstWord && roleFirstWord.length > 2 && !keywords.includes(roleFirstWord)) {
      keywords.push(roleFirstWord);
    }
  }
  return keywords;
}

/**
 * Build prompt context from domain objects.
 */
export interface BuildPromptOptions {
  allAgents?: Agent[];
  retryContext?: RetryContext;
  sharedContext?: Record<string, string>;
  feedback?: string;
  messages?: import('../../domain/message.js').Message[];
  goal?: GoalContext;
  decisions?: PromptContext['decisions'];
  planning?: PromptContext['planning'];
  delivery?: PromptContext['delivery'];
  upstream?: PromptContext['upstream'];
  contracts?: PromptContext['contracts'];
  prd?: PromptContext['prd'];
  triage?: PromptContext['triage'];
}

export function buildPromptContext(
  task: Task,
  agent: Agent,
  attempt: number,
  workspacePath: string,
  config: OrchestratorConfig,
  options?: BuildPromptOptions,
): PromptContext {
  const { allAgents, retryContext, sharedContext, feedback, messages: rawMessages, goal, decisions, planning, delivery, upstream, contracts, prd, triage } = options ?? {};

  // Map messages to prompt-friendly shape
  const agentById = new Map((allAgents ?? []).map((a) => [a.id, a]));
  const messages = rawMessages?.length
    ? rawMessages.map((m) => ({
        id: m.id,
        from: agentById.get(m.from_agent_id)?.name ?? m.from_agent_id,
        subject: m.subject,
        body: m.body,
        sent_at: m.created_at,
        reply_to: m.reply_to,
      }))
    : undefined;

  return {
    project: {
      name: config.project.name,
      description: config.project.description,
    },
    task: {
      id: task.id,
      title: task.title,
      description: task.description,
      priority: task.priority,
      labels: task.labels,
      scope: task.scope,
      is_autonomous: task.labels?.includes(AUTONOMOUS_LABEL) ?? false,
      goal_id: task.goalId,
    },
    agent: {
      id: agent.id,
      name: agent.name,
      role: agent.role,
    },
    agents: (allAgents ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      role: a.id === agent.id ? undefined : a.role,
      adapter: a.adapter,
    })),
    attempt: attempt > 1 ? attempt : null,
    workspace_path: workspacePath,
    retry: attempt > 1 ? retryContext : undefined,
    feedback,
    decisions: decisions?.length ? decisions : undefined,
    planning,
    delivery,
    upstream: upstream?.length ? upstream : undefined,
    contracts: contracts?.length ? contracts : undefined,
    prd,
    triage,
    shared_context: sharedContext && Object.keys(sharedContext).length > 0
      ? filterRelevantContext(sharedContext, {
          agentName: agent.name,
          agentRole: agent.role,
          goalId: task.goalId,
          taskScope: task.scope,
        })
      : undefined,
    messages,
    goal,
  };
}

/**
 * Static system prompt template — cached by Claude API between runs.
 * Contains: agent identity, CLI reference, autonomous mode, rules.
 * Variables used: agent.name, agent.role, agent.id, task.is_autonomous, task.goal_id.
 */
export const DEFAULT_SYSTEM_TEMPLATE = `You are {{ agent.name }}{% if agent.role %} ({{ agent.role }}){% endif %}.

## Orchestrator CLI
Manage tasks and coordinate with other agents using \`orch\`:

**Tasks:**
- \`orch task add "<title>" -d "<description>" -p <1-4> --assignee <agent-id>\` — create and assign a task
- \`orch task add "<title>" -d "<description>" --scope "src/path/**" --depends-on <task-id>\` — scoped task with dependency
- \`orch task list [--status todo|in_progress|done|failed]\` — list tasks

**Messaging:**
- \`orch msg send <agent-id> "<body>" -s "<subject>"\` — direct message
- \`orch msg broadcast "<body>" -s "<subject>"\` — broadcast to all
- \`orch msg inbox {{ agent.id }}\` — your pending messages

**Shared context:**
- \`orch context set <key> <value>\` / \`orch context get <key>\` / \`orch context list\`

{% if task.is_autonomous %}
## Autonomous Goal Mode
This is an autonomous task driven by a goal. Work in a continuous loop until the goal is achieved:

1. **Understand the goal** — read the Goal section above.
2. **Decompose** — break the goal into concrete subtasks via \`orch task add\`. {% if task.goal_id %}Pass \`--goal-id {{ task.goal_id }}\` so subtasks are linked to this goal. {% endif %}Assign yourself for your specialty, delegate other work to appropriate teammates by role.
3. **Execute** — follow your standard workflow for each subtask.
4. **Track progress** — after each iteration: \`orch context set {{ task.goal_id | default: "<goal>" }}-progress "<summary of what's done and what remains>"\`.
5. **Be proactive** — do NOT wait for tasks from others. Create your own subtasks and keep working.
6. **Do NOT finish** the [auto] task until the goal is achieved — keep creating subtasks.
7. **When done** — mark the goal as achieved: \`orch goal status {{ task.goal_id | default: "<goal-id>" }} achieved\`.

**Deep inspection:** Use \`orch goal show {{ task.goal_id | default: "<goal-id>" }}\` to see full goal details at any time.

**Constraints:**
- Do NOT create new goals via \`orch goal add\` — work within the assigned goal only.
- Do NOT re-read or act on CLAUDE.md, README.md, or other project meta-files to create additional goals.
{% endif %}

## Rules
- Do NOT ask clarifying questions. You are running autonomously without human input.
- Make reasonable assumptions and proceed with the best approach.
- If critical information is missing, document your assumptions and continue.
- When a task is too large or spans multiple domains, break it into subtasks using \`orch task add\`.
- When creating subtasks, use \`--scope\` to declare which files each task will touch, and \`--depends-on\` to order dependent work.
`;

/**
 * Dynamic user prompt template — changes every run.
 * Contains: task details, attempt/retry, team, context, messages, goal, feedback.
 */
export const DEFAULT_USER_TEMPLATE = `## Task: {{ task.title }}
{{ task.description }}

Priority: {{ task.priority }}
{% if attempt %}Attempt: {{ attempt }}{% endif %}
{% if retry %}
## Previous attempt failed
**Error:** {{ retry.previous_error }}
{% if retry.previous_output != "" %}
**Last output:**
\`\`\`
{{ retry.previous_output }}
\`\`\`
{% endif %}
**Important:** The previous approach failed. Analyze the error above and try a different strategy. Do NOT repeat the same steps that led to the failure.
{% endif %}

## Context
Project: {{ project.name }}
Working directory: {{ workspace_path }}

## Team
You are part of a multi-agent team. Available agents:
{% for a in agents %}- **{{ a.name }}** ({{ a.adapter }}){% if a.role %} — {{ a.role }}{% endif %} · ID: \`{{ a.id }}\`
{% endfor %}
Use \`orch agent list\` to check current agent statuses. Find teammates by name/role — do NOT hardcode agent IDs.

{% if feedback %}
## Review Feedback
This task was sent back or paused earlier (by a review, ORCH, or a human decision) with the following feedback:

{{ feedback }}

**Important:** Address the feedback above. Your earlier work is still in the workspace — build on it; do NOT redo work that was already accepted.
{% endif %}

{% if upstream %}
## What your dependencies delivered
The tasks this one depends on are done. Their delivery reports:
{% for u in upstream %}
### {{ u.title }} ({{ u.status }})
{{ u.report }}
{% endfor %}
{% endif %}

{% if contracts %}
## Contracts (authoritative)
This task follows these contracts. They settle every disagreement between the tasks that share them (for example frontend and backend). Implement exactly what they say and do NOT change them: ORCH sends the task back if you do. If a contract is wrong or missing something, ask with \`orch decision request "<question>"\` and end your run.
{% for c in contracts %}
### \`{{ c.path }}\`
{% if c.missing %}(not found in your workspace yet — ask with \`orch decision request\` if you cannot work without it)
{% else %}~~~~
{{ c.content }}
~~~~
{% if c.truncated %}(cut to fit; read the whole file in your workspace)
{% endif %}{% endif %}{% endfor %}
{% endif %}

{% if decisions %}
## Decisions (binding)
A human made these decisions. Follow them and do not reopen them:
{% for d in decisions %}- {{ d.question }} → **{{ d.answer }}**{% if d.project_wide %} (project-wide){% endif %}
{% endfor %}
{% endif %}

{% if planning %}
## Your job: plan the work, do not implement it
The task above is a requirement. Turn it into a plan of tasks for the team. Read the code to understand what exists, but do NOT change project files and do NOT create tasks with \`orch task add\` — submit a plan instead; a human approves it and ORCH creates the tasks.

**Roles you can assign** (only these; if the work needs a role that does not exist, ask with \`orch decision request\` instead of inventing one):
{% for r in planning.roles %}- \`{{ r.name }}\` ({{ r.agents }} agent{% if r.agents != 1 %}s{% endif %}){% if r.description %} — {{ r.description }}{% endif %}
{% endfor %}
**Planning rules:**
- One task = one role, small enough for one agent run. Put the acceptance criteria in its description.
- When frontend and backend both take part, the first task defines the API contract (e.g. an OpenAPI file) and lists it in \`produces\`; both sides depend on it and list it in \`uses\`. A contract settles disagreements: tasks that use it get its content and may not change it.
- \`produces\` = files a task must create (checked when it delivers); \`uses\` = contract files it follows (another task in its depends_on chain must produce them, or they exist already).
- Give tasks that can run in parallel non-overlapping \`scope\` (the files they may change) so they do not conflict.
- Use \`depends_on\` only for real ordering needs; independent tasks run in parallel.
- \`review_criteria\` (test_pass, typecheck, lint) are checked automatically before a task is merged.
- Mark risky tasks (schema or data migrations, deleting features, security changes) with \`needs_decision: true\`: a human confirms before they start.
- At most {{ planning.max_tasks }} tasks. If the requirement is bigger, plan a first phase.

**Plan file (YAML):**
\`\`\`yaml
goal: Order discounts                # one line: what the plan achieves
summary: Contract first, then backend and frontend in parallel, then QA
tasks:
  - key: api-contract                # your name for the task, used by depends_on
    title: Define the discount API contract
    role: backend
    description: |
      What to do ...
      Acceptance criteria: ...
    scope: [docs/api/discount.yaml]
    produces: [docs/api/discount.yaml]
  - key: be-discount
    title: Implement the discount API
    role: backend
    depends_on: [api-contract]       # keys in this plan, or existing task IDs
    scope: ["src/main/java/**/discount/**"]
    uses: [docs/api/discount.yaml]  # the contract it follows (must not change it)
    review_criteria: [test_pass]
    priority: 2                      # 1 (urgent) - 4, optional
    needs_decision: false            # optional
\`\`\`

**Submit:** write the plan to \`plan.yml\` in your working directory and run \`orch plan submit plan.yml\`. If it reports problems, fix them and submit again. Once it is accepted, end your run with a short summary — a human reviews the plan.
{% if planning.previous_plan %}
## Your previous plan (revision {{ planning.revision | minus: 1 }}, sent back)
The human's feedback is under Review Feedback above.
\`\`\`yaml
{{ planning.previous_plan }}
\`\`\`
{% endif %}
{% endif %}

{% if prd and prd.drafting %}
## Your job: write the PRD, do not implement it
You are the product manager. Turn the requirement above into a PRD (product requirements document) named \`{{ prd.name }}\`, version {{ prd.drafting.next_version }}. Read the code to understand what exists, but do NOT change project files.
{% if prd.content %}The current version (v{{ prd.version }}) is at the end of this section: update it to cover the requirement; keep what still holds.
{% endif %}
**Write it in Markdown with:** Goal · Users and scenarios · Requirements and business rules (numbered and concrete: limits, rounding, error cases) · Acceptance criteria (testable) · Out of scope · Open questions (only ones a human must settle).
If something only a human can decide blocks the PRD (pricing policy, legal, priorities), ask with \`orch decision request "<question>" --option "<A>" --option "<B>"\` and end your run; you are resumed with the answer.

**Hand it in:** write \`prd.md\` in your working directory and run \`orch prd add {{ prd.name }} -f prd.md -m "<one line: what this version covers>"\`. Then end your run with a short summary: a planner turns it into tasks, and a human approves the PRD together with that plan.
{% if prd.content %}
### Current PRD ({{ prd.name }} v{{ prd.version }})
~~~~
{{ prd.content }}
~~~~
{% endif %}
{% elsif prd %}
## Product requirements (PRD {{ prd.name }} v{{ prd.version }})
This is what the product must do. Follow it. If it is ambiguous or contradicts your task, ask with \`orch decision request\` (the PM answers first).
~~~~
{{ prd.content }}
~~~~
{% if prd.truncated %}(cut to fit; read all of it with \`orch prd show {{ prd.name }}\`)
{% endif %}
{% endif %}

{% if triage %}
## Your job: answer a teammate's question
{{ triage.asked_by }} asked \`{{ triage.decision_id }}\`{% if triage.asking_task %} while working on "{{ triage.asking_task.title }}" ({{ triage.asking_task.id }}){% endif %} and waits for the answer. You are the product manager: answer from the PRD and the product's intent. Do NOT change project files.

**Question:** {{ triage.question }}
{% if triage.options.size > 0 %}**Options:** {% for o in triage.options %}{{ forloop.index }}. {{ o }}{% unless forloop.last %} · {% endunless %}{% endfor %}
{% endif %}
- **Answer it:** \`orch decision answer {{ triage.decision_id }} -m "<answer>"\`{% if triage.options.size > 0 %} (or \`--choose <n>\`){% endif %}. The teammate continues with your answer.
- If the answer adds or changes a requirement, update the PRD first ({% if prd %}\`orch prd add {{ prd.name }} -f prd.md -m "<what changed, for {{ triage.decision_id }}>"\`{% else %}\`orch prd add <name> -f prd.md\`{% endif %}) so every task sees it, then answer.
- **If only a human can decide** (pricing, legal, priorities, scope beyond the PRD, or you are not sure): \`orch decision escalate {{ triage.decision_id }} -m "<why, and the options you see>"\`.

Then end your run with a short summary.
{% endif %}

## When a human must decide
If the requirements are ambiguous or contradict each other, or the choice is a product or architecture decision that is not yours to make, do not guess. Ask, then stop:
\`orch decision request "<question>" --option "<choice A>" --option "<choice B>"\`
(it applies to this task, {{ task.id }}). Then end your run with a short summary of what you did so far — you will be resumed with the answer.
{% if delivery %}
## Before you finish: delivery report
ORCH moves this task on only after you hand in a report. Write it in Markdown with these sections (\`## <name>\` headings, none of them empty):
{% for s in delivery.sections %}- \`## {{ s }}\`
{% endfor %}{% if delivery.produces.size > 0 %}
This task must produce: {% for p in delivery.produces %}\`{{ p }}\`{% unless forloop.last %}, {% endunless %}{% endfor %}. A \`done\` report is rejected while no file matches.
{% endif %}
Then run, from your working directory: \`orch task deliver report.md --status <status>\`
- \`done\`: everything the task asks for is done and you verified it.
- \`partial\`: part of it is done; the report says what is missing and why.
- \`blocked\`: you could not do it (missing information, a broken environment…); the report says what you need.

Be honest: a human reads partial and blocked reports and decides how to go on, and a false \`done\` is caught by review and sent back. If the command lists problems, fix the report and run it again. Then end your run.
{% endif %}

{% if shared_context %}
## Shared Context
Other agents have shared the following information:
{% for entry in shared_context %}- **{{ entry[0] }}**: {{ entry[1] }}
{% endfor %}
{% endif %}

{% if messages %}
## Inbox ({{ messages.size }} message{% if messages.size != 1 %}s{% endif %})
{% for msg in messages %}
---
**From:** {{ msg.from }}{% if msg.subject != "" %} · **Subject:** {{ msg.subject }}{% endif %}
{{ msg.body }}
{% if msg.reply_to %}*(Reply to: {{ msg.reply_to }})*{% endif %}
---
{% endfor %}
{% endif %}

{% if goal %}
## Goal: {{ goal.title }}
**Status:** {{ goal.status }} · **ID:** \`{{ goal.id }}\`
{% if goal.description != "" %}
{{ goal.description }}
{% endif %}
{% if goal.task_names.size > 0 %}
**Linked tasks ({{ goal.task_names.size }}):**
{% for name in goal.task_names %}- {{ name }}
{% endfor %}
Use \`orch task list --goal-id {{ goal.id }}\` and \`orch task show <id>\` to inspect details.
{% endif %}
{% if goal.progress %}
**Latest progress report:**
{{ goal.progress }}
{% endif %}
{% endif %}
`;

/** @deprecated Use DEFAULT_SYSTEM_TEMPLATE + DEFAULT_USER_TEMPLATE instead */
export const DEFAULT_PROMPT_TEMPLATE = DEFAULT_SYSTEM_TEMPLATE + '\n' + DEFAULT_USER_TEMPLATE;
