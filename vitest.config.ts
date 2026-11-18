import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

const isCI = !!process.env['CI'];
const isWindows = process.platform === 'win32';
const maxThreads = isCI ? 2 : Math.max(2, availableParallelism());

const TUI_TESTS = 'test/unit/tui/**/*.test.{ts,tsx}';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'threads',
    maxWorkers: maxThreads,
    // Process spawns and fs work are several times slower on Windows (Defender scanning, no fork).
    testTimeout: isWindows ? 15_000 : 5_000,
    typecheck: {
      tsconfig: 'tsconfig.test.json',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/bin/**', 'src/cli/tui/**'],
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'core',
          include: ['test/**/*.test.{ts,tsx}'],
          exclude: [TUI_TESTS],
        },
      },
      {
        extends: true,
        test: {
          name: 'tui',
          include: [TUI_TESTS],
          // Ink tests assert after fixed render delays (e.g. `await delay(100)`).
          // Windows process/IO overhead under a fully parallel run misses those
          // windows, so on Windows run them one file at a time after the core suite.
          ...(isWindows ? { fileParallelism: false, sequence: { groupOrder: 1 } } : {}),
        },
      },
    ],
  },
  optimizeDeps: {
    include: ['vitest', 'js-yaml', 'nanoid', 'commander'],
  },
});
