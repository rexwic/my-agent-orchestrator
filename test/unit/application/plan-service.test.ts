import { describe, it, expect, vi } from 'vitest';
import { PlanService } from '../../../src/application/plan-service.js';
import { DecisionService } from '../../../src/application/decision-service.js';
import { TaskService } from '../../../src/application/task-service.js';
import { GoalService } from '../../../src/application/goal-service.js';
import { EventBus } from '../../../src/application/event-bus.js';
import { DEFAULT_CONFIG } from '../../../src/domain/config.js';
import { validateRole, type Role } from '../../../src/domain/role.js';
import type { Goal } from '../../../src/domain/goal.js';
import { MemoryDecisionStore } from '../../../src/infrastructure/storage/decision-store.js';
import { MemoryPlanStore } from '../../../src/infrastructure/storage/plan-store.js';
import type { IGoalStore, IRoleStore } from '../../../src/infrastructure/storage/interfaces.js';
import { createMockTaskStore, createMockAgentStore } from './helpers.js';

const role = (name: string, extra: Partial<Role> = {}) => validateRole({ name, adapter: 'claude', ...extra });

function setup(roleList: Role[] = [role('planner', { task_defaults: { review_criteria: ['test_pass'] } }), role('backend', { description: 'Java/Spring', replicas: 2 }), role('frontend')]) {
  let roles = roleList;
  const roleStore: IRoleStore = {
    save: async () => {},
    get: async (name) => roles.find((r) => r.name === name) ?? null,
    load: async () => ({ roles, errors: [] }),
    list: async () => roles,
    delete: async () => {},
  };
  const goals = new Map<string, Goal>();
  const goalStore: IGoalStore = {
    list: async () => [...goals.values()],
    get: async (id) => goals.get(id) ?? null,
    save: async (g) => { goals.set(g.id, structuredClone(g)); },
    delete: async (id) => { goals.delete(id); },
  };
  const taskStore = createMockTaskStore();
  const eventBus = new EventBus();
  const events: any[] = [];
  eventBus.onAny((e: any) => events.push(e));
  const taskService = new TaskService(taskStore, eventBus, DEFAULT_CONFIG, undefined, createMockAgentStore(), roleStore);
  const goalService = new GoalService(goalStore, eventBus, { enableAutonomous: vi.fn() } as any, taskService);
  const decisionService = new DecisionService(new MemoryDecisionStore(), taskStore, taskService, eventBus);
  const service = new PlanService({ store: new MemoryPlanStore(), taskStore, taskService, goalService, decisionService, roleStore, eventBus, config: DEFAULT_CONFIG });
  return {
    service, decisionService, taskService, taskStore, goals, events,
    setRoles: (r: Role[]) => { roles = r; },
    task: async (id: string) => (await taskStore.get(id))!,
  };
}

const draft = {
  goal: 'Order discounts',
  summary: 'Contract first, then both sides',
  tasks: [
    { key: 'fe', title: 'Discount UI', role: 'frontend', description: 'UI', depends_on: ['contract'], scope: ['web/**'] },
    { key: 'be', title: 'Discount API', role: 'backend', description: 'API', depends_on: ['contract'], scope: ['src/**'], review_criteria: ['test_pass'] },
    { key: 'contract', title: 'API contract', role: 'backend', description: 'OpenAPI', scope: ['docs/api.yaml'], priority: 2 },
    { key: 'migrate', title: 'Add discount column', role: 'backend', description: 'Flyway', depends_on: ['be'], needs_decision: 'Run the migration on the shared DB?' },
  ],
};

