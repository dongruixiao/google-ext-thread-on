export interface FailureGuardOptions {
  /** 窗口期内连续失败几次就不再尝试 */
  maxFailures?: number;
  /** 统计窗口（毫秒） */
  windowMs?: number;
  /** 触发熔断时回调（用于清理 UI / 监听器） */
  onFailSafe: (reason: string) => void;
  /** 便于测试注入时钟 */
  now?: () => number;
}

/**
 * 「失败即静默」守卫。
 *
 * 宁可错杀：连续出错就彻底停止，不留下半截 UI、不反复重试、不把异常抛给页面。
 * 触发熔断后所有 run() 都是 no-op，直到页面刷新。
 */
export class FailureGuard {
  private failures = 0;
  private lastFailureAt = 0;
  private tripped = false;
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(private readonly options: FailureGuardOptions) {
    this.maxFailures = options.maxFailures ?? 3;
    this.windowMs = options.windowMs ?? 10000;
    this.now = options.now ?? (() => Date.now());
  }

  get isTripped(): boolean {
    return this.tripped;
  }

  /** 执行一次受保护的操作；异常只记账，绝不上抛 */
  run(action: string, fn: () => void): void {
    if (this.tripped) return;
    try {
      fn();
    } catch (error) {
      this.record(action, error);
    }
  }

  /** 受保护的异步操作；同样绝不上抛 */
  async runAsync(action: string, fn: () => Promise<void>): Promise<void> {
    if (this.tripped) return;
    try {
      await fn();
    } catch (error) {
      this.record(action, error);
    }
  }

  /** 捕获已经发生的异常（用于 rAF / observer 这类无法由 run 包裹的回调） */
  report(action: string, error: unknown): void {
    if (this.tripped) return;
    this.record(action, error);
  }

  private record(action: string, error: unknown): void {
    const now = this.now();
    if (now - this.lastFailureAt > this.windowMs) this.failures = 0;
    this.failures += 1;
    this.lastFailureAt = now;
    if (this.failures < this.maxFailures || this.tripped) return;

    this.tripped = true;
    const message = `${action}: ${error instanceof Error ? error.message : String(error)}`;
    try {
      this.options.onFailSafe(message);
    } catch {
      /* 熔断回调本身失败也不能再抛 */
    }
  }
}
