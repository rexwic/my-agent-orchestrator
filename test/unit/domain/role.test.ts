import { describe, it, expect } from 'vitest';
import { validateRole, roleAgentConfig, roleAgentIndex, roleAgentName } from '../../../src/domain/role.js';
import { findDependencyCycles } from '../../../src/domain/transitions.js';
import { DEFAULT_CONFIG } from '../../../src/domain/config.js';
import { InvalidArgumentsError } from '../../../src/domain/errors.js';
import type { Task } from '../../../src/domain/task.js';

describe('validateRole', () => {
  it('accepts a full role and normalises it', () => {
    const role = validateRole({
      name: 'backend',
      description: ' Spring Boot backend ',
      adapter: 'claude',
      model: 'sonnet',
      effort: 'high',
      replicas: 2,
      skills: ['review', ' careful '],
      env: { ANTHROPIC_API_KEY: 'sk' },
      approval_policy: 'manual',
      workspace_mode: 'worktree',
      task_defaults: { review_criteria: ['test_pass'], max_attempts: 2 },
    });
    expect(role).toMatchObject({
      name: 'backend',
      description: 'Spring Boot backend',
      replicas: 2,
      skills: ['review', 'careful'],
      task_defaults: { review_criteria: ['test_pass'], max_attempts: 2 },
    });
  });

  it('defaults replicas to 1', () => {
    expect(validateRole({ name: 'qa', adapter: 'codex' }).replicas).toBe(1);
  });

  it('reports every problem at once', () => {
    const err = (() => {
      try {
        validateRole({ name: 'Back End', effort: 'extreme', replicas: -1, task_defaults: { review_criteria: ['unit'] } });
      } catch (e) { return e as Error; }
      return null;
    })();
    expect(err).toBeInstanceOf(InvalidArgumentsError);
    expect(err!.message).toMatch(/name "Back End"/);
    expect(err!.message).toMatch(/adapter is required/);
    expect(err!.message).toMatch(/effort must be one of/);
    expect(err!.message).toMatch(/replicas must be a non-negative integer/);
    expect(err!.message).toMatch(/review_criteria/);
  });

  it('requires the name to match its file name', () => {
    expect(() => validateRole({ name: 'qa', adapter: 'claude' }, 'backend')).toThrow(/does not match file name/);
  });

  it('requires a command for shell roles and caps replicas', () => {
    expect(() => validateRole({ name: 'build', adapter: 'shell' })).toThrow(/require a command/);
    expect(() => validateRole({ name: 'big', adapter: 'claude', replicas: 50 })).toThrow(/at most/);
  });
});

describe('roleAgentConfig', () => {
  const defaults = DEFAULT_CONFIG.defaults.agent;

  it('maps role settings onto agent config, filling project defaults', () => {
    const config = roleAgentConfig(
      validateRole({ name: 'backend', adapter: 'claude', model: 'sonnet', effort: 'high', workspace_mode: 'worktree', quota_group: 'team' }),
      defaults,
    );
    expect(config).toEqual({
      approval_policy: defaults.approval_policy,
      max_turns: defaults.max_turns,
      timeout_ms: defaults.timeout_ms,
      stall_timeout_ms: defaults.stall_timeout_ms,
      model: 'sonnet',
      effort: 'high',
      workspace_mode: 'worktree',
      quota_group: 'team',
    });
  });

  it('ignores model/effort for shell roles', () => {
    const config = roleAgentConfig(validateRole({ name: 'build', adapter: 'shell', command: 'mvn -q verify', model: 'x' }), defaults);
    expect(config.command).toBe('mvn -q verify');
    expect(config.model).toBeUndefined();
    expect(config.approval_policy).toBe('auto');
  });
});

describe('role agent names', () => {
  it('round-trips instance names', () => {
    expect(roleAgentName('backend', 2)).toBe('backend-2');
    expect(roleAgentIndex('backend', 'backend-2')).toBe(2);
    expect(roleAgentIndex('backend', 'backend-x')).toBeNull();
    expect(roleAgentIndex('backend', 'frontend-1')).toBeNull();
  });
});

describe('findDependencyCycles', () => {
  const t = (id: string, deps: string[] = []) => ({ id, depends_on: deps }) as Task;

  it('finds no cycle in a DAG', () => {
    expect(findDependencyCycles([t('a'), t('b', ['a']), t('c', ['a', 'b'])])).toEqual([]);
  });

  it('finds a two-task cycle once', () => {
    const cycles = findDependencyCycles([t('a', ['b']), t('b', ['a'])]);
    expect(cycles).toHaveLength(1);
    expect([...cycles[0]!].sort()).toEqual(['a', 'b']);
  });

  it('finds a self-dependency and a longer cycle, ignoring missing deps', () => {
    const cycles = findDependencyCycles([t('s', ['s']), t('x', ['y']), t('y', ['z']), t('z', ['x', 'gone'])]);
    expect(cycles.map((c) => [...c].sort().join(','))).toEqual(['s', 'x,y,z']);
  });
});
