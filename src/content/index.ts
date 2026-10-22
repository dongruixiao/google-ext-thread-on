import {
  HOST_ID,
  IDLE_DIM_DELAY,
  IDLE_TICK_INTERVAL,
  PEEK_HIDE_DELAY,
  PILL_GAP,
  PILL_HEIGHT,
  REINDEX_DEBOUNCE,
  TOC_PROBE_INTERVAL,
  URL_POLL_INTERVAL,
  Z_INDEX,
} from '../shared/constants';
import {
  DEFAULT_SETTINGS,
  isSiteEnabled,
  loadSettings,
  normalizeSettings,
  subscribeSettings,
  type WssSettings,
} from '../shared/settings';
import {
  SITE_CHROME_SELECTOR,
  buildHeadingIndex,
  headingSignature,
  headingIndexStillAttached,
  type HeadingIndex,
} from './extractor';
import { deriveColumnBox, type Box } from './column';
import { FailureGuard } from './failure-guard';
import {
  classifyTopChrome,
  effectiveZIndex,
  hasSurface,
  highestForeignZIndex,
  isPositionedWithin,
  type ChromeCandidate,
} from './chrome-detect';
import { estimateHeadingHeight } from './heading-clone';
import { samplePageStyle } from './palette';
import { findTocCandidates, isAnyTocVisible } from './page-toc';
import { ScrollTracker, type TrackerSnapshot } from './tracker';
import { StickyUI } from './ui';
import {
  assessVisualSafety,
  type VisualSafetyReason,
} from './visual-safety';

/** 探测点：网页顶部附近，用于识别原站自带的固定导航栏 */
const OVERLAY_PROBES = [0.5, 0.08, 0.92];
const FAIL_SAFE_PREFIX = 'wss:failsafe:';

class StickyScrollApp {
  private readonly guard = new FailureGuard({
    onFailSafe: (reason) => this.failSafe(reason),
  });
  private settings: WssSettings = { ...DEFAULT_SETTINGS };
  private index: HeadingIndex | null = null;
  private tracker: ScrollTracker | null = null;
  private ui: StickyUI | null = null;
  private signature = '';
  private running = false;
  private siteAllowed = true;
  private forced = false;
  private overlayHeight = 0;
  private foreignZIndex = 0;
  private visualSafe = true;
  private visualReason: VisualSafetyReason = 'safe';
  private visualBackground = '';
  /** 顶部被遮罩层挡住（对话框 / cookie 墙），此时收起 UI */
  private overlayBlocked = false;
  /** 用户正在用浏览器的页面查找（Ctrl/⌘+F）：收起 UI，别挡住查找条与命中的文字 */
  private findMode = false;
  private findTimer = 0;

  // 显示策略状态
  private snapshot: TrackerSnapshot | null = null;
  private shown = true;
  private dimmed = false;
  private failSafeTripped = false;
  private lastActivityAt = 0;
  /** 主动跳转期间不要因为“向上滚动”就把胶囊收起来 */
  private keepVisibleUntil = 0;
  /** 空闲计时器节拍，用于低频校准 */
  private ticks = 0;

  // 原站目录适配
  private tocCandidates: HTMLElement[] = [];
  private tocVisible = false;

  private observer: MutationObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private reindexTimer = 0;
  private layoutTimer = 0;
  private urlTimer = 0;
  private idleTimer = 0;
  private tocTimer = 0;
  private lastUrl = location.href;
  private unsubscribeSettings: (() => void) | null = null;
  private messageListener:
    | ((
        message: unknown,
        sender: chrome.runtime.MessageSender,
        sendResponse: (response?: unknown) => void,
      ) => void)
    | null = null;

  async start(): Promise<void> {
    try {
      await this.boot();
    } catch {
      // 启动没有后续重试机会，任何失败都立刻完整退出。
      this.failSafe('boot failed');
    }
  }

