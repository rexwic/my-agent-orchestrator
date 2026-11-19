/**
 * Library entry point.
 *
 * Re-exports domain types and core services for programmatic use.
 */

// Domain
export type { Task, TaskStatus, CreateTaskInput, WorkspaceMode, TaskProof } from './domain/task.js';
export type { Agent, AgentStatus, AgentConfig, CreateAgentInput, ApprovalPolicy, ReasoningEffort, AgentStats, AgentLastError } from './domain/agent.js';
export type { Run, RunStatus, RunEvent, RunEventType, TokenUsage } from './domain/run.js';
export { createTokenUsage } from './domain/run.js';
export type { OrchestratorConfig, ProjectConfig, SchedulingConfig, ReviewConfig, PlatformCommand } from './domain/config.js';
export type { OrchestratorState, RunningEntry, RetryEntry } from './domain/state.js';
export type { OrchestratorEvent, OrchestratorEventType, EventPayload } from './domain/events.js';
export { OrchestryError, NotInitializedError, TaskNotFoundError, AgentNotFoundError, GoalHasPendingTasksError, WorkspaceError, AdapterErrorKind, ERROR_HINTS, classifyAdapterError } from './domain/errors.js';
export type { AdapterErrorHint } from './domain/errors.js';
export { canTransition, isTerminal, isDispatchable, isBlocked, resolveFailureStatus, findDependencyCycles } from './domain/transitions.js';
export type { AdapterKind, ModelTier } from './domain/model-tiers.js';
export { resolveModel, defaultModelForAdapter, isAdapterKind, isModelTier, MODEL_TIER_MAP, SUPPORTED_ADAPTERS } from './domain/model-tiers.js';
export type { AgentShopTemplate } from './domain/agent-shop.js';
export { AGENT_SHOP_TEMPLATES, getShopTemplateByKey } from './domain/agent-shop.js';

// Application
export { EventBus } from './application/event-bus.js';
export { templateToAgentInput, isMcpSkill } from './application/agent-factory.js';
export { TaskService } from './application/task-service.js';
export { AgentService } from './application/agent-service.js';
export { RunService } from './application/run-service.js';
export { Orchestrator, type ApproveTaskOutcome } from './application/orchestrator.js';
export { ReviewGate } from './application/review-gate.js';
export { IntegrationService, buildSendBackFeedback, type IntegrationOutcome, type IntegrationTrigger } from './application/integration-service.js';
export { QuotaService } from './application/quota-service.js';
export { RoleService } from './application/role-service.js';
export type { RoleSyncResult } from './application/role-service.js';
export { RoleStore } from './infrastructure/storage/role-store.js';
export type { Role, CreateRoleInput, RoleTaskDefaults } from './domain/role.js';
export { validateRole, roleAgentConfig } from './domain/role.js';
export { DecisionService, buildDecisionFeedback } from './application/decision-service.js';
export { DecisionStore, MemoryDecisionStore } from './infrastructure/storage/decision-store.js';
export { PlanService } from './application/plan-service.js';
export type { PlanServiceDeps, StartPlanInput, SubmitPlanInput, PlanningPromptContext } from './application/plan-service.js';
export { PlanStore, MemoryPlanStore } from './infrastructure/storage/plan-store.js';
export { validatePlanDraft, planTaskOrder, DEFAULT_MAX_PLAN_TASKS } from './domain/plan.js';
export type { Plan, PlanDraft, PlanTask, PlanStatus, PlanValidation, PlanValidationContext } from './domain/plan.js';
export { DeliverableService, MAX_UPSTREAM_REPORT } from './application/deliverable-service.js';
export type { DeliverableServiceDeps, SubmitDeliverableInput, DeliveryContract } from './application/deliverable-service.js';
export { DeliverableStore, MemoryDeliverableStore } from './infrastructure/storage/deliverable-store.js';
export { validateReport, needsDeliveryReport, parseDeliveryStatus, DEFAULT_REPORT_SECTIONS, DELIVERY_STATUSES } from './domain/deliverable.js';
export type { Deliverable, DeliveryStatus } from './domain/deliverable.js';
export { matchesPattern } from './domain/scope.js';
export type { Decision, DecisionAction, DecisionScope, DecisionSource, DecisionRequest, DecisionAnswerInput } from './domain/decision.js';
export { QuotaStore, MemoryQuotaStore } from './infrastructure/storage/quota-store.js';
export type { QuotaPause, QuotaState } from './domain/quota.js';
export { quotaGroupOf, describeQuotaGroup, parseResetTime, computePauseUntil } from './domain/quota.js';
export type { ApproveResult } from './application/review-gate.js';
export { ReviewRunner, DEFAULT_REVIEW_COMMANDS, resolveReviewCommand } from './application/review-runner.js';

// Infrastructure interfaces
export type { IAgentAdapter, AgentEvent, ExecuteParams, AdapterTestResult } from './infrastructure/adapters/interface.js';
export { AdapterRegistry } from './infrastructure/adapters/registry.js';
export type { ISkillLoader } from './infrastructure/skills/skill-loader.js';
export { SkillLoader } from './infrastructure/skills/skill-loader.js';

// Clipboard
export { detectClipboardType, getClipboardImage, isClipboardToolAvailable } from './infrastructure/clipboard-service.js';
export type { ClipboardContentType, ClipboardImage } from './infrastructure/clipboard-service.js';

// Container
export { buildContainer, buildLightContainer, buildFullContainer } from './container.js';
export type { Container, LightContainer } from './container.js';
