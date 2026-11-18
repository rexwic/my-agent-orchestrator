/**
 * Claude Code adapter.
 *
 * Spawns `claude --print --output-format stream-json` in headless mode.
 * Parses JSON-lines from stdout into AgentEvent stream.
 */

import type { IAgentAdapter, AdapterTestResult, ExecuteParams, AgentEvent, ExecuteHandle } from './interface.js';
import type { IProcessManager } from '../process/process-manager.js';
import { extractTokens, createStreamingEvents } from './utils.js';
import { classifyAdapterError, isUsageLimitMessage, AdapterErrorKind } from '../../domain/errors.js';
import { parseResetTime } from '../../domain/quota.js';
import { execCommand } from '../process/resolve-command.js';


export class ClaudeAdapter implements IAgentAdapter {
  readonly kind = 'claude';

  constructor(private readonly processManager: IProcessManager) {}

  async test(): Promise<AdapterTestResult> {
    try {
      const { stdout } = await execCommand('claude', ['--version']);
      return { ok: true, version: stdout.trim() };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: 'Claude Code CLI not found. Install: npm i -g @anthropic-ai/claude-code',
        errorKind: classifyAdapterError(msg),
      };
    }
  }

  execute(params: ExecuteParams): ExecuteHandle {
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--max-turns', String(params.config.max_turns ?? 50),
      '--verbose',
      '--dangerously-skip-permissions', // Agents run autonomously; stdin is 'ignore' so prompts would hang
    ];

    if (params.config.model) {
      args.push('--model', params.config.model);
    }

    if (params.config.effort) {
      args.push('--effort', params.config.effort);
    }

    // System prompt: orchestrator-generated (cacheable) takes priority, then per-agent config
    const effectiveSystemPrompt = params.systemPrompt ?? params.config.system_prompt;
    if (effectiveSystemPrompt) {
      args.push('--system-prompt', effectiveSystemPrompt);
    }

    args.push(params.prompt);

    const { process: proc, pid } = this.processManager.spawn('claude', args, {
      cwd: params.workspace,
      env: { ...process.env, ...params.env },
      signal: params.signal,
    });

    const events = createStreamingEvents(proc, createClaudeEventParser(), 'Claude', params.signal);

    return { pid, events };
  }

  async stop(pid: number): Promise<void> {
    await this.processManager.killWithGrace(pid);
  }
}

/**
 * Claude stream-json parser. Stateful: a `rate_limit_event` with status
 * "rejected" carries the reset time, and the `result` that follows reports the
 * failure (`is_error: true`) — the two are combined into one fatal RATE_LIMIT error.
 */
export function createClaudeEventParser(): (line: string) => AgentEvent | null {
  let rejectedResetAt: string | undefined;
  let limitRejected = false;

  return (line) => {
    if (!line.trim()) return null;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return { type: 'output', timestamp: new Date().toISOString(), data: line };
    }
    const timestamp = new Date().toISOString();

    switch (parsed.type) {
      case 'assistant':
        return { type: 'output', timestamp, data: (parsed.message as unknown) ?? parsed };
      case 'tool_use':
        return { type: 'tool_call', timestamp, data: parsed };
      case 'tool_result':
        return { type: 'output', timestamp, data: parsed };
      case 'error': {
        const errData = (parsed.error as unknown) ?? parsed;
        const errMsg = typeof errData === 'string' ? errData : JSON.stringify(errData);
        const kind = classifyAdapterError(errMsg);
        const resetAt = kind === AdapterErrorKind.RATE_LIMIT ? parseResetTime(errMsg)?.toISOString() : undefined;
        return { type: 'error', timestamp, data: errData, errorKind: kind, ...(resetAt ? { resetAt } : {}) };
      }
      case 'rate_limit_event': {
        const info = parsed.rate_limit_info as Record<string, unknown> | undefined;
        if (info?.status !== 'rejected') return { type: 'output', timestamp, data: parsed };
        limitRejected = true;
        rejectedResetAt = typeof info.resetsAt === 'number' ? new Date(info.resetsAt * 1000).toISOString() : undefined;
        const window = typeof info.rateLimitType === 'string' ? `${info.rateLimitType} ` : '';
        return {
          type: 'error',
          timestamp,
          data: { message: `Claude ${window}usage limit reached${rejectedResetAt ? `, resets at ${rejectedResetAt}` : ''}`, raw: parsed },
          errorKind: AdapterErrorKind.RATE_LIMIT,
          ...(rejectedResetAt ? { resetAt: rejectedResetAt } : {}),
        };
      }
      case 'result': {
        const tokens = extractTokens(parsed, { statsFallback: true });
        if (parsed.is_error !== true) {
          return { type: 'done', timestamp, data: parsed, tokens };
        }
        const message = claudeResultError(parsed);
        const isLimit = limitRejected || parsed.api_error_status === 429 || isUsageLimitMessage(message.toLowerCase());
        const errorKind = isLimit ? AdapterErrorKind.RATE_LIMIT : classifyAdapterError(message);
        const resetAt = isLimit ? (rejectedResetAt ?? parseResetTime(message)?.toISOString()) : undefined;
        return {
          type: 'error',
          timestamp,
          data: { message, raw: parsed },
          tokens,
          errorKind,
          fatal: true,
          ...(resetAt ? { resetAt } : {}),
        };
      }
      default:
        return { type: 'output', timestamp, data: parsed };
    }
  };
}

/** Human-readable reason for a failed Claude `result` (is_error: true). */
function claudeResultError(parsed: Record<string, unknown>): string {
  const subtype = typeof parsed.subtype === 'string' ? parsed.subtype : 'error';
  const text = typeof parsed.result === 'string' ? parsed.result.trim() : '';
  if (text) return subtype === 'success' ? text : `${text} (${subtype})`;
  if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
    return `${parsed.errors.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('; ')} (${subtype})`;
  }
  if (subtype === 'error_max_turns') return 'Claude stopped: reached max turns (error_max_turns)';
  const status = parsed.api_error_status != null ? `, API status ${String(parsed.api_error_status)}` : '';
  return `Claude run failed (${subtype}${status})`;
}