  private async boot(): Promise<void> {
    // 只在顶层窗口运行（manifest 也已限制 all_frames: false）
    if (window.self !== window.top) return;
    if (this.hadFailSafe()) return;
    this.settings = await loadSettings();
    this.unsubscribeSettings = subscribeSettings((next) => {
      this.guard.run('settings-change', () => this.applySettings(next));
    });
    this.listenForMessages();
    this.applySettings(this.settings);
  }

  // ── 生命周期 ────────────────────────────────────────

  private applySettings(next: WssSettings): void {
    const previous = this.settings;
    this.settings = next;
    this.siteAllowed = isSiteEnabled(next, location.hostname);

    if (!this.siteAllowed) {
      this.deactivate();
      return;
    }
    if (!this.running) {
      this.activate();
      return;
    }

    const tocStrategyChanged = previous.pageTocMode !== next.pageTocMode;
    const policyChanged = previous.displayPolicy !== next.displayPolicy;
    const appearanceChanged = previous.appearance !== next.appearance;
    if (appearanceChanged) {
      this.rebuild(true);
      return;
    }
    if (tocStrategyChanged) {
      this.tocCandidates = this.collectTocCandidates();
      this.tocVisible = this.evaluateToc();
    }
    if (policyChanged) {
      this.shown = true;
      this.dimmed = false;
      this.lastActivityAt = Date.now();
    }
    this.ui?.setPathOptions({
      hideArticleTitle: next.hideArticleTitle,
      maxCrumbs: next.maxCrumbs,
    });
    this.refreshLayout();
  }

  private activate(): void {
    if (this.running) return;
    this.running = true;
    this.lastUrl = location.href;
    this.shown = true;
    this.dimmed = false;
    this.lastActivityAt = Date.now();
    this.rebuild();
    this.observe();
    this.idleTimer = window.setInterval(
      () => this.guard.run('idle-tick', this.idleTick),
      IDLE_TICK_INTERVAL,
    );
    this.tocTimer = window.setInterval(
      () => this.guard.run('toc-probe', this.probeToc),
      TOC_PROBE_INTERVAL,
    );
    this.urlTimer = window.setInterval(() => {
      this.guard.run('url-poll', () => {
        if (location.href === this.lastUrl) return;
        // SPA 路由变化：pushState 不会触发任何事件，只能轮询兜底
        this.lastUrl = location.href;
        this.forced = false;
        this.scheduleReindex();
      });
    }, URL_POLL_INTERVAL);
  }

  private deactivate(): void {
    this.running = false;
    this.teardown();
  }

  private teardown(): void {
    try {
      this.tracker?.stop();
    } catch {
      /* 清理阶段继续销毁其它资源 */
    }
    this.tracker = null;
    try {
      this.ui?.destroy();
    } catch {
      /* Shadow DOM 已不可用时也不能让清理中断 */
    }
    this.ui = null;
    try {
      this.unobserve();
      this.observer?.disconnect();
    } catch {
      /* 监听器可能已随页面卸载 */
    }
    this.observer = null;
    try {
      this.resizeObserver?.disconnect();
    } catch {
      /* ResizeObserver 可能已失效 */
    }
    this.resizeObserver = null;
    for (const timer of [this.reindexTimer, this.layoutTimer, this.urlTimer, this.idleTimer, this.tocTimer]) {
      if (timer === 0) continue;
      window.clearTimeout(timer);
      window.clearInterval(timer);
    }
    if (this.findTimer !== 0) {
      window.clearTimeout(this.findTimer);
      this.findTimer = 0;
    }
    this.findMode = false;
    this.reindexTimer = 0;
    this.layoutTimer = 0;
    this.urlTimer = 0;
    this.idleTimer = 0;
    this.tocTimer = 0;
    this.removePageMarkers();
    this.index = null;
    this.snapshot = null;
    this.signature = '';
    this.tocCandidates = [];
    this.tocVisible = false;
  }

  // ── 索引与渲染 ──────────────────────────────────────

