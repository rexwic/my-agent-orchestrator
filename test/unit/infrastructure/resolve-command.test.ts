import { describe, it, expect } from 'vitest';
import { resolveCommand, type ResolveDeps } from '../../../src/infrastructure/process/resolve-command.js';

const NODE = 'C:\\Program Files\\nodejs\\node.exe';

function winDeps(files: Record<string, string>, env: NodeJS.ProcessEnv = {}): ResolveDeps {
  const lower = new Map(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    platform: 'win32',
    env: { Path: 'C:\\tools;C:\\npm', PATHEXT: '.COM;.EXE;.BAT;.CMD', ...env },
    execPath: NODE,
    isFile: (p) => lower.has(p.toLowerCase()),
    readFile: (p) => {
      const content = lower.get(p.toLowerCase());
      if (content === undefined) throw new Error(`ENOENT ${p}`);
      return content;
    },
  };
}

const MODERN_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*
`;

const LEGACY_SHIM = `@IF EXIST "%~dp0\\node.exe" (
  "%~dp0\\node.exe"  "%~dp0\\..\\lib\\node_modules\\foo\\bin\\foo.js" %*
) ELSE (
  node  "%~dp0\\..\\lib\\node_modules\\foo\\bin\\foo.js" %*
)`;

describe('resolveCommand', () => {
  it('is the identity on non-Windows platforms', () => {
    const deps = { ...winDeps({}), platform: 'darwin' as const };
    expect(resolveCommand('codex', ['exec', '-'], deps)).toEqual({ command: 'codex', args: ['exec', '-'], shell: false });
  });

  it('passes unknown commands through unchanged so spawn reports ENOENT', () => {
    expect(resolveCommand('missing', ['x'], winDeps({}))).toEqual({ command: 'missing', args: ['x'], shell: false });
  });

  it('keeps the bare name for .exe files on PATH', () => {
    const deps = winDeps({ 'C:\\tools\\claude.exe': '' });
    expect(resolveCommand('claude', ['--version'], deps)).toEqual({ command: 'claude', args: ['--version'], shell: false });
  });

  it('runs npm .cmd shims through node directly, without cmd.exe', () => {
    const deps = winDeps({ 'C:\\npm\\codex.cmd': MODERN_SHIM });
    const r = resolveCommand('codex', ['exec', '--json', '-'], deps);
    expect(r).toEqual({
      command: NODE,
      args: ['C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js', 'exec', '--json', '-'],
      shell: false,
    });
  });

  it('keeps multi-line prompts intact for npm shims (no shell quoting)', () => {
    const deps = winDeps({ 'C:\\npm\\opencode.cmd': MODERN_SHIM });
    const prompt = 'line 1\nline "2" with %PATH% & stuff';
    expect(resolveCommand('opencode', ['run', prompt], deps).args.at(-1)).toBe(prompt);
  });

  it('prefers node.exe next to the shim, like cmd-shim does', () => {
    const deps = winDeps({ 'C:\\npm\\codex.cmd': MODERN_SHIM, 'C:\\npm\\node.exe': '' });
    expect(resolveCommand('codex', [], deps).command).toBe('C:\\npm\\node.exe');
  });

  it('parses legacy %~dp0 shims', () => {
    const deps = winDeps({ 'C:\\npm\\foo.cmd': LEGACY_SHIM });
    expect(resolveCommand('foo', ['a'], deps)).toEqual({
      command: NODE,
      args: ['C:\\lib\\node_modules\\foo\\bin\\foo.js', 'a'],
      shell: false,
    });
  });

  it('spawns a native target directly when the shim points at an .exe', () => {
    const deps = winDeps({ 'C:\\npm\\tool.cmd': '"%dp0%\\node_modules\\tool\\bin\\tool.exe" %*' });
    expect(resolveCommand('tool', ['x'], deps)).toEqual({
      command: 'C:\\npm\\node_modules\\tool\\bin\\tool.exe',
      args: ['x'],
      shell: false,
    });
  });

  it('honours PATH order and PATHEXT order', () => {
    const deps = winDeps({ 'C:\\tools\\git.cmd': '@echo off', 'C:\\tools\\git.exe': '', 'C:\\npm\\git.exe': '' });
    // .EXE comes before .CMD in PATHEXT
    expect(resolveCommand('git', [], deps).command).toBe('git');
  });

  it('reads Path/PATHEXT case-insensitively', () => {
    const deps = winDeps({ 'D:\\bin\\agy.cmd': MODERN_SHIM }, { Path: undefined, PATH: 'D:\\bin', pathext: '.CMD' });
    expect(resolveCommand('agy', [], deps).command).toBe(NODE);
  });

  it('falls back to the shell for other batch files, quoting arguments', () => {
    const deps = winDeps({ 'C:\\tools\\mvnw.cmd': '@echo off\r\njava -jar wrapper.jar %*' });
    expect(resolveCommand('mvnw', ['-q', 'test', 'a b', 'x&y', ''], deps)).toEqual({
      command: 'C:\\tools\\mvnw.cmd',
      args: ['-q', 'test', '"a b"', '"x&y"', '""'],
      shell: true,
    });
  });

  it('quotes a batch file path that contains spaces', () => {
    const deps = winDeps({ 'C:\\Program Files\\x\\run.bat': '@echo off' }, { Path: 'C:\\Program Files\\x' });
    expect(resolveCommand('run', [], deps).command).toBe('"C:\\Program Files\\x\\run.bat"');
  });

  it.each([['has "quote"'], ['50%'], ['two\nlines']])('rejects %j for shell batch files', (arg) => {
    const deps = winDeps({ 'C:\\tools\\mvnw.cmd': '@echo off' });
    expect(() => resolveCommand('mvnw', [arg], deps)).toThrow(/cmd\.exe/);
  });

  it('resolves explicit paths without searching PATH', () => {
    const deps = winDeps({ 'C:\\proj\\mvnw.cmd': '@echo off' });
    expect(resolveCommand('C:\\proj\\mvnw', ['test'], deps)).toEqual({
      command: 'C:\\proj\\mvnw.cmd',
      args: ['test'],
      shell: true,
    });
  });
});
