import { SECTION_PROGRESS_EPS } from '../shared/constants';
import type { HeadingNode } from './extractor';

export interface TrackerSnapshot {
  /** Active heading index; -1 means the viewport is above the first heading. */
  index: number;
  /** Parent chain from root to the active heading. */
  path: number[];
  /** Article progress in the range 0..1. */
  progress: number;
}

export interface TrackerOptions {
  /** Scroll direction: 1 for down, -1 for up. */
  onActivity?: (direction: 1 | -1) => void;
  /** Article scope used to compute overall reading progress. */
  scope?: HTMLElement | null;
  /** Docking line in viewport coordinates. */
  dockTop?: () => number;
  /** Height reserved by the heading at the given index. */
  heightOf?: (index: number) => number;
  /** Route scroll callback failures to the extension failure guard. */
  onError?: (action: string, error: unknown) => void;
}

const EMPTY_SNAPSHOT: TrackerSnapshot = { index: -1, path: [], progress: 0 };

/** Account for fractional scroll positions around the docking line. */
const ACTIVE_TOLERANCE = 6;
const DEFAULT_HEIGHT = 44;
/** Maximum time for a programmatic jump override. */
const OVERRIDE_TTL = 2500;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Heading transitions are derived from geometry alone: a heading becomes
 * active only after crossing the docking line. This keeps fast scrolling,
 * scroll-back, and programmatic jumps deterministic.
 */
export class ScrollTracker {
  private rafId = 0;
  private running = false;
  private snapshot: TrackerSnapshot = EMPTY_SNAPSHOT;
  private emitted = false;
  private lastAnchor: number | null = null;
  private scope: HTMLElement | null = null;
  private override: number | null = null;
  private overrideArmed = false;
  private overrideExpiresAt = 0;
  private readonly onActivity?: (direction: 1 | -1) => void;
  private readonly dockTop: () => number;
  private readonly heightOf: (index: number) => number;
  private readonly onError?: (action: string, error: unknown) => void;

  constructor(
    private readonly headings: HeadingNode[],
    private readonly onUpdate: (snapshot: TrackerSnapshot) => void,
    options: TrackerOptions = {},
  ) {
    this.onActivity = options.onActivity;
    this.scope = options.scope ?? null;
    this.dockTop = options.dockTop ?? (() => 0);
    this.heightOf = options.heightOf ?? (() => DEFAULT_HEIGHT);
    this.onError = options.onError;
  }

  /** Keep a jump target active once it reaches the docking zone. */
  focusIndex(index: number): void {
    if (index < 0 || index >= this.headings.length) return;
    this.override = index;
    this.overrideArmed = false;
    this.overrideExpiresAt = Date.now() + OVERRIDE_TTL;
    this.flush();
  }

  refresh(): void {
    this.flush();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // Capture scroll events from nested scroll containers as well as window.
    document.addEventListener('scroll', this.schedule, { capture: true, passive: true });
    window.addEventListener('scroll', this.schedule, { passive: true });
    window.addEventListener('resize', this.schedule, { passive: true });
    this.lastAnchor = this.headings[0]?.element.getBoundingClientRect().top ?? null;
    this.flush();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    document.removeEventListener('scroll', this.schedule, { capture: true });
    window.removeEventListener('scroll', this.schedule);
    window.removeEventListener('resize', this.schedule);
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  /** Recompute immediately and emit when the observed state changes. */
  flush(): void {
    const next = this.compute();
    if (
      this.emitted &&
      next.index === this.snapshot.index &&
      Math.abs(next.progress - this.snapshot.progress) < SECTION_PROGRESS_EPS
    ) {
      return;
    }
    this.emitted = true;
    this.snapshot = next;
    this.onUpdate(next);
  }

  private schedule = (): void => {
    if (this.rafId !== 0) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      try {
        this.emitActivity();
        this.flush();
      } catch (error) {
        this.onError?.('scroll', error);
      }
    });
  };

  /** Use the first heading as the anchor so nested scrollers work. */
  private emitActivity(): void {
    const anchor = this.headings[0]?.element.getBoundingClientRect().top ?? null;
    if (anchor === null) return;
    if (this.lastAnchor !== null) {
      const delta = this.lastAnchor - anchor;
      if (Math.abs(delta) >= 2) this.onActivity?.(delta > 0 ? 1 : -1);
    }
    this.lastAnchor = anchor;
  }

  private atPageBottom(): boolean {
    const scope = this.scope;
    if (scope?.isConnected) {
      const rect = scope.getBoundingClientRect();
      if (Number.isFinite(rect.bottom)) {
        return rect.bottom <= window.innerHeight + 4;
      }
    }
    const doc = document.documentElement;
    return window.scrollY + window.innerHeight >= doc.scrollHeight - 4;
  }

  /** Top edge of a heading once it crosses the docking line. */
  private behindLine(): number {
    return this.dockTop() + ACTIVE_TOLERANCE;
  }

  private compute(): TrackerSnapshot {
    const { headings } = this;
    const count = headings.length;
    if (count === 0) return EMPTY_SNAPSHOT;

    const tops = new Array<number>(count);
    for (let i = 0; i < count; i += 1) {
      tops[i] = headings[i].element.getBoundingClientRect().top;
    }

    // The last heading to cross the docking line is the active section.
    const line = this.behindLine();
    let index = -1;
    for (let i = 0; i < count; i += 1) {
      if (tops[i] <= line) index = i;
    }
    index = this.applyOverride(tops, index, line);

    // The final heading may never cross the line when the document ends.
    // Promote it only at the real bottom, and never interrupt a jump override.
    if (this.override === null && this.atPageBottom() && index < count - 1) {
      index = count - 1;
    }

    if (index < 0) {
      return { index: -1, path: [], progress: this.articleProgress() };
    }

    const path: number[] = [];
    for (let i = index; i >= 0 && path.length < 32; i = headings[i].parentIndex) {
      path.unshift(i);
    }

    return { index, path, progress: this.articleProgress() };
  }

  /**
   * A jump target normally lands below the docking line, so it needs a
   * temporary override. The override ends after the target is observed,
   * is displaced, leaves the docking zone, or times out.
   */
  private applyOverride(tops: number[], natural: number, line: number): number {
    const target = this.override;
    if (target === null || tops[target] === undefined) return natural;

    const height = this.heightOf(target);
    const limit = line + height + ACTIVE_TOLERANCE;
    // The target must be near the dock: neither still approaching nor scrolled away.
    const inZone = tops[target] <= limit && tops[target] >= line - height - ACTIVE_TOLERANCE;
    if (inZone) this.overrideArmed = true;

    // Do not clear an under-armed jump midway through an upward scroll.
    if (
      (this.overrideArmed && (natural > target || !inZone)) ||
      Date.now() > this.overrideExpiresAt
    ) {
      this.override = null;
      this.overrideArmed = false;
      return natural;
    }
    // Before the target arrives, follow the natural geometric result.
    if (!this.overrideArmed) return natural;
    return target;
  }

  /** 0 = article starts at the reading line; 1 = article end is visible. */
  private articleProgress(): number {
    const scope = this.scope;
    if (!scope || !scope.isConnected) return 0;
    const rect = scope.getBoundingClientRect();
    if (!Number.isFinite(rect.height) || rect.height <= 1) return 0;
    const line = this.dockTop() + DEFAULT_HEIGHT;
    const viewport = window.innerHeight || 0;
    const range = rect.height + line - viewport;
    // A short article already fits entirely in the viewport.
    if (range <= 1) return 1;
    return clamp01((line - rect.top) / range);
  }
}