  /** 重新扫描页面；结构未变化时只做一次轻量的位置刷新 */
  private rebuild(force = false): void {
    if (!this.running) return;
    const index = buildHeadingIndex();
    const signature = index ? headingSignature(index) : '';

    if (
      !force &&
      index &&
      this.index &&
      signature === this.signature &&
      headingIndexStillAttached(this.index)
    ) {
      this.refreshLayout();
      return;
    }

    this.tracker?.stop();
    this.tracker = null;
    this.ui?.destroy();
    this.ui = null;
    this.removePageMarkers();
    this.index = index;
    this.signature = signature;
    this.visualSafe = index?.isVisualSafe ?? false;
    this.visualReason = index?.visualReason ?? 'background-complex';
    this.visualBackground = index?.visualBackground ?? '';

    if (!index || !this.canActivate(index)) {
      // 非文章页（列表页 / 搜索页 / 应用页）：保持静默，不注入任何 UI
      this.snapshot = null;
      return;
    }

    const ui = new StickyUI(
      (headingIndex) => this.jumpTo(headingIndex),
      (action, error) => this.guard.report(action, error),
    );
    ui.setPathOptions({
      hideArticleTitle: this.settings.hideArticleTitle,
      maxCrumbs: this.settings.maxCrumbs,
    });
    ui.mount(index.headings);
    ui.setDiagnostics(
      `${index.scope.tagName.toLowerCase()}${index.scope.classList[0] ? `.${index.scope.classList[0]}` : ''}`,
      index.diagnostics,
    );
    this.ui = ui;

    this.tocCandidates = this.collectTocCandidates();
    this.tocVisible = this.evaluateToc();
    this.snapshot = null;
    this.refreshLayout();
    this.applyPresentation();

    const tracker = new ScrollTracker(
      index.headings,
      (snapshot) => {
        this.guard.run('tracker-update', () => {
          this.snapshot = snapshot;
          this.ui?.update(snapshot);
        });
      },
      {
        onActivity: (direction) => {
          this.guard.run('tracker-activity', () => this.handleScrollActivity(direction));
        },
        scope: index.scope,
        dockTop: () => this.pillTop(),
        heightOf: (headingIndex) => this.heightForHeading(headingIndex),
        onError: (action, error) => this.guard.report(`tracker-${action}`, error),
      },
    );
    this.tracker = tracker;
    tracker.start();

    this.watchLayout(index);
  }

  private watchLayout(index: HeadingIndex): void {
    this.resizeObserver?.disconnect();
    const observer = new ResizeObserver(() => this.scheduleLayoutRefresh());
    observer.observe(index.scope);
    if (document.body) observer.observe(document.body);
    this.resizeObserver = observer;
    const fonts = document.fonts;
    if (!fonts) return;
    fonts.addEventListener('loadingdone', this.handleFontsLoaded);
    void this.guard.runAsync('fonts-ready', async () => {
      await fonts.ready;
      // Web 字体晚于 document_idle 加载时，标题克隆里的字体快照会过期。
      this.ui?.refreshHeadingClone();
      this.refreshLayout();
    });
  }

