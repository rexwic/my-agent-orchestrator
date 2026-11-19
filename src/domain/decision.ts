/**
 * Decision — something an agent or ORCH must not decide alone.
 *
 * A decision is requested (by ORCH when a loop hits its limit, by an agent that
 * finds the requirements ambiguous, or by a gate set on a task) and answered by
 * a human. While a decision on a task is pending, the task waits in
 * `waiting_decision`. Answers are kept as records and given to later agents:
 * `task` scope to that task's future runs, `project` scope to every agent.
 */

import { InvalidArgumentsError } from './errors.js';

export type DecisionStatus = 'pending' | 'answered';

/** Who asked. */
export type DecisionSource =
  /** ORCH: a send-back / review loop reached its limit. */
  | 'escalation'
  /** An agent asked (`orch decision request`). */
  | 'agent'
  /** The task was created with `--needs-decision`. */
  | 'gate'
  /** A planner submitted a plan: approve it, send it back with feedback, or cancel it. */
  | 'plan'
  /** An agent delivered its task as partial or blocked. */
  | 'delivery'
  /** A reviewer still has open must-fix findings after the last round. */
  | 'review'
  /** Bugs: a second hand-off between owners, or bugs still broken after re-verification. */
  | 'bug';

/** What happens to the task once answered. */
export type DecisionAction = 'continue' | 'approve' | 'cancel';

/** Who sees the answer afterwards. */
export type DecisionScope = 'task' | 'project';

export interface DecisionAnswer {
  /** One of the decision's options, if it had any. */
  choice?: string;
  message?: string;
  action: DecisionAction;
  scope: DecisionScope;
  answered_at: string;
  /** "human", or the agent (PM) that answered. */
  answered_by?: string;
}

export interface Decision {
  id: string;
  status: DecisionStatus;
  source: DecisionSource;
  task_id?: string;
  /** Plan this decision approves (source 'plan'). */
  plan_id?: string;
  /** Bugs this decision is about (source 'bug'). */
  bug_ids?: string[];
  question: string;
  options: string[];
  /** Background for the human (and for the agent when it continues): loop history, test output… */
  context?: string;
  /** Agent name, "orch", or "human". */
  requested_by: string;
  created_at: string;
  /** Role that answers it first (the PM); unset = a human. */
  assignee?: string;
  /** The assignee's task for answering it. */
  triage_task_id?: string;
  answer?: DecisionAnswer;
}

export interface DecisionRequest {
  task_id?: string;
  plan_id?: string;
  bug_ids?: string[];
  question: string;
  options?: string[];
  context?: string;
  source: DecisionSource;
  requested_by?: string;
}

export interface DecisionAnswerInput {
  choice?: string;
  message?: string;
  action?: DecisionAction;
  scope?: DecisionScope;
}

export const MAX_QUESTION_LENGTH = 2000;
export const MAX_CONTEXT_LENGTH = 8000;
export const MAX_OPTIONS = 10;

/** Validate and normalize a request (throws InvalidArgumentsError). */
export function normalizeDecisionRequest(input: DecisionRequest): Required<Pick<DecisionRequest, 'question' | 'options'>> & DecisionRequest {
  const question = input.question?.trim() ?? '';
  if (!question) throw new InvalidArgumentsError('A decision needs a question');
  if (question.length > MAX_QUESTION_LENGTH) {
    throw new InvalidArgumentsError(`Question is too long (max ${MAX_QUESTION_LENGTH} characters)`);
  }
  const options = [...new Set((input.options ?? []).map((o) => o.trim()).filter(Boolean))];
  if (options.length > MAX_OPTIONS) throw new InvalidArgumentsError(`At most ${MAX_OPTIONS} options`);
  return {
    ...input,
    question,
    options,
    ...(input.context ? { context: input.context.slice(-MAX_CONTEXT_LENGTH) } : {}),
  };
}

/** Resolve an answer against the decision's options (throws InvalidArgumentsError). */
export function resolveDecisionAnswer(decision: Decision, input: DecisionAnswerInput, now = new Date()): DecisionAnswer {
  const action = input.action ?? 'continue';
  const message = input.message?.trim() || undefined;
  let choice = input.choice?.trim() || undefined;

  if (choice !== undefined && decision.options.length > 0) {
    // Accept the option text (case-insensitive) or its 1-based number.
    const index = /^\d+$/.test(choice) ? Number(choice) - 1 : decision.options.findIndex((o) => o.toLowerCase() === choice!.toLowerCase());
    const match = decision.options[index];
    if (match === undefined) {
      throw new InvalidArgumentsError(
        `"${choice}" is not an option of ${decision.id}`,
        `Options: ${decision.options.map((o, i) => `${i + 1}. ${o}`).join('  ')}`,
      );
    }
    choice = match;
  }
  if (action === 'continue' && !choice && !message) {
    throw new InvalidArgumentsError(
      'An answer needs a choice or a message',
      decision.options.length ? 'Use --choose <option> and/or -m "<answer>"' : 'Use -m "<answer>"',
    );
  }

  return {
    ...(choice ? { choice } : {}),
    ...(message ? { message } : {}),
    action,
    scope: input.scope ?? 'task',
    answered_at: now.toISOString(),
  };
}

/** One line for prompts and lists: the question and what was decided. */
export function describeAnswer(decision: Decision): string {
  const a = decision.answer;
  if (!a) return '';
  const parts = [a.choice, a.message].filter(Boolean);
  return parts.length ? parts.join(' — ') : a.action;
}
