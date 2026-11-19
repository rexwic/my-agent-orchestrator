/**
 * Orchestrator event system.
 *
 * All communication between layers goes through typed events.
 * The EventBus emits these synchronously; subscribers (TUI, logger,
 * run store, state) react independently.
 */

import type { GoalStatus } from './goal.js';
import type { MessageChannel } from './message.js';
import type { Task, TaskStatus, ReviewResult } from './task.js';

export type OrchestratorEvent =
  | { type: 'task:created'; task: Task }
  | { type: 'task:assigned'; taskId: string; agentId: string }
  | { type: 'task:status_changed'; taskId: string; from: TaskStatus; to: TaskStatus }
  | { type: 'task:auto_reviewed'; taskId: string; passed: boolean; results: ReviewResult[] }
  | { type: 'agent:started'; agentId: string; taskId: string; runId: string }
  | { type: 'agent:output'; runId: string; agentId: string; data: string }
  | { type: 'agent:file_changed'; runId: string; agentId: string; path: string }
  | { type: 'agent:completed'; runId: string; agentId: string; success: boolean }
  | { type: 'agent:error'; runId: string; agentId: string; error: string; errorKind?: import('./errors.js').AdapterErrorKind }
  | { type: 'quota:paused'; group: string; agentId: string; taskId: string; until: string; resetKnown: boolean; reason: string }
  | { type: 'quota:resumed'; group: string; manual: boolean }
  | { type: 'role:synced'; created: string[]; updated: string[]; removed: string[] }
  | { type: 'task:dependency_cycle'; taskIds: string[] }
  | { type: 'task:approved'; taskId: string }
  | { type: 'decision:requested'; decisionId: string; taskId?: string; source: import('./decision.js').DecisionSource; question: string }
  | { type: 'task:delivered'; taskId: string; status: import('./deliverable.js').DeliveryStatus; by: string }
  | { type: 'plan:submitted'; planId: string; revision: number; tasks: number; decisionId: string }
  | { type: 'plan:approved'; planId: string; goalId: string; taskIds: string[] }
  | { type: 'plan:revised'; planId: string; revision: number; taskId: string }
  | { type: 'plan:cancelled'; planId: string }
  | { type: 'decision:answered'; decisionId: string; taskId?: string; action: 'continue' | 'approve' | 'cancel'; scope: 'task' | 'project' }
  | { type: 'task:synced'; taskId: string; target: string; sha: string; merged: boolean }
  | { type: 'task:sent_back'; taskId: string; reason: 'conflict' | 'review' | 'contract'; count: number; max: number; files?: string[] }
  | { type: 'run:retry'; runId: string; attempt: number; delay_ms: number }
  | { type: 'orchestrator:tick'; running: number; queued: number }
  | { type: 'orchestrator:stall_detected'; runId: string }
  | { type: 'task:scope_overlap'; taskId: string; overlappingTaskId: string; patterns: string[] }
  | { type: 'task:cascade_failed'; taskId: string; failedDependencyId: string; reason: string }
  | { type: 'workspace:merge_succeeded'; taskId: string; branch: string }
  | { type: 'workspace:merge_conflict'; taskId: string; branch: string; conflictInfo: string }
  | { type: 'task:orphaned'; taskId: string }
  | { type: 'orchestrator:error'; error: string; context: string; fatal: boolean }
  | { type: 'orchestrator:shutdown'; reason: string }
  | { type: 'message:sent'; messageId: string; fromAgentId: string; toAgentId: string | null; channel: MessageChannel }
  | { type: 'message:delivered'; messageId: string; toAgentId: string; taskId: string }
  | { type: 'team:created'; teamId: string; name: string; leadAgentId: string }
  | { type: 'team:member_joined'; teamId: string; agentId: string }
  | { type: 'team:member_left'; teamId: string; agentId: string }
  | { type: 'team:task_claimed'; teamId: string; taskId: string; agentId: string }
  | { type: 'team:disbanded'; teamId: string }
  | { type: 'team:task_added'; teamId: string; taskId: string }
  | { type: 'agent:autonomous_toggled'; agentId: string; autonomous: boolean }
  | { type: 'goal:created'; goalId: string; title: string }
  | { type: 'goal:status_changed'; goalId: string; from: GoalStatus; to: GoalStatus }
  | { type: 'goal:updated'; goalId: string }
  | { type: 'goal:deleted'; goalId: string };

export type OrchestratorEventType = OrchestratorEvent['type'];

/**
 * Extract event payload by type discriminator.
 */
export type EventPayload<T extends OrchestratorEventType> = Extract<
  OrchestratorEvent,
  { type: T }
>;
