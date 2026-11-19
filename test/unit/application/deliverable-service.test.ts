import { describe, it, expect, vi, afterEach } from 'vitest';
import { DeliverableService } from '../../../src/application/deliverable-service.js';
import { EventBus } from '../../../src/application/event-bus.js';
import { DEFAULT_CONFIG } from '../../../src/domain/config.js';
import { validateRole } from '../../../src/domain/role.js';
import { MemoryDeliverableStore } from '../../../src/infrastructure/storage/deliverable-store.js';
import type { IRoleStore } from '../../../src/infrastructure/storage/interfaces.js';
import { createMockTaskStore, makeTask } from './helpers.js';

const report = '## Summary\nDid it.\n## Verification\nmvn test passed\n## Open issues\nNone';
const qa = validateRole({ name: 'qa', adapter: 'claude', deliverable: { sections: ['重現步驟', '證據'] } });
const roleStore = { get: async (n: string) => (n === 'qa' ? qa : null) } as unknown as IRoleStore;

function setup(taskOver: Parameters<typeof makeTask>[0] = {}) {
  const taskStore = createMockTaskStore([makeTask({ id: 'tsk_a', status: 'in_progress', role: 'backend', ...taskOver })]);
  const eventBus = new EventBus();
  const events: unknown[] = [];
  eventBus.on('task:delivered', (e) => { events.push(e); });
  const svc = new DeliverableService({ store: new MemoryDeliverableStore(), taskStore, roleStore, eventBus, config: DEFAULT_CONFIG });
  return { svc, taskStore, events };
}

afterEach(() => vi.useRealTimers());

describe('DeliverableService.submit', () => {
  it('stores a valid report and emits task:delivered', async () => {
    const { svc, events } = setup();
    const d = await svc.submit({ taskId: 'tsk_a', report, status: 'done', submittedBy: 'backend-1' });
    expect(d).toMatchObject({ task_id: 'tsk_a', status: 'done', submitted_by: 'backend-1' });
    expect(await svc.get('tsk_a')).toMatchObject({ report });
    expect(events).toEqual([{ type: 'task:delivered', taskId: 'tsk_a', status: 'done', by: 'backend-1' }]);
  });

  it('lists every problem so the agent can fix them at once', async () => {
    const { svc } = setup({ produces: ['docs/api/**'] });
    await expect(svc.submit({ taskId: 'tsk_a', report: '## Summary\nx', status: 'done', files: ['src/a.ts'] }))
      .rejects.toThrow(/3 problem\(s\)[\s\S]*Verification[\s\S]*Open issues[\s\S]*No file matches "docs\/api\/\*\*"/);
  });

  it('produces is only enforced for done', async () => {
    const { svc } = setup({ produces: ['docs/api/**'] });
    await expect(svc.submit({ taskId: 'tsk_a', report, status: 'blocked', files: [] })).resolves.toMatchObject({ status: 'blocked' });
    await expect(svc.submit({ taskId: 'tsk_a', report, status: 'done', files: ['docs\\api\\x.yaml'] })).resolves.toMatchObject({ status: 'done' });
  });

  it("uses the role's sections instead of the defaults", async () => {
    const { svc } = setup({ role: 'qa' });
    await expect(svc.submit({ taskId: 'tsk_a', report, status: 'done' })).rejects.toThrow(/重現步驟/);
    await expect(svc.submit({ taskId: 'tsk_a', report: '## 重現步驟\n1. x\n## 證據\nlog', status: 'done' })).resolves.toBeTruthy();
  });

  it('rejects reports on finished tasks', async () => {
    const { svc } = setup({ status: 'done' });
    await expect(svc.submit({ taskId: 'tsk_a', report, status: 'done' })).rejects.toThrow(/is done/);
  });
});

describe('DeliverableService.runOutcome', () => {
  it('a report from before the run started does not count', async () => {
    const { svc } = setup();
    await svc.submit({ taskId: 'tsk_a', report, status: 'partial' });
    const later = new Date(Date.now() + 60_000).toISOString();
    expect(await svc.runOutcome({ id: 'tsk_a' }, later)).toBe('missing');
    expect(await svc.runOutcome({ id: 'tsk_a' }, new Date(0).toISOString())).toMatchObject({ status: 'partial' });
    expect(await svc.runOutcome({ id: 'tsk_b' }, new Date(0).toISOString())).toBe('missing');
  });
});

describe('DeliverableService.upstreamFor', () => {
  it('gives the reports of dependencies, cut to 1500 characters', async () => {
    const { svc, taskStore } = setup();
    await taskStore.save(makeTask({ id: 'tsk_b', title: 'B', status: 'in_progress', depends_on: ['tsk_a', 'tsk_x'] }));
    await svc.submit({ taskId: 'tsk_a', report: `${report}\n${'x'.repeat(3000)}`, status: 'done' });
    const up = await svc.upstreamFor((await taskStore.get('tsk_b'))!);
    expect(up).toHaveLength(1);
    expect(up[0]).toMatchObject({ task_id: 'tsk_a', status: 'done' });
    expect(up[0]!.report).toMatch(/cut; full report: orch task show tsk_a/);
    expect(up[0]!.report.length).toBeLessThan(1600);
  });
});