describe('PlanService.start', () => {
  it('creates the plan and a planning task for the planner role', async () => {
    const { service, task } = setup();
    const { plan, task: t } = await service.start({ requirement: 'Order discounts\nPercent and fixed amounts' });

    expect(plan).toMatchObject({ status: 'planning', title: 'Order discounts', role: 'planner', revision: 1, planning_task_id: t.id });
    expect(plan.id).toMatch(/^pln_/);
    expect(await task(t.id)).toMatchObject({
      status: 'todo', role: 'planner', plan_id: plan.id, labels: ['planning'],
      title: 'Plan: Order discounts', review_criteria: [], // not the role's test_pass default
    });
  });

  it('needs a planner role', async () => {
    const { service } = setup([role('backend')]);
    await expect(service.start({ requirement: 'x' })).rejects.toMatchObject({
      message: expect.stringMatching(/no "planner" role/),
      hint: expect.stringMatching(/orch role add planner/),
    });
  });
});

describe('PlanService.submit', () => {
  it('rejects an invalid plan with every problem; the plan keeps planning', async () => {
    const { service } = setup();
    const { plan, task } = await service.start({ requirement: 'x' });

    const err = await service.submit({ taskId: task.id, raw: { goal: 'G', tasks: [{ key: 'a', title: 'A', role: 'planner', description: 'd' }] } }).catch((e) => e);
    // The planner role itself cannot be assigned work.
    expect(err.message).toMatch(/1 problem\(s\):\n {2}- tasks\[0\] \(a\): role "planner" does not exist \(roles: backend, frontend\)/);
    expect(err.hint).toMatch(/orch plan submit again/);
    expect((await service.get(plan.id)).status).toBe('planning');
  });

  it('accepts a valid plan and asks a human to approve it (a plan decision)', async () => {
    const { service, decisionService, events } = setup();
    const { plan, task } = await service.start({ requirement: 'x' });

    const { plan: submitted, decision, warnings } = await service.submit({ taskId: task.id, raw: draft, submittedBy: 'planner-1' });

    expect(warnings).toEqual([]);
    expect(submitted).toMatchObject({ status: 'awaiting_approval', submitted_by: 'planner-1', decision_id: decision.id });
    expect(decision).toMatchObject({ status: 'pending', source: 'plan', plan_id: plan.id, requested_by: 'planner-1' });
    expect(decision.task_id).toBeUndefined();
    expect(decision.question).toBe(`Approve plan ${plan.id} "Order discounts" (4 task(s), revision 1)?`);
    expect(decision.context).toContain('3. [backend] contract: API contract');
    expect(decision.context).toContain('asks you before it starts');
    expect(await decisionService.list({ status: 'pending' })).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({ type: 'plan:submitted', planId: plan.id, tasks: 4 }));
  });

  it('a second submission before an answer updates the same decision', async () => {
    const { service, decisionService } = setup();
    const { task } = await service.start({ requirement: 'x' });
    const first = await service.submit({ taskId: task.id, raw: draft });
    const second = await service.submit({ taskId: task.id, raw: { ...draft, tasks: draft.tasks.slice(1, 3) } });

    expect(second.decision.id).toBe(first.decision.id);
    expect(second.decision.question).toMatch(/\(2 task\(s\)/);
    expect(await decisionService.list({ status: 'pending' })).toHaveLength(1);
  });

  it('finds the only open plan when no task or plan is given', async () => {
    const { service } = setup();
    const { plan } = await service.start({ requirement: 'x' });
    expect((await service.submit({ raw: draft })).plan.id).toBe(plan.id);
  });
});