  private observe(): void {
    if (this.observer || !document.body) return;
    const observer = new MutationObserver((records) => {
      this.guard.run('mutation-observer', () => {
        const onlyOwnUi = records.every((record) => {
          const target = record.target;
          return target instanceof Element && target.closest(`#${HOST_ID}`) !== null;
        });
        if (onlyOwnUi) return;
        this.scheduleReindex();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    this.observer = observer;

    window.addEventListener('resize', this.scheduleLayoutRefresh, { passive: true });
    window.addEventListener('popstate', this.scheduleReindex);
    window.addEventListener('hashchange', this.scheduleLayoutRefresh);
    // 后台标签页里 rAF 不会运行，回到前台时补一次状态刷新
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    window.addEventListener('keydown', this.handleGlobalKeyDown, true);
    window.addEventListener('pointerdown', this.handleGlobalPointerDown, true);
  }

  private unobserve(): void {
    window.removeEventListener('resize', this.scheduleLayoutRefresh);
    window.removeEventListener('popstate', this.scheduleReindex);
    window.removeEventListener('hashchange', this.scheduleLayoutRefresh);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    window.removeEventListener('keydown', this.handleGlobalKeyDown, true);
    window.removeEventListener('pointerdown', this.handleGlobalPointerDown, true);
    document.fonts?.removeEventListener('loadingdone', this.handleFontsLoaded);
  }

  private handleVisibilityChange = (): void => {
    this.guard.run('visibility', () => {
      if (document.visibilityState !== 'visible') return;
      this.lastActivityAt = Date.now();
      this.refreshLayout();
    });
  };

  /**
   * 浏览器页面查找（Ctrl/⌘+F）：查找条就在页面顶部，而我们用的是最高层级，
   * 不收起来就会压住它、也会挡住被滚到顶部的命中文字。
   * 恢复时机：按 Esc、回到页面里点击、或 20 秒兜底。
   */
  private handleGlobalKeyDown = (event: KeyboardEvent): void => {
    this.guard.run('global-key', () => {
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === 'f' && !event.altKey) {
        this.setFindMode(true);
        return;
      }
      if (
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        (key === '[' || key === ']') &&
        !this.isEditableTarget(event.target)
      ) {
        event.preventDefault();
        this.jumpAdjacent(key === ']' ? 1 : -1);
        return;
      }
      if (key === 'escape' && this.findMode) this.setFindMode(false);
    });
  };

  private isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return (
      target.isContentEditable ||
      target.matches('input, textarea, select, [contenteditable="true"]')
    );
  }

  private jumpAdjacent(direction: 1 | -1): void {
    const headings = this.index?.headings;
    if (!headings || headings.length === 0 || !this.ui || !this.tracker) return;
    const current = this.snapshot?.index ?? -1;
    let next = current + direction;
    if (current < 0 && direction === 1) {
      next = this.settings.hideArticleTitle && headings.some((node) => node.level > 1)
        ? headings.findIndex((node) => node.level > 1)
        : 0;
    }
    if (next < 0 || next >= headings.length) return;
    this.jumpTo(next);
  }

  private handleGlobalPointerDown = (): void => {
    this.guard.run('global-pointer', () => {
      if (this.findMode) this.setFindMode(false);
    });
  };

  private handleFontsLoaded = (): void => {
    this.guard.run('fonts-loaded', () => {
      this.ui?.refreshHeadingClone();
      this.refreshLayout();
    });
  };

  private setFindMode(active: boolean): void {
    if (this.findMode === active) return;
    this.findMode = active;
    if (this.findTimer !== 0) {
      window.clearTimeout(this.findTimer);
      this.findTimer = 0;
    }
    if (active) {
      this.findTimer = window.setTimeout(() => {
        this.findTimer = 0;
        this.findMode = false;
        this.applyPresentation();
      }, 20000);
    }
    this.applyPresentation();
  }

  private scheduleReindex = (): void => {
    this.guard.run('schedule-reindex', () => {
      if (this.reindexTimer !== 0) window.clearTimeout(this.reindexTimer);
      this.reindexTimer = window.setTimeout(() => {
        this.reindexTimer = 0;
        this.guard.run('reindex', () => this.rebuild());
      }, REINDEX_DEBOUNCE);
    });
  };

  private scheduleLayoutRefresh = (): void => {
    this.guard.run('schedule-layout', () => {
      if (this.layoutTimer !== 0) window.clearTimeout(this.layoutTimer);
      this.layoutTimer = window.setTimeout(() => {
        this.layoutTimer = 0;
        this.guard.run('layout-refresh', () => this.refreshLayout());
      }, 120);
    });
  };

  /** 刷新与布局相关的度量：固定导航栏高度、阅读基准线、胶囊位置 */
  private refreshLayout(): void {
    if (!this.index) return;
    this.updateLayoutMetrics();
    this.refreshVisualSafety();
    this.ui?.setAppearance(this.settings.appearance);
    this.ui?.setBarWidth(this.settings.barWidth);
    this.ui?.setTop(this.pillTop());
    this.ui?.setZIndex(this.layerZIndex());
    this.ui?.setPosition(this.settings.position);
    this.ui?.setTheme(this.settings.theme);
    this.ui?.setColumn(this.columnBox());
    this.ui?.setPageStyle(this.sampleStyle());
    this.tracker?.refresh();
    this.probeToc();
    this.applyPresentation();
  }

  private updateLayoutMetrics(): void {
    const { bottom, blocked, foreignZIndex } = this.detectTopChrome();
    this.overlayHeight = bottom;
    this.overlayBlocked = blocked;
    this.foreignZIndex = foreignZIndex;
  }

  /** 正文列的位置：吸顶条按它对齐，看起来像文章自己的标题栏 */
  private columnBox(): { left: number; right: number; width: number } | null {
    const index = this.index;
    if (!index) return null;

    const toBox = (element: Element): Box | null => {
      const rect = element.getBoundingClientRect();
      if (!Number.isFinite(rect.left) || !Number.isFinite(rect.right) || rect.width <= 0) return null;
      return { left: rect.left, right: rect.right, width: rect.width };
    };

    // 正文列从内容本身量：标题的左缘 + 同列段落的右缘
    const headingBoxes = index.headings
      .map((heading) => toBox(heading.element))
      .filter((box): box is Box => box !== null);

    const paragraphBoxes: Box[] = [];
    const blockBoxes: Box[] = [];
    for (const block of index.scope.querySelectorAll<HTMLElement>('p, pre, blockquote, li')) {
      if (blockBoxes.length >= 80) break;
      if (block.closest(`#${HOST_ID}`)) continue;
      if (block.closest(SITE_CHROME_SELECTOR)) continue;
      const box = toBox(block);
      if (!box || box.width < 120) continue;
      if (block.tagName === 'P') paragraphBoxes.push(box);
      else blockBoxes.push(box);
    }

    // 兜底用容器内容盒（扣掉内边距与边框），而不是外框
    const scopeElement = index.scope;
    const scopeRect = scopeElement.getBoundingClientRect();
    const scopeStyle = getComputedStyle(scopeElement);
    let scopeBox: Box | null = null;
    if (scopeRect.width > 0) {
      const left =
        scopeRect.left +
        (Number.parseFloat(scopeStyle.paddingLeft) || 0) +
        (Number.parseFloat(scopeStyle.borderLeftWidth) || 0);
      const right =
        scopeRect.right -
        (Number.parseFloat(scopeStyle.paddingRight) || 0) -
        (Number.parseFloat(scopeStyle.borderRightWidth) || 0);
      scopeBox = { left, right, width: right - left };
    }

    return deriveColumnBox({
      headingBoxes,
      paragraphBoxes,
      blockBoxes,
      scopeBox,
      viewportWidth: window.innerWidth,
    });
  }

  /** 采样正文配色：优先用二级标题（最常见的正文小节标题）的排版 */
  private sampleStyle(): ReturnType<typeof samplePageStyle> {
    const index = this.index;
    const sample =
      index?.headings.find((node) => node.level === 2)?.element ??
      index?.headings.find((node) => node.level === 1)?.element ??
      index?.headings[0]?.element ??
      null;
    return samplePageStyle(index?.scope ?? null, sample);
  }

  /** 某个标题吸顶后会占用的高度（吸顶条随标题行高变化，胶囊固定高度） */
  private heightForHeading(index: number): number {
    const heading = this.index?.headings[index];
    if (!heading) return PILL_HEIGHT;
    return this.settings.appearance === 'bar'
      ? estimateHeadingHeight(heading.element)
      : PILL_HEIGHT;
  }

  private pillTop(): number {
    // 吸顶条直接贴在导航栏下方（VS Code 式），胶囊再多留一点呼吸位
    const gap = this.settings.appearance === 'bar' ? 0 : PILL_GAP;
    return this.overlayHeight + gap + this.settings.offsetY;
  }

  /**
   * 探测页面顶部是什么：
   * - 站点导航条（又宽又矮的固定条）→ 吸顶条贴在它下面；
   * - 正文里的粘性元素 → 无视（不然会带着吸顶条掉到页面中间）；
   * - 全屏遮罩 → 收起 UI，不要浮在它上面。
   */
  private detectTopChrome(): { bottom: number; blocked: boolean; foreignZIndex: number } {
    const probeY = 4;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const scope = this.index?.scope ?? null;
    const candidates: ChromeCandidate[] = [];

    for (const ratio of OVERLAY_PROBES) {
      const x = Math.round(viewport.width * ratio);
      let elements: Element[] = [];
      try {
        elements = document.elementsFromPoint(x, probeY);
      } catch {
        elements = [];
      }
      for (const element of elements) {
        if (!(element instanceof HTMLElement)) continue;
        if (element.id === HOST_ID || element.closest(`#${HOST_ID}`)) continue;
        let style: CSSStyleDeclaration;
        try {
          style = getComputedStyle(element);
        } catch {
          continue;
        }
        const rect = element.getBoundingClientRect();
        candidates.push({
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
          positioned: isPositionedWithin(element),
          insideContent: scope !== null && scope !== element && scope.contains(element),
          opaque: hasSurface(style),
          zIndex: effectiveZIndex(element),
          // 站点搜索面板 / 对话框：native <dialog>、aria-modal、role=dialog
          dialog:
            element.matches('dialog[open], [aria-modal="true"], [role="dialog"]') ||
            element.closest('dialog[open], [aria-modal="true"], [role="dialog"]') !== null,
          visible:
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            (style.opacity === '' || Number(style.opacity) > 0.05),
        });
      }
    }

    return {
      ...classifyTopChrome(candidates, viewport),
      foreignZIndex: highestForeignZIndex(candidates),
    };
  }

  /** 足够高，但主动退到已在顶部的更高层 UI 下方 */
  private layerZIndex(): number {
    return this.foreignZIndex >= Z_INDEX ? Math.max(1, this.foreignZIndex - 1) : Z_INDEX;
  }

  private jumpTo(headingIndex: number): void {
    const heading = this.index?.headings[headingIndex];
    if (!heading) return;
    this.keepVisibleUntil = Date.now() + 1600;
    this.shown = true;
    this.dimmed = false;
    this.applyPresentation();
    this.tracker?.focusIndex(headingIndex);
    const element = heading.element;
    const previousMargin = element.style.scrollMarginTop;
    // 用临时 scroll-margin-top 让原生平滑滚动停在“该标题吸顶后的位置”上
    element.style.scrollMarginTop = `${this.pillTop() + this.heightForHeading(headingIndex) + 2}px`;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    element.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    window.setTimeout(() => {
      element.style.scrollMarginTop = previousMargin;
    }, 1000);
  }

  // ── 显示策略 ────────────────────────────────────────

  private handleScrollActivity = (direction: 1 | -1): void => {
    this.lastActivityAt = Date.now();
    if (this.dimmed) this.dimmed = false;

    switch (this.settings.displayPolicy) {
      case 'always':
        this.shown = true;
        break;
      case 'peek':
        this.shown = true;
        break;
      default:
        // 智能：向下滚动浮现，向上滚动（回看）让位给正文
        // 例外：刚刚通过面包屑主动跳转时保持可见，否则用户点一下工具就消失了
        this.shown = direction === 1 || Date.now() < this.keepVisibleUntil;
        break;
    }
    this.applyPresentation();
  };

  private idleTick = (): void => {
    if (!this.running) return;
    // 站点导航栏可能随滚动出现/隐藏（隐藏式顶栏很常见），定期重新校准吸附位置
    this.ticks += 1;
    if (this.ticks % 2 === 0) {
      this.refreshVisualSafety();
      this.recalibrateOverlay();
    }

    const policy = this.settings.displayPolicy;
    if (policy === 'always') return;
    const idle = Date.now() - this.lastActivityAt;
    if (policy === 'peek') {
      if (this.shown && idle > PEEK_HIDE_DELAY) {
        this.shown = false;
        this.applyPresentation();
      }
      return;
    }
    const shouldDim = idle > IDLE_DIM_DELAY;
    if (shouldDim !== this.dimmed) {
      this.dimmed = shouldDim;
      this.applyPresentation();
    }
  };

  private recalibrateOverlay(): void {
    if (!this.index) return;
    const { bottom, blocked, foreignZIndex } = this.detectTopChrome();
    if (
      bottom === this.overlayHeight &&
      blocked === this.overlayBlocked &&
      foreignZIndex === this.foreignZIndex
    ) {
      return;
    }
    this.overlayHeight = bottom;
    this.overlayBlocked = blocked;
    this.foreignZIndex = foreignZIndex;
    this.ui?.setTop(this.pillTop());
    this.ui?.setZIndex(this.layerZIndex());
    this.tracker?.refresh();
    this.applyPresentation();
  }

  private refreshVisualSafety(): void {
    const index = this.index;
    if (!index) return;
    const safety = assessVisualSafety(
      index.scope,
      index.headings.map((heading) => heading.element),
    );
    const backgroundChanged =
      safety.safe &&
      this.visualBackground !== '' &&
      safety.background !== this.visualBackground;
    const nextSafe = safety.safe && !backgroundChanged;
    const nextReason: VisualSafetyReason = backgroundChanged
      ? 'background-unstable'
      : safety.reason;
    if (nextSafe === this.visualSafe && nextReason === this.visualReason) return;
    this.visualSafe = nextSafe;
    this.visualReason = nextReason;
    this.applyPresentation();
  }

  private applyPresentation(): void {
    this.ui?.setPresentation({
      // 顶部被遮罩层盖住时不显示，免得浮在对话框上面
      visible:
        (this.visualSafe || this.settings.appearance === 'pill') &&
        this.shown &&
        !this.overlayBlocked &&
        !this.findMode,
      dim: this.dimmed,
      compact: this.settings.pageTocMode === 'adapt' && this.tocVisible,
    });
  }

  private canActivate(index: HeadingIndex | null): boolean {
    if (!index || index.isConversation) return false;
    if (this.settings.appearance === 'pill') {
      return index.isReadingCandidate || this.forced;
    }
    return index.isArticle || (this.forced && index.isVisualSafe);
  }

  // ── 原站目录适配 ────────────────────────────────────

  private collectTocCandidates(): HTMLElement[] {
    if (this.settings.pageTocMode !== 'adapt' || !this.index) return [];
    return findTocCandidates(this.index.headings);
  }

  private evaluateToc(): boolean {
    if (this.settings.pageTocMode !== 'adapt') return false;
    return isAnyTocVisible(this.tocCandidates);
  }

  private probeToc = (): void => {
    if (!this.running) return;
    const next = this.evaluateToc();
    if (next === this.tocVisible) return;
    this.tocVisible = next;
    this.applyPresentation();
  };

  // ── 与 popup / background 的通信 ────────────────────

  private listenForMessages(): void {
    if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage) return;
    const listener = (
      message: unknown,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response?: unknown) => void,
    ): void => {
      const type = (message as { type?: string } | null)?.type;
      this.guard.run(`message:${type ?? 'unknown'}`, () => {
        if (type === 'wss:status') {
          sendResponse(this.status());
          return;
        }
        if (type === 'wss:rescan') {
          if (!this.running) this.activate();
          else this.rebuild(true);
          sendResponse(this.status());
          return;
        }
        if (type === 'wss:force') {
          // 在当前页面临时绕过“智能阅读模式”判定
          this.forced = true;
          if (!this.running) this.activate();
          else this.rebuild(true);
          sendResponse(this.status());
          return;
        }
        if (type === 'wss:settings') {
          this.applySettings(normalizeSettings((message as { settings?: unknown }).settings));
          sendResponse(this.status());
        }
      });
    };
    this.messageListener = listener;
    chrome.runtime.onMessage.addListener(listener);
  }

