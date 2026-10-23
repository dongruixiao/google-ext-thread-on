export interface FailureGuardOptions {
  /** Number of failures within the window before the guard trips. */
  maxFailures?: number;
  /** Rolling failure window in milliseconds. */
  windowMs?: number;
  /** Invoked once so the caller can remove UI and listeners. */
  onFailSafe: (reason: string) => void;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

/**
 * Stop the extension cleanly after repeated failures instead of leaving
 * partial UI or leaking exceptions into the host page.
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

  /** Run a synchronous operation without leaking exceptions to the page. */
  run(action: string, fn: () => void): void {
    if (this.tripped) return;
    try {
      fn();
    } catch (error) {
      this.record(action, error);
    }
  }

  /** Record an exception from callbacks that cannot be wrapped by run(). */
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
      /* Cleanup failures must not escape the fail-safe path. */
    }
  }
}