describe('approving a plan', () => {
  it('creates a goal and the tasks in dependency order, with roles, scopes and gates', async () => {
    const { service, task, goals, decisionService, events } = setup();
    const { plan, task: planner } = await service.start({ requirement: 'Order discounts' });
    await service.submit({ taskId: planner.id, raw: draft });

    const approved = await service.approve(plan.id);

    expect(approved.status).toBe('approved');
    const goal = goals.get(approved.goal_id!)!;
    expect(goal).toMatchObject({ title: 'Order discounts', status: 'active' });
    expect(goal.description).toContain('Requirement:\nOrder discounts');

    const ids = approved.created_tasks!;
    expect(Object.keys(ids).sort()).toEqual(['be', 'contract', 'fe', 'migrate']);
    const be = await task(ids['be']!);
    expect(be).toMatchObject({
      title: 'Discount API', role: 'backend', status: 'todo', depends_on: [ids['contract']],
      scope: ['src/**'], review_criteria: ['test_pass'], goalId: approved.goal_id, labels: [`plan:${plan.id}`],
    });
    expect(await task(ids['contract']!)).toMatchObject({ priority: 2, depends_on: [] });

    // The risky task waits for a human before it starts.
    const migrate = await task(ids['migrate']!);
    expect(migrate.status).toBe('waiting_decision');
    const [gate] = await decisionService.pendingFor(migrate.id);
    expect(gate).toMatchObject({ source: 'gate', question: 'Run the migration on the shared DB?', context: 'Flyway' });

    // Approving the gate starts it.
    await decisionService.answer(gate!.id, { action: 'approve' });
    expect((await task(migrate.id)).status).toBe('todo');

    // The plan decision is recorded as approved.
    const decision = await decisionService.get(approved.decision_id!);
    expect(decision.answer?.action).toBe('approve');
    expect(events).toContainEqual(expect.objectContaining({ type: 'plan:approved', planId: plan.id, goalId: approved.goal_id }));
  });

  it('works the same through the decision inbox (orch decision answer --approve)', async () => {
    const { service, decisionService } = setup();
    const { plan, task } = await service.start({ requirement: 'x' });
    const { decision } = await service.submit({ taskId: task.id, raw: draft });

    await decisionService.answer(decision.id, { action: 'approve' });

    expect(await service.get(plan.id)).toMatchObject({ status: 'approved' });
  });

  it('if the plan no longer fits (a role was removed), nothing is created and the decision stays pending', async () => {
    const { service, decisionService, setRoles, taskStore } = setup();
    const { plan, task } = await service.start({ requirement: 'x' });
    const { decision } = await service.submit({ taskId: task.id, raw: draft });
    setRoles([role('planner'), role('backend')]);

    await expect(service.approve(plan.id)).rejects.toThrow(/can no longer be applied[\s\S]*role "frontend" does not exist/);

    expect((await service.get(plan.id)).status).toBe('awaiting_approval');
    expect((await decisionService.get(decision.id)).status).toBe('pending');
    expect((await taskStore.list()).filter((t) => !t.plan_id)).toEqual([]);
  });

  it('cannot approve before the planner submitted', async () => {
    const { service } = setup();
    const { plan } = await service.start({ requirement: 'x' });
    await expect(service.approve(plan.id)).rejects.toThrow(/has not been submitted yet/);
  });
});

describe('sending a plan back', () => {
  it('starts the next revision with the feedback and the previous plan', async () => {
    const { service, task, events } = setup();
    const { plan, task: rev1 } = await service.start({ requirement: 'Order discounts' });
    await service.submit({ taskId: rev1.id, raw: draft });

    const revised = await service.revise(plan.id, 'Drop the migration; reuse the price column');

    expect(revised).toMatchObject({ status: 'planning', revision: 2, feedback: 'Drop the migration; reuse the price column' });
    expect(revised.planning_task_ids).toEqual([rev1.id, revised.planning_task_id]);
    const rev2 = await task(revised.planning_task_id);
    expect(rev2).toMatchObject({ status: 'todo', title: 'Plan: Order discounts (rev 2)', plan_id: plan.id });
    expect(rev2.feedback).toMatch(/reviewed your plan \(revision 1\) and sent it back:\nDrop the migration/);

    const ctx = await service.promptContext(rev2);
    expect(ctx).toMatchObject({ plan_id: plan.id, revision: 2, max_tasks: 30 });
    expect(ctx!.roles).toEqual([{ name: 'backend', description: 'Java/Spring', agents: 2 }, { name: 'frontend', agents: 1 }]);
    expect(ctx!.previous_plan).toContain('key: migrate');
    expect(events).toContainEqual(expect.objectContaining({ type: 'plan:revised', planId: plan.id, revision: 2 }));

    // The old planning task cannot submit any more; the new one can.
    await expect(service.submit({ taskId: rev1.id, raw: draft })).rejects.toThrow(/older revision/);
    const again = await service.submit({ taskId: rev2.id, raw: { ...draft, tasks: draft.tasks.slice(0, 3) } });
    expect(again.decision.question).toMatch(/revision 2/);
  });

  it('a send-back needs feedback', async () => {
    const { service } = setup();
    const { plan, task } = await service.start({ requirement: 'x' });
    await service.submit({ taskId: task.id, raw: draft });
    await expect(service.revise(plan.id, '  ')).rejects.toThrow(/Say what to change/);
  });
});

