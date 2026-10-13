import { SECTION_PROGRESS_EPS } from '../shared/constants';
import type { HeadingNode } from './extractor';

export interface TrackerSnapshot {
  /** 当前活跃标题下标，-1 表示视口还停留在第一个标题之上 */
  index: number;
  /** 从根到当前的父子链（下标数组） */
  path: number[];
  /** 整篇文章的阅读进度 0..1 */
  progress: number;
}

export interface TrackerOptions {
  /** 滚动方向回调：1 表示向下、-1 表示向上（用于显示策略） */
  onActivity?: (direction: 1 | -1) => void;
  /** 正文容器：用于计算整篇文章的阅读进度 */
  scope?: HTMLElement | null;
  /** 吸顶区顶部（视口坐标） */
  dockTop?: () => number;
  /** 第 index 个标题吸顶后会占用的高度 */
  heightOf?: (index: number) => number;
}

const EMPTY_SNAPSHOT: TrackerSnapshot = { index: -1, path: [], progress: 0 };

/** 判定容差：滚动落点都是小数像素，贴近条顶边时算“已滑到条后面” */
const ACTIVE_TOLERANCE = 6;
const DEFAULT_HEIGHT = 44;
/** 跳转目标落到条下方时，允许它在条附近停留多久（毫秒） */
const OVERRIDE_TTL = 2500;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * 滚动监听与层级推导。
 *
 * 吸顶时机只用一个判据：**标题是否已经滑到吸顶条的后面**（越过条顶边）。
 *
 * - 向下滚动：下一个标题必须完全滑到条后面（被条盖住、屏幕上再也看不到它）才切换，
 *   所以不会出现“标题还在下面露着，条已经提前显示它”的悬浮感；
 * - 向上回滚：当前标题的原文一开始重新露头就立刻退回上一级，
 *   不会出现“上一个标题已经在屏幕上，条还赖着下级标题”；
 * - 判定只看当前几何位置，不依赖历史状态，快速回滚、锚点跳转都不会残留旧状态；
 * - 主动跳转时用 override 让目标章节暂时生效（它的标题是停在条下方给人看的）。
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

  constructor(
    private readonly headings: HeadingNode[],
    private readonly onUpdate: (snapshot: TrackerSnapshot) => void,
    options: TrackerOptions = {},
  ) {
    this.onActivity = options.onActivity;
    this.scope = options.scope ?? null;
    this.dockTop = options.dockTop ?? (() => 0);
    this.heightOf = options.heightOf ?? (() => DEFAULT_HEIGHT);
  }

  setScope(scope: HTMLElement | null): void {
    this.scope = scope;
    this.flush();
  }

  /** 主动跳转后，让目标章节在它落位后保持为当前章节 */
  focusIndex(index: number): void {
    if (index < 0 || index >= this.headings.length) return;
    this.override = index;
    this.overrideArmed = false;
    this.overrideExpiresAt = Date.now() + OVERRIDE_TTL;
    this.flush();
  }

  /** 吸顶位置或条高变化后调用，重新按新基准判定 */
  refresh(): void {
    this.flush();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // scroll 不冒泡，但会进入捕获阶段：顺带覆盖“滚动容器而非 window”的站点
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

  /** 强制重新计算并派发一次快照 */
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
      this.emitActivity();
      this.flush();
    });
  };

  /**
   * 判断滚动方向。用第一个标题的视口位置而不是 window.scrollY，
   * 这样在“滚动容器而非 window”的站点上同样有效。
   */
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
    const doc = document.documentElement;
    return window.scrollY + window.innerHeight >= doc.scrollHeight - 4;
  }

  /** 第 index 个标题吸顶时，它的文字顶部应该落在哪条线上 */
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

    // 当前章节：最后一个已经滑到吸顶条后面的标题
    const line = this.behindLine();
    let index = -1;
    for (let i = 0; i < count; i += 1) {
      if (tops[i] <= line) index = i;
    }
    index = this.applyOverride(tops, index, line);

    // 页面滚动到底后，最后一个标题可能永远无法越过基准线：此时让它直接生效
    if (this.atPageBottom()) {
      const bottomLine = window.innerHeight - 8;
      let last = index;
      for (let i = index + 1; i < count; i += 1) {
        if (tops[i] <= bottomLine) last = i;
        else break;
      }
      index = last;
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
   * 主动跳转的临时覆盖：
   * 目标标题停在条下方（给人看），但它并不满足“滑到条后面”，所以需要临时认定它。
   * 一旦被更深的标题取代，或用户回滚到目标标题重新露头，覆盖立即失效。
   */
  private applyOverride(tops: number[], natural: number, line: number): number {
    const target = this.override;
    if (target === null || tops[target] === undefined) return natural;

    const height = this.heightOf(target);
    const limit = line + height + ACTIVE_TOLERANCE;
    // “到位”既不能还在条下方很远（跳转还没到），也不能已经跑到条上方很远（那是回滚走了）
    const inZone = tops[target] <= limit && tops[target] >= line - height - ACTIVE_TOLERANCE;
    if (inZone) this.overrideArmed = true;

    // 目标到位之后：被更深的标题取代、或重新露到条下方、或超时 → 覆盖失效。
    // 注意“被更深的标题取代”必须等目标确实到位过一次，否则向上跳转会在半路上被清掉。
    if (
      (this.overrideArmed && (natural > target || !inZone)) ||
      Date.now() > this.overrideExpiresAt
    ) {
      this.override = null;
      this.overrideArmed = false;
      return natural;
    }
    // 还在跳转动画途中：先跟随实际位置
    if (!this.overrideArmed) return natural;
    return target;
  }

  /**
   * 整篇文章的阅读进度：
   * 0 = 正文刚顶到阅读基准线（刚开始读）
   * 1 = 正文末尾已经进入视口底部（这篇文章读完了）
   */
  private articleProgress(): number {
    const scope = this.scope;
    if (!scope || !scope.isConnected) return 0;
    const rect = scope.getBoundingClientRect();
    if (!Number.isFinite(rect.height) || rect.height <= 1) return 0;
    const line = this.dockTop() + DEFAULT_HEIGHT;
    const viewport = window.innerHeight || 0;
    const range = rect.height + line - viewport;
    // 正文比视口还短：整篇都在屏幕上，直接算读完
    if (range <= 1) return 1;
    return clamp01((line - rect.top) / range);
  }
}
