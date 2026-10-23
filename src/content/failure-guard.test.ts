import { describe, expect, it, vi } from 'vitest';
import { FailureGuard } from './failure-guard';

describe('FailureGuard', () => {
  it('trips after three failures in the window and fires once', () => {
    let clock = 0;
    const onFailSafe = vi.fn();
    const guard = new FailureGuard({ onFailSafe, now: () => clock });
    const boom = () => {
      throw new Error('boom');
    };
    guard.run('a', boom);
    guard.run('b', boom);
    expect(guard.isTripped).toBe(false);
    guard.run('c', boom);
    expect(guard.isTripped).toBe(true);
    expect(onFailSafe).toHaveBeenCalledTimes(1);
    guard.run('d', boom);
    expect(onFailSafe).toHaveBeenCalledTimes(1);
  });

  it('resets the failure count outside the window', () => {
    let clock = 0;
    const onFailSafe = vi.fn();
    const guard = new FailureGuard({ onFailSafe, maxFailures: 2, windowMs: 1000, now: () => clock });
    guard.run('a', () => {
      throw new Error('x');
    });
    clock = 5000;
    guard.run('b', () => {
      throw new Error('x');
    });
    expect(guard.isTripped).toBe(false);
  });

  it('ignores work after the guard trips', () => {
    const guard = new FailureGuard({ onFailSafe: () => undefined, maxFailures: 1 });
    guard.run('a', () => {
      throw new Error('x');
    });
    const fn = vi.fn();
    guard.run('b', fn);
    expect(fn).not.toHaveBeenCalled();
  });

  it('accepts failures reported by animation and observer callbacks', () => {
    const onFailSafe = vi.fn();
    const guard = new FailureGuard({ onFailSafe, maxFailures: 1 });
    guard.report('observer', new Error('x'));
    expect(guard.isTripped).toBe(true);
    expect(onFailSafe).toHaveBeenCalledWith('observer: x');
  });
});