describe('cancelling and run outcomes', () => {
  it('cancels a submitted plan through its decision, or a plan still planning with its task', async () => {
    const { service, task, decisionService } = setup();
    const a = await service.start({ requirement: 'a' });
    const { decision } = await service.submit({ planId: a.plan.id, raw: draft });
    expect((await service.cancel(a.plan.id)).status).toBe('cancelled');
    expect((await decisionService.get(decision.id)).answer?.action).toBe('cancel');

    const b = await service.start({ requirement: 'b' });
    expect((await service.cancel(b.task.id)).status).toBe('cancelled'); // by planning task ID
    expect((await task(b.task.id)).status).toBe('cancelled');
  });

  it('planningRunOutcome: missing until the current planning task submits', async () => {
    const { service } = setup();
    const { plan, task } = await service.start({ requirement: 'x' });
    expect(await service.planningRunOutcome(task)).toBe('missing');
    await service.submit({ taskId: task.id, raw: draft });
    expect(await service.planningRunOutcome(task)).toBe('submitted');

    const revised = await service.revise(plan.id, 'more detail');
    expect(await service.planningRunOutcome(task)).toBe('submitted'); // superseded
    expect(await service.planningRunOutcome({ id: revised.planning_task_id, plan_id: plan.id })).toBe('missing');
  });

  it('honours planner.max_tasks', async () => {
    const { service } = setup();
    (service as any).deps.config = { ...DEFAULT_CONFIG, planner: { max_tasks: 2 } };
    const { task } = await service.start({ requirement: 'x' });
    await expect(service.submit({ taskId: task.id, raw: draft })).rejects.toThrow(/Too many tasks: 4 \(max 2\)/);
  });
});

describe('PlanService contracts', () => {
  it('created tasks carry produces / uses; uses must exist in the project when nobody produces it', async () => {
    const { service, task } = setup();
    (service as any).deps.projectRoot = process.cwd();
    const withContract = {
      goal: 'G',
      tasks: [
        { key: 'contract', title: 'API contract', role: 'backend', description: 'OpenAPI', produces: ['docs/api/discount.yaml'] },
        { key: 'be', title: 'API', role: 'backend', description: 'API', depends_on: ['contract'], uses: ['docs/api/discount.yaml', 'package.json'] },
      ],
    };
    const { plan, task: planner } = await service.start({ requirement: 'x' });
    await expect(service.submit({ taskId: planner.id, raw: { ...withContract, tasks: [withContract.tasks[0], { ...withContract.tasks[1], uses: ['nope.yaml'] }] } }))
      .rejects.toThrow(/uses "nope.yaml", but no task in the plan produces it/);
    await service.submit({ taskId: planner.id, raw: withContract });
    const approved = await service.approve(plan.id);
    expect(await task(approved.created_tasks!['contract']!)).toMatchObject({ produces: ['docs/api/discount.yaml'] });
    expect(await task(approved.created_tasks!['be']!)).toMatchObject({ uses: ['docs/api/discount.yaml', 'package.json'] });
  });
});
