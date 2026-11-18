/**
 * Antigravity CLI adapter (`agy`) — Google's agent CLI; runs Gemini (and other) models
 * with the user's Google subscription.
 *
 * Spawns `agy -p <prompt> --output-format stream-json`. Events:
 *   {"event":"init", ...}
 *   {"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE"|"DONE","step_type":"agent_response","text_delta":"…","usage":{…}}}
 *   {"event":"result","result":{"status":"SUCCESS"|"ERROR","response":"…","error":"…","usage":{…}}}
 *
 * Plain-text lines (older agy without stream-json) are still streamed as output,
 * with a `done` event after a clean exit.
 */

import type { IAgentAdapter, AdapterTestResult, ExecuteParams, AgentEvent, ExecuteHandle } from './interface.js';
import type { IProcessManager } from '../process/process-manager.js';
import { buildFullPrompt, createStreamingEvents } from './utils.js';
import { createTokenUsage, type TokenUsage } from '../../domain/run.js';
import { AdapterErrorKind, classifyAdapterError } from '../../domain/errors.js';
import { parseResetTime } from '../../domain/quota.js';
import { execCommand } from '../process/resolve-command.js';

/**
 * Windows limits a whole command line to 32,767 characters and the prompt is
 * passed as an argument (agy's stdin protocol is undocumented), so fail clearly
 * instead of letting CreateProcess reject it.
 */
const WINDOWS_MAX_PROMPT_CHARS = 30_000;

export class AntigravityAdapter implements IAgentAdapter {
  readonly kind = 'antigravity';

  constructor(private readonly processManager: IProcessManager) {}

  async test(): Promise<AdapterTestResult> {
    try {
      const { stdout } = await execCommand('agy', ['--version']);
      return { ok: true, version: stdout.trim() };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: 'Antigravity CLI not found. Install Google Antigravity CLI and ensure `agy` is on PATH.',
        errorKind: classifyAdapterError(msg),
      };
    }
  }

  execute(params: ExecuteParams): ExecuteHandle {
    const prompt = buildFullPrompt(params.systemPrompt ?? params.config.system_prompt, params.prompt);
    if (process.platform === 'win32' && prompt.length > WINDOWS_MAX_PROMPT_CHARS) {
      throw Object.assign(
        new Error(
          `Antigravity prompt is ${prompt.length} characters; Windows command lines are limited to ~32K. ` +
          'Shorten the task description, system prompt or skills for this agent.',
        ),
        { errorKind: AdapterErrorKind.SPAWN_FAILED },
      );
    }

    const args = ['-p', prompt, '--output-format', 'stream-json', '--dangerously-skip-permissions'];
    if (params.config.model) {
      args.push('--model', params.config.model);
    }
    if (params.config.effort) {
      args.push('--effort', params.config.effort);
    }

    const { process: proc, pid } = this.processManager.spawn('agy', args, {
      cwd: params.workspace,
      env: { ...process.env, ...params.env },
      signal: params.signal,
    });

    const parser = createAntigravityParser();
    const inner = createStreamingEvents(proc, parser.parse, 'Antigravity', params.signal);
    return { pid, events: withPlainTextDone(inner, parser, params.signal) };
  }

  async stop(pid: number): Promise<void> {
    await this.processManager.killWithGrace(pid);
  }
}

interface AntigravityParser {
  parse(line: string): AgentEvent | null;
  /** A `result` event (success or error) was seen. */
  readonly sawResult: boolean;
  /** Plain-text output collected from non-JSON lines. */
  readonly plainText: string;
}

/** If agy produced no `result` event (plain-text mode) emit `done` after a clean exit. */
async function* withPlainTextDone(
  inner: AsyncGenerator<AgentEvent>,
  parser: AntigravityParser,
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent> {
  yield* inner;
  if (!parser.sawResult && !signal?.aborted) {
    yield { type: 'done', timestamp: new Date().toISOString(), data: { result: parser.plainText } };
  }
}

export function createAntigravityParser(): AntigravityParser {
  const responseText = new Map<number, string>();
  let sawResult = false;
  let plainText = '';

  const parse = (line: string): AgentEvent | null => {
    if (!line.trim()) return null;
    const timestamp = new Date().toISOString();

    let parsed: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an event');
      parsed = value as Record<string, unknown>;
    } catch {
      plainText += plainText ? `\n${line}` : line;
      return { type: 'output', timestamp, data: { text: line } };
    }

    switch (parsed.event) {
      case 'init':
        return null;

      case 'step_update': {
        const step = (parsed.step_update ?? {}) as Record<string, unknown>;
        const index = typeof step.step_index === 'number' ? step.step_index : -1;
        const stepType = typeof step.step_type === 'string' ? step.step_type : '';
        if (stepType === 'user_input') return null;

        if (stepType === 'agent_response') {
          const delta = typeof step.text_delta === 'string' ? step.text_delta : '';
          if (delta) responseText.set(index, (responseText.get(index) ?? '') + delta);
          if (step.state !== 'DONE') return null;
          const text = (responseText.get(index) ?? '').trim();
          responseText.delete(index);
          return text ? { type: 'output', timestamp, data: { text, raw: step } } : null;
        }

        // Tool and other steps: report once, when finished.
        return step.state === 'DONE' && stepType
          ? { type: 'tool_call', timestamp, data: { name: stepType, raw: step } }
          : null;
      }

      case 'result': {
        sawResult = true;
        const result = (parsed.result ?? {}) as Record<string, unknown>;
        const tokens = antigravityTokens(result.usage);
        if (result.status === 'SUCCESS') {
          const response = typeof result.response === 'string' ? result.response.trim() : '';
          return { type: 'done', timestamp, data: { result: response, raw: result }, ...(tokens ? { tokens } : {}) };
        }
        const message = typeof result.error === 'string' && result.error.trim()
          ? result.error.trim()
          : `Antigravity run ended with status ${String(result.status ?? 'unknown')}`;
        const errorKind = classifyAdapterError(message);
        const resetAt = errorKind === AdapterErrorKind.RATE_LIMIT ? parseResetTime(message)?.toISOString() : undefined;
        return {
          type: 'error',
          timestamp,
          data: { message, raw: result },
          errorKind,
          fatal: true,
          ...(tokens ? { tokens } : {}),
          ...(resetAt ? { resetAt } : {}),
        };
      }

      default:
        return null;
    }
  };

  return {
    parse,
    get sawResult() { return sawResult; },
    get plainText() { return plainText; },
  };
}

function antigravityTokens(usage: unknown): TokenUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return createTokenUsage(num(u.input_tokens), num(u.output_tokens), {
    reasoning: num(u.thinking_tokens),
    cache_read: num(u.cache_read_tokens),
  });
}
