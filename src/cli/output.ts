/**
 * Terminal output helpers.
 *
 * All formatting, icons, colors go through this module.
 * Respects NO_COLOR, --ascii, --json, --quiet flags.
 */

import chalk from 'chalk';
import type { TaskStatus } from '../domain/task.js';
import type { AgentStatus } from '../domain/agent.js';
import { textDisplayWidth } from '../tui/text-cursor.js';

// Unicode icons
export const icons = {
  running: '●',
  todo: '○',
  review: '◈',
  waiting_decision: '◇',
  done: '✓',
  failed: '✕',
  retrying: '↻',
  cancelled: '○',
  idle: '○',
  error: '✕',
  disabled: '─',
  agentAction: '▸',
  orchestratorEvent: '→',
  warning: '⚠',
} as const;

// ASCII fallback
const asciiIcons: Record<keyof typeof icons, string> = {
  running: '*',
  todo: 'o',
  review: '#',
  waiting_decision: '?',
  done: '+',
  failed: 'x',
  retrying: '~',
  cancelled: 'o',
  idle: 'o',
  error: 'x',
  disabled: '-',
  agentAction: '>',
  orchestratorEvent: '->',
  warning: '!!',
};

// ANSI 256 colors from CLI_UI_DESIGN.md — lazy-initialized on first access
const COLOR_CODES = {
  amber: 214,
  green: 72,
  red: 167,
  blue: 74,
  yellow: 178,
  dim: 240,
  ghost: 236,
  white: 255,
  purple: 141,
} as const;

type ColorName = keyof typeof COLOR_CODES;
type ChalkFn = ReturnType<typeof chalk.ansi256>;

let _colors: Record<ColorName, ChalkFn> | undefined;

function getColors(): Record<ColorName, ChalkFn> {
  if (!_colors) {
    _colors = {} as Record<ColorName, ChalkFn>;
    for (const [name, code] of Object.entries(COLOR_CODES)) {
      _colors[name as ColorName] = chalk.ansi256(code);
    }
  }
  return _colors;
}

const colors = new Proxy({} as Record<ColorName, ChalkFn>, {
  get(_target, prop: string) {
    return getColors()[prop as ColorName];
  },
});

let useAscii = false;

export function setAsciiMode(ascii: boolean): void {
  useAscii = ascii;
}

export function setNoColor(noColor: boolean): void {
  if (noColor) {
    chalk.level = 0;
  }
}

export function getIcon(name: keyof typeof icons): string {
  return useAscii ? asciiIcons[name] : icons[name];
}

export function statusIcon(status: TaskStatus | AgentStatus): string {
  const icon = getIcon(status as keyof typeof icons);
  switch (status) {
    case 'running':
    case 'in_progress':
      return colors.green(getIcon('running'));
    case 'todo':
      return colors.dim(getIcon('todo'));
    case 'review':
      return colors.blue(getIcon('review'));
    case 'waiting_decision':
      return colors.amber(getIcon('waiting_decision'));
    case 'done':
      return colors.green(getIcon('done'));
    case 'failed':
      return colors.red(getIcon('failed'));
    case 'retrying':
      return colors.yellow(getIcon('retrying'));
    case 'cancelled':
      return colors.dim(getIcon('cancelled'));
    case 'idle':
      return colors.dim(getIcon('idle'));
    case 'error':
      return colors.red(getIcon('error'));
    case 'disabled':
      return colors.ghost(getIcon('disabled'));
    default:
      return icon;
  }
}

export function priorityLabel(priority: number): string {
  switch (priority) {
    case 1:
      return colors.red('P1');
    case 2:
      return colors.yellow('P2');
    case 3:
      return 'P3';
    case 4:
      return colors.dim('P4');
    default:
      return `P${priority}`;
  }
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}:${String(secs).padStart(2, '0')}`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h${String(mins).padStart(2, '0')}m`;
}

export function formatDurationSince(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  return formatDuration(ms);
}

export function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function printError(message: string, hint?: string): void {
  console.error(`  ${colors.red(getIcon('failed'))} ${message}`);
  if (hint) {
    console.error(`    ${hint}`);
  }
}

export function printSuccess(message: string): void {
  console.log(`  ${colors.green(getIcon('done'))} ${message}`);
}

export function printWarning(message: string): void {
  console.log(`  ${colors.yellow(getIcon('warning'))} ${message}`);
}

export function printTable(
  headers: string[],
  rows: string[][],
  padding: number = 2,
): void {
  const colWidths = headers.map((h, i) =>
    Math.max(textDisplayWidth(h), ...rows.map((r) => textDisplayWidth(stripAnsi(r[i] ?? '')))),
  );

  const lines: string[] = [];

  const headerLine = headers
    .map((h, i) => h + ' '.repeat(Math.max(0, colWidths[i]! + padding - textDisplayWidth(h))))
    .join('');
  lines.push(`  ${colors.dim(headerLine)}`);

  for (const row of rows) {
    const line = row
      .map((cell, i) => {
        const stripped = stripAnsi(cell);
        const pad = (colWidths[i] ?? 0) + padding - textDisplayWidth(stripped);
        return cell + ' '.repeat(Math.max(0, pad));
      })
      .join('');
    lines.push(`  ${line}`);
  }

  process.stdout.write(lines.join('\n') + '\n');
}

export function printKeyValue(pairs: Array<[string, string]>): void {
  const maxKey = Math.max(...pairs.map(([k]) => textDisplayWidth(k)));
  const lines = pairs.map(([key, value]) =>
    `  ${colors.dim(key + ' '.repeat(maxKey + 2 - textDisplayWidth(key)))}${value}`,
  );
  process.stdout.write(lines.join('\n') + '\n');
}

export function filePath(p: string): string {
  return colors.purple(p);
}

export function agentName(name: string): string {
  return colors.green(name);
}

export function amber(text: string): string {
  return colors.amber(text);
}

export function dim(text: string): string {
  return colors.dim(text);
}

/** Cut text to at most `max` terminal columns (CJK counts as 2), ending with … when cut. */
export function truncateToWidth(text: string, max: number): string {
  if (textDisplayWidth(text) <= max) return text;
  let out = '';
  let w = 0;
  for (const ch of text) {
    const cw = textDisplayWidth(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

// Simple ANSI strip
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}
