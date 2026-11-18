import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { QuotaService } from '../../../src/application/quota-service.js';
import { EventBus } from '../../../src/application/event-bus.js';
import { MemoryQuotaStore, QuotaStore } from '../../../src/infrastructure/storage/quota-store.js';
import { Paths } from '../../../src/infrastructure/storage/paths.js';
import { FALLBACK_PAUSE_MS, RESET_MARGIN_MS } from '../../../src/domain/quota.js';
import { makeAgent } from './helpers.js';

function setup(env: Record<string, string> = {}) {
  let now = new Date('2026-11-18T10:00:00Z');
  const store = new MemoryQuotaStore();
  const eventBus = new EventBus();
  const events: any[] = [];
  eventBus.onAny((e: any) => events.push(e));
  const service = new QuotaService(store, eventBus, env, () => now);
  return { service, store, events, advance: (ms: number) => { now = new Date(now.getTime() + ms); }, now: () => now };
}

const claudeA = makeAgent({ id: 'agt_a', name: 'be', adapter: 'claude' });
const claudeB = makeAgent({ id: 'agt_b', name: 'qa', adapter: 'claude' });
const claudeKey = makeAgent({ id: 'agt_k', name: 'api', adapter: 'claude', config: { ...claudeA.config, env: { ANTHROPIC_API_KEY: 'sk-1' } } });
const codex = makeAgent({ id: 'agt_c', name: 'fe', adapter: 'codex' });

describe('QuotaService', () => {
  it('pauses the whole account: every agent on the same login, not other accounts', async () => {
    const { service, events } = setup();
    const reset = new Date('2026-11-18T15:00:00Z');

    const { group, pause } = await service.recordLimitHit({ agent: claudeA, taskId: 'tsk_1', message: '5-hour limit reached', resetAt: reset });

    expect(group).toBe('claude:subscription');
    expect(pause).toMatchObject({ strikes: 0, reset_known: true, agent_id: 'agt_a', until: new Date(reset.getTime() + RESET_MARGIN_MS).toISOString() });
    const active = await service.activePauses();
    expect(service.isPaused(claudeA, active)).toBe(true);
    expect(service.isPaused(claudeB, active)).toBe(true);    // same subscription
    expect(service.isPaused(claudeKey, active)).toBe(false); // API key = separate account
    expect(service.isPaused(codex, active)).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: 'quota:paused', group, agentId: 'agt_a', taskId: 'tsk_1', resetKnown: true }));
  });

  it('never stores the API key itself', async () => {
    const { service, store } = setup();
    await service.recordLimitHit({ agent: claudeKey, taskId: 't', message: 'limit' });
    expect(JSON.stringify(await store.read())).not.toContain('sk-1');
  });

  it('resumes automatically once the pause expires, emitting quota:resumed once', async () => {
    const { service, events, advance } = setup();
    await service.recordLimitHit({ agent: claudeA, taskId: 't', message: 'limit' }); // fallback 15 min

    advance(FALLBACK_PAUSE_MS - 1_000);
    expect(service.isPaused(claudeA, await service.activePauses())).toBe(true);

    advance(2_000);
    expect(service.isPaused(claudeA, await service.activePauses())).toBe(false);
    await service.activePauses();
    expect(events.filter((e) => e.type === 'quota:resumed')).toEqual([{ type: 'quota:resumed', group: 'claude:subscription', manual: false }]);
  });

  it('backs off further on repeated hits without a success, and resets after a success', async () => {
    const { service, advance, now } = setup();
    await service.recordLimitHit({ agent: claudeA, taskId: 't', message: 'limit' });
    advance(FALLBACK_PAUSE_MS + 1);
    await service.activePauses();

    const second = await service.recordLimitHit({ agent: claudeA, taskId: 't', message: 'limit' });
    expect(second.pause.strikes).toBe(1);
    expect(Date.parse(second.pause.until) - now().getTime()).toBe(2 * FALLBACK_PAUSE_MS);

    advance(2 * FALLBACK_PAUSE_MS + 1);
    await service.recordSuccess(claudeB); // same group
    const third = await service.recordLimitHit({ agent: claudeA, taskId: 't', message: 'limit' });
    expect(third.pause.strikes).toBe(0);
  });

  it('a second hit during an active pause neither adds a strike nor shortens the pause', async () => {
    const { service } = setup();
    const reset = new Date('2026-11-18T15:00:00Z');
    const first = await service.recordLimitHit({ agent: claudeA, taskId: 't1', message: 'limit', resetAt: reset });

    const second = await service.recordLimitHit({ agent: claudeB, taskId: 't2', message: 'limit' });

    expect(second.pause.strikes).toBe(0);
    expect(second.pause.until).toBe(first.pause.until);
    expect(second.pause.reset_known).toBe(true);
  });

  it('resume() lifts a pause early by agent or group name', async () => {
    const { service, events } = setup();
    await service.recordLimitHit({ agent: claudeA, taskId: 't', message: 'limit' });

    await expect(service.resume(claudeB)).resolves.toBe('claude:subscription');
    expect(service.isPaused(claudeA, await service.activePauses())).toBe(false);
    expect(events).toContainEqual({ type: 'quota:resumed', group: 'claude:subscription', manual: true });
    await expect(service.resume('claude:subscription')).resolves.toBeNull(); // no longer paused
  });

  it('currentPauses() is read-only', async () => {
    const { service, store, advance } = setup();
    await service.recordLimitHit({ agent: claudeA, taskId: 't', message: 'limit' });
    advance(FALLBACK_PAUSE_MS + 1);

    expect(await service.currentPauses()).toEqual({});
    expect((await store.read())['claude:subscription']?.resumed).toBeUndefined();
  });
});

describe('QuotaStore (file)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-quota-'));
    await fs.mkdir(path.join(dir, '.orchestry'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('round-trips pauses and drops malformed entries', async () => {
    const paths = new Paths(dir);
    const store = new QuotaStore(paths);
    expect(await store.read()).toEqual({});

    await store.write({ 'claude:subscription': { until: '2026-11-18T15:01:00.000Z', since: '2026-11-18T10:00:00.000Z', reason: 'limit', strikes: 0, reset_known: true } });
    expect((await store.read())['claude:subscription']?.until).toBe('2026-11-18T15:01:00.000Z');

    await fs.writeFile(paths.quotaPath, JSON.stringify({ good: { until: '2026-11-18T15:00:00Z' }, bad: { until: 'not a date' }, worse: 42 }));
    expect(Object.keys(await store.read())).toEqual(['good']);

    await fs.writeFile(paths.quotaPath, '{ corrupt');
    expect(await store.read()).toEqual({});
  });
});