  // ── 失败即静默 ──────────────────────────────────────

  private pageFailureKey(): string {
    return `${FAIL_SAFE_PREFIX}${location.pathname}${location.search}`.slice(0, 500);
  }

  private hadFailSafe(): boolean {
    try {
      return window.sessionStorage.getItem(this.pageFailureKey()) === '1';
    } catch {
      return false;
    }
  }

  private failSafe(_reason: string): void {
    if (this.failSafeTripped) return;
    this.failSafeTripped = true;
    this.running = false;
    try {
      window.sessionStorage.setItem(this.pageFailureKey(), '1');
    } catch {
      /* 隐私模式禁用 storage 时仍然继续清理界面 */
    }
    try {
      this.unsubscribeSettings?.();
    } catch {
      /* ignore */
    }
    this.unsubscribeSettings = null;
    if (this.messageListener && typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      try {
        chrome.runtime.onMessage.removeListener(this.messageListener);
      } catch {
        /* ignore */
      }
    }
    this.messageListener = null;
    this.teardown();
  }

  private removePageMarkers(): void {
    const index = this.index;
    if (!index) return;
    try {
      for (const heading of index.headings) delete heading.element.dataset.wssId;
      delete index.scope.dataset.wssScope;
      delete index.scope.dataset.wssStats;
    } catch {
      /* 页面已卸载或节点被冻结时无需继续 */
    }
  }

