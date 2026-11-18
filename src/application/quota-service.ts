/**
 * QuotaService — pauses a quota group (an account: a CLI login or an API key)
 * when one of its agents hits a usage limit, and resumes it automatically
 * once the provider's reset time has passed.
 *
 * State lives in .orchestry/quota.json (IQuotaStore) so the CLI can resume a
 * group early while `orch serve` is running.
 */

import { createHash } from 'node:crypto';
import type { Agent } from '../domain/agent.js';
import {
  computePauseUntil,
  quotaGroupOf,
  type QuotaPause,
  type QuotaState,
} from '../domain/quota.js';
import type { IQuotaStore } from '../infrastructure/storage/interfaces.js';
import type { EventBus } from './event-bus.js';

export interface LimitHit {
  agent: Agent;
  taskId: string;
  /** Provider message (trimmed for storage). */
  message: string;
  /** Provider reset time, when known. */
  resetAt?: Date;
}

const shortHash = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 12);

export class QuotaService {
  constructor(
    private readonly store: IQuotaStore,
    private readonly eventBus: EventBus,
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Quota group of an agent (see domain/quota.ts). */
  groupOf(agent: Pick<Agent, 'adapter' | 'config'>): string {
    return quotaGroupOf(agent, this.env, shortHash);
  }

  /**
   * Current pauses, after lifting the expired ones (emits `quota:resumed`).
   * Expired records with strikes are kept (not paused) so a repeated hit backs off further.
   */
  async activePauses(): Promise<QuotaState> {
    const state = await this.store.read();
    const nowMs = this.now().getTime();
    const active: QuotaState = {};
    let changed = false;

    for (const [group, pause] of Object.entries(state)) {
      if (Date.parse(pause.until) > nowMs) {
        active[group] = pause;
      } else if (!pause.resumed) {
        changed = true;
        this.eventBus.emit({ type: 'quota:resumed', group, manual: false });
        state[group] = { ...pause, resumed: true };
      }
    }

    if (changed) await this.store.write(state);
    return active;
  }

  /** Current pauses without lifting expired ones or writing anything (for display). */
  async currentPauses(): Promise<QuotaState> {
    const state = await this.store.read();
    const nowMs = this.now().getTime();
    return Object.fromEntries(Object.entries(state).filter(([, p]) => Date.parse(p.until) > nowMs));
  }

  /** Whether an agent's quota group is currently paused, given `activePauses()`. */
  isPaused(agent: Pick<Agent, 'adapter' | 'config'>, active: QuotaState): boolean {
    return this.groupOf(agent) in active;
  }

  /** Pause the agent's quota group after a usage-limit failure. */
  async recordLimitHit(hit: LimitHit): Promise<{ group: string; pause: QuotaPause }> {
    const group = this.groupOf(hit.agent);
    const state = await this.store.read();
    const now = this.now();
    const previous = state[group];
    // A hit within a still-active pause (another agent's in-flight run) is not a new strike.
    const stillPaused = previous !== undefined && Date.parse(previous.until) > now.getTime();
    const strikes = previous ? (stillPaused ? previous.strikes : previous.strikes + 1) : 0;
    let { until, resetKnown } = computePauseUntil(hit.resetAt, strikes, now);
    if (stillPaused && Date.parse(previous.until) >= until.getTime()) {
      // Never shorten an active pause.
      until = new Date(previous.until);
      resetKnown = previous.reset_known;
    }

    const pause: QuotaPause = {
      until: until.toISOString(),
      since: stillPaused ? previous.since : now.toISOString(),
      reason: hit.message.replace(/\s+/g, ' ').trim().slice(0, 300),
      strikes,
      reset_known: resetKnown,
      agent_id: hit.agent.id,
    };
    state[group] = pause;
    await this.store.write(state);

    this.eventBus.emit({
      type: 'quota:paused',
      group,
      agentId: hit.agent.id,
      taskId: hit.taskId,
      until: pause.until,
      resetKnown,
      reason: pause.reason,
    });
    return { group, pause };
  }

  /** A run in this group succeeded — forget its limit history. */
  async recordSuccess(agent: Pick<Agent, 'adapter' | 'config'>): Promise<void> {
    const group = this.groupOf(agent);
    const state = await this.store.read();
    const pause = state[group];
    if (!pause || Date.parse(pause.until) > this.now().getTime()) return;
    delete state[group];
    await this.store.write(state);
  }

  /**
   * Resume a paused group now. Accepts a group name or an agent (its group).
   * Returns the group, or null if it was not paused.
   */
  async resume(target: string | Pick<Agent, 'adapter' | 'config'>): Promise<string | null> {
    const group = typeof target === 'string' ? target : this.groupOf(target);
    const state = await this.store.read();
    const pause = state[group];
    if (!pause || Date.parse(pause.until) <= this.now().getTime()) return null;
    // Keep strikes so an immediate repeat hit still backs off.
    state[group] = { ...pause, until: this.now().toISOString(), resumed: true };
    await this.store.write(state);
    this.eventBus.emit({ type: 'quota:resumed', group, manual: true });
    return group;
  }
}
