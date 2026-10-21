import { describe, expect, it, vi } from 'vitest';
import { FailureGuard } from './failure-guard';

describe('FailureGuard', () => {
  it('窗口期内连续 3 次失败后熔断，并且只触发一次', () => {
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

  it('失败间隔超过窗口会重新计数（偶发错误不熔断）', () => {
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

  it('熔断后不再执行任何操作', () => {
    const guard = new FailureGuard({ onFailSafe: () => undefined, maxFailures: 1 });
    guard.run('a', () => {
      throw new Error('x');
    });
    const fn = vi.fn();
    guard.run('b', fn);
    expect(fn).not.toHaveBeenCalled();
  });

  it('异步失败同样被吞掉', async () => {
    const guard = new FailureGuard({ onFailSafe: () => undefined, maxFailures: 1 });
    await guard.runAsync('a', async () => {
      throw new Error('x');
    });
    expect(guard.isTripped).toBe(true);
  });

  it('可以记录 rAF / observer 回调里已经冒出的异常', () => {
    const onFailSafe = vi.fn();
    const guard = new FailureGuard({ onFailSafe, maxFailures: 1 });
    guard.report('observer', new Error('x'));
    expect(guard.isTripped).toBe(true);
    expect(onFailSafe).toHaveBeenCalledWith('observer: x');
  });
});