  private status(): {
    active: boolean;
    enabled: boolean;
    siteEnabled: boolean;
    host: string;
    url: string;
    title: string;
    viewport: string;
    headings: number;
    scope: string | null;
    stats: string | null;
    statusReason: string;
    isArticle: boolean;
    geometryReliable: boolean;
    visualSafe: boolean;
    visualReason: VisualSafetyReason;
    pageTocVisible: boolean;
    dockTop: number;
    layerZIndex: number;
    displayPolicy: string;
    currentSection: string | null;
  } {
    const index = this.index;
    return {
      active: this.canActivate(index) && !!this.ui && !!this.tracker,
      enabled: this.settings.enabled,
      siteEnabled: this.siteAllowed,
      host: location.hostname,
      url: location.href,
      title: document.title.slice(0, 240),
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      headings: index?.headings.length ?? 0,
      scope: index
        ? `${index.scope.tagName.toLowerCase()}${index.scope.classList[0] ? `.${index.scope.classList[0]}` : ''}`
        : null,
      stats: index?.diagnostics ?? null,
      statusReason: this.statusReason(index),
      isArticle: index?.isArticle ?? false,
      geometryReliable: index?.stats.geometryReliable ?? false,
      visualSafe: this.visualSafe,
      visualReason: this.visualReason,
      pageTocVisible: this.tocVisible,
      dockTop: this.pillTop(),
      layerZIndex: this.layerZIndex(),
      displayPolicy: this.settings.displayPolicy,
      currentSection:
        this.snapshot && this.snapshot.index >= 0
          ? (index?.headings[this.snapshot.index]?.text ?? null)
          : null,
    };
  }

  private statusReason(index: HeadingIndex | null): string {
    if (!this.settings.enabled) return 'global-disabled';
    if (!this.siteAllowed) return 'site-disabled';
    if (!index) return 'no-heading-index';
    if (index.isConversation) return 'conversation-surface';
    if (this.settings.appearance === 'bar' && (!index.isVisualSafe || !this.visualSafe)) {
      return 'visual-unreliable';
    }
    if (!index.isReadingCandidate && !this.forced) {
      return index.stats.geometryReliable ? 'content-not-article' : 'heading-geometry-unreliable';
    }
    return this.canActivate(index) && this.ui && this.tracker ? 'active' : 'inactive';
  }
}

const app = new StickyScrollApp();
void app.start();
