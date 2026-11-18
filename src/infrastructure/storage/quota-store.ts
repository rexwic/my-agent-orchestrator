/**
 * Usage-limit pauses, persisted in .orchestry/quota.json.
 *
 * Kept out of state.json on purpose: the orchestrator rewrites state.json from
 * memory, so a CLI `orch agent resume` would be overwritten while `orch serve`
 * runs. The orchestrator re-reads this file every tick instead.
 */

import type { QuotaPause, QuotaState } from '../../domain/quota.js';
import type { IQuotaStore } from './interfaces.js';
import type { Paths } from './paths.js';
import { readJson, writeJson } from './fs-utils.js';

export class QuotaStore implements IQuotaStore {
  constructor(private readonly paths: Paths) {}

  async read(): Promise<QuotaState> {
    let raw: unknown;
    try {
      raw = await readJson<unknown>(this.paths.quotaPath);
    } catch {
      return {}; // corrupt file → no pauses (fail open, the next limit hit re-pauses)
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

    const state: QuotaState = {};
    for (const [group, value] of Object.entries(raw as Record<string, unknown>)) {
      const pause = value as Partial<QuotaPause> | null;
      if (!pause || typeof pause.until !== 'string' || Number.isNaN(Date.parse(pause.until))) continue;
      state[group] = {
        until: pause.until,
        since: typeof pause.since === 'string' ? pause.since : pause.until,
        reason: typeof pause.reason === 'string' ? pause.reason : '',
        strikes: typeof pause.strikes === 'number' ? pause.strikes : 0,
        reset_known: pause.reset_known === true,
        ...(typeof pause.agent_id === 'string' ? { agent_id: pause.agent_id } : {}),
        ...(pause.resumed === true ? { resumed: true } : {}),
      };
    }
    return state;
  }

  async write(state: QuotaState): Promise<void> {
    await writeJson(this.paths.quotaPath, state);
  }
}

/** In-memory store (tests, embedding without a project directory). */
export class MemoryQuotaStore implements IQuotaStore {
  private state: QuotaState = {};

  async read(): Promise<QuotaState> {
    return structuredClone(this.state);
  }

  async write(state: QuotaState): Promise<void> {
    this.state = structuredClone(state);
  }
}
