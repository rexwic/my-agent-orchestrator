import { describe, it, expect } from 'vitest';
import { validatePlanDraft, planTaskOrder, planTitle, type PlanValidationContext } from '../../../src/domain/plan.js';

const ctx: PlanValidationContext = {
  roles: ['backend', 'frontend', 'qa'],
  existingTaskIds: new Set(['tsk_old']),
  maxTasks: 30,
};

const plan = (tasks: unknown[], extra: Record<string, unknown> = {}) => ({ goal: 'Order discounts', summary: 'Contract first', tasks, ...extra });

const contract = { key: 'api-contract', title: 'Define the discount API', role: 'backend', description: 'OpenAPI file. Done when reviewed.', scope: ['docs/api/discount.yaml'] };
const be = { key: 'be', title: 'Implement the API', role: 'backend', description: 'Implement it', depends_on: ['api-contract'], scope: ['src/main/java/discount/**'], review_criteria: ['test_pass'], priority: 2 };
const fe = { key: 'fe', title: 'Discount UI', role: 'frontend', description: 'Show discounts', depends_on: 'api-contract', scope: ['web/src/discount/**'] };

describe('validatePlanDraft', () => {
  it('accepts a valid plan and normalises it', () => {
    const r = validatePlanDraft(plan([contract, be, fe, { key: 'qa', title: 'Verify', role: 'qa', description: 'E2E', depends_on: ['be', 'fe', 'tsk_old'], needs_decision: true }]), ctx);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.draft!.goal).toBe('Order discounts');
    expect(r.draft!.tasks[2]!.depends_on).toEqual(['api-contract']); // a single string becomes a list
    expect(r.draft!.tasks[1]).toMatchObject({ review_criteria: ['test_pass'], priority: 2 });
    expect(r.draft!.tasks[3]).toMatchObject({ needs_decision: true, depends_on: ['be', 'fe', 'tsk_old'] });
  });

  it('reports every problem at once, naming the task', () => {
    const r = validatePlanDraft(plan([
      { key: 'a', title: '', role: 'devops', description: 'x', depends_on: ['nope'], scope: ['/etc/passwd', '../x'], review_criteria: ['coverage'], priority: 9, colour: 'red' },
      { key: 'a', title: 'dup', role: 'backend', description: '' },
    ], { owner: 'me' }), ctx);
    expect(r.draft).toBeUndefined();
    const all = r.errors.join('\n');
    expect(all).toMatch(/Unknown field "owner"/);
    expect(all).toMatch(/tasks\[0\] \(a\): unknown field "colour"/);
    expect(all).toMatch(/title is required/);
    expect(all).toMatch(/role "devops" does not exist \(roles: backend, frontend, qa\)/);
    expect(all).toMatch(/depends_on "nope" is neither/);
    expect(all).toMatch(/scope "\/etc\/passwd" must be a path relative/);
    expect(all).toMatch(/scope "\.\.\/x" must be a path relative/);
    expect(all).toMatch(/review_criteria must be among/);
    expect(all).toMatch(/priority must be an integer 1-4/);
    expect(all).toMatch(/duplicate key "a"/);
    expect(all).toMatch(/tasks\[1\] \(a\): description is required/);
  });

  it('rejects dependency cycles and self-dependencies', () => {
    const cyc = validatePlanDraft(plan([
      { ...contract, depends_on: ['fe'] },
      { ...be },
      { ...fe, depends_on: ['be'] },
    ]), ctx);
    expect(cyc.errors.join('\n')).toMatch(/Dependency cycle .*api-contract.*→/);

    const self = validatePlanDraft(plan([{ ...contract, depends_on: ['api-contract'] }]), ctx);
    expect(self.errors).toContain('api-contract: depends on itself');
  });

  it('limits the number of tasks and requires goal and tasks', () => {
    const many = Array.from({ length: 4 }, (_, i) => ({ ...contract, key: `t${i}` }));
    expect(validatePlanDraft(plan(many), { ...ctx, maxTasks: 3 }).errors[0]).toMatch(/Too many tasks: 4 \(max 3\)/);
    expect(validatePlanDraft({ tasks: [] }, ctx).errors).toEqual(['goal is required (one line: what the plan achieves)', 'tasks must be a non-empty list']);
    expect(validatePlanDraft('just text', ctx).errors[0]).toMatch(/must be a map/);
  });

  it('reserves tsk_ keys for existing tasks', () => {
    expect(validatePlanDraft(plan([{ ...contract, key: 'tsk_x' }]), ctx).errors[0]).toMatch(/must not start with "tsk_"/);
  });

  it('warns when tasks that can run in parallel have overlapping scopes', () => {
    const r = validatePlanDraft(plan([
      contract,
      { ...be, scope: ['src/order/**'] },
      { ...fe, role: 'backend', scope: ['src/order/Order.java'] }, // parallel with be
      { key: 'later', title: 'After be', role: 'backend', description: 'x', depends_on: ['be'], scope: ['src/order/**'] }, // ordered after be
    ]), ctx);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toHaveLength(2); // be/fe, fe/later — not be/later
    expect(r.warnings[0]).toMatch(/be and fe can run in parallel/);
    expect(r.warnings.join('\n')).not.toMatch(/be and later/);
  });

  it('accepts backslashes and ./ in scopes', () => {
    const r = validatePlanDraft(plan([{ ...contract, scope: ['.\\docs\\api\\x.yaml'] }]), ctx);
    expect(r.draft!.tasks[0]!.scope).toEqual(['docs/api/x.yaml']);
  });
});

describe('planTaskOrder', () => {
  it('puts every task after the tasks it depends on', () => {
    const r = validatePlanDraft(plan([
      { key: 'qa', title: 'QA', role: 'qa', description: 'x', depends_on: ['be', 'fe'] },
      { ...fe },
      { ...be },
      { ...contract },
    ]), ctx);
    const order = planTaskOrder(r.draft!.tasks).map((t) => t.key);
    expect(order.indexOf('api-contract')).toBeLessThan(order.indexOf('be'));
    expect(order.indexOf('api-contract')).toBeLessThan(order.indexOf('fe'));
    expect(order.at(-1)).toBe('qa');
  });
});

describe('planTitle', () => {
  it('uses the first non-empty line, shortened', () => {
    expect(planTitle('\n  Order discounts  \nmore')).toBe('Order discounts');
    expect(planTitle('x'.repeat(100), 10)).toBe('xxxxxxxxx…');
  });
});
