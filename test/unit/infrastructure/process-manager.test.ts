import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProcessManager } from '../../../src/infrastructure/process/process-manager.js';
import type { ResolvedCommand } from '../../../src/infrastructure/process/resolve-command.js';
import * as childProcess from 'node:child_process';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, spawn: vi.fn() };
});

const identity = (command: string, args: string[]): ResolvedCommand => ({ command, args, shell: false });

function mockSpawnProc(overrides: Record<string, unknown> = {}) {
  const proc = { pid: 12345, stdout: null, stderr: null, unref: vi.fn(), ...overrides };
  vi.mocked(childProcess.spawn).mockReturnValue(proc as any);
  return proc;
}

function lastSpawnOpts(): childProcess.SpawnOptions | undefined {
  return vi.mocked(childProcess.spawn).mock.calls.at(-1)?.[2] as childProcess.SpawnOptions | undefined;
}

describe('ProcessManager', () => {
  let manager: ProcessManager;

  beforeEach(() => {
    manager = new ProcessManager({ platform: 'linux', resolve: identity });
    vi.clearAllMocks();
  });

  describe('spawn', () => {
    it('calls proc.unref() after detached spawn to allow parent exit', () => {
      const proc = mockSpawnProc();

      manager.spawn('echo', ['hello']);

      expect(proc.unref).toHaveBeenCalledOnce();
    });

    it('spawns with detached:true so process group kill works', () => {
      mockSpawnProc();

      manager.spawn('echo', ['hello']);

      expect(lastSpawnOpts()?.detached).toBe(true);
    });

    it('throws if process has no pid', () => {
      mockSpawnProc({ pid: undefined });

      expect(() => manager.spawn('bad-cmd', [])).toThrow('Failed to spawn process');
    });

    it('foreground spawns are neither detached nor unref\'d (keeps event loop alive)', () => {
      const proc = mockSpawnProc();

      manager.spawn('git', ['status'], { cwd: '/repo', foreground: true });

      expect(proc.unref).not.toHaveBeenCalled();
      const opts = lastSpawnOpts();
      expect(opts?.detached).toBe(false);
      expect(opts?.cwd).toBe('/repo');
      expect(opts).not.toHaveProperty('foreground');
    });

    it('spawns the resolved command and enables the shell only when required', () => {
      mockSpawnProc();
      const pm = new ProcessManager({
        platform: 'win32',
        resolve: () => ({ command: 'C:\\proj\\mvnw.cmd', args: ['test'], shell: true }),
      });

      pm.spawn('mvnw', ['test']);

      const call = vi.mocked(childProcess.spawn).mock.calls.at(-1)!;
      expect(call[0]).toBe('C:\\proj\\mvnw.cmd');
      expect(call[1]).toEqual(['test']);
      expect((call[2] as childProcess.SpawnOptions).shell).toBe(true);
    });

    it('on Windows does not detach (would open a console window) and hides windows', () => {
      const proc = mockSpawnProc();
      const pm = new ProcessManager({ platform: 'win32', resolve: identity });

      pm.spawn('codex', ['exec']);

      expect(lastSpawnOpts()?.detached).toBe(false);
      expect(lastSpawnOpts()?.windowsHide).toBe(true);
      expect(lastSpawnOpts()?.shell).toBeUndefined();
      expect(proc.unref).toHaveBeenCalledOnce();
    });
  });

  describe('kill', () => {
    let killSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    });

    afterEach(() => {
      killSpy.mockRestore();
    });

    it('kills the process group on POSIX', () => {
      manager.kill(4242, 'SIGTERM');
      expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');
    });

    it('kills only the process itself on Windows (no process groups)', () => {
      const killTree = vi.fn(async () => true);
      const pm = new ProcessManager({ platform: 'win32', resolve: identity, killTree });

      pm.kill(4242, 'SIGKILL');

      expect(killSpy).toHaveBeenCalledWith(4242, 'SIGKILL');
      expect(killSpy).not.toHaveBeenCalledWith(-4242, expect.anything());
      expect(killTree).not.toHaveBeenCalled();
    });

    it('killWithGrace on Windows terminates the whole tree without signalling', async () => {
      let alive = true;
      killSpy.mockImplementation(() => {
        if (!alive) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
        return true;
      });
      const killTree = vi.fn(async () => { alive = false; return true; });
      const pm = new ProcessManager({ platform: 'win32', resolve: identity, killTree });

      await pm.killWithGrace(4242, 1_000);

      expect(killTree).toHaveBeenCalledWith(4242);
      // Only liveness probes (signal 0) — no group kill, no direct kill.
      expect(killSpy.mock.calls.every(([, sig]) => sig === 0)).toBe(true);
    });

    it('killWithGrace on Windows falls back to a direct kill when taskkill fails', async () => {
      const pm = new ProcessManager({ platform: 'win32', resolve: identity, killTree: async () => false });

      await pm.killWithGrace(4242, 0);

      expect(killSpy).toHaveBeenCalledWith(4242, 'SIGTERM');
    });

    it('killWithGrace on Windows force-kills a survivor after the grace period', async () => {
      const killTree = vi.fn(async () => true);
      const pm = new ProcessManager({ platform: 'win32', resolve: identity, killTree });

      await pm.killWithGrace(4242, 0);

      expect(killTree).toHaveBeenCalledOnce();
      expect(killSpy).toHaveBeenCalledWith(4242, 'SIGKILL');
    });

    it('killWithGrace skips already-dead processes', async () => {
      killSpy.mockImplementation(() => {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      });
      const killTree = vi.fn(async () => true);
      const pm = new ProcessManager({ platform: 'win32', resolve: identity, killTree });

      await pm.killWithGrace(4242);

      expect(killTree).not.toHaveBeenCalled();
    });
  });
});
