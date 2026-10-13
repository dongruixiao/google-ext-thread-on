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
  type HeadingIndex,
} from './extractor';
import { deriveColumnBox, type Box } from './column';
import {
  classifyTopChrome,
  hasSurface,
  isPositionedWithin,
  type ChromeCandidate,
} from './chrome-detect';
import { estimateHeadingHeight } from './heading-clone';
import { samplePageStyle } from './palette';
import { findTocCandidates, isAnyTocVisible } from './page-toc';
import { ScrollTracker, type TrackerSnapshot } from './tracker';
import { StickyUI } from './ui';

/** 探测点：网页顶部附近，用于识别原站自带的固定导航栏 */
const OVERLAY_PROBES = [0.5, 0.08, 0.92];

class StickyScrollApp {
  private settings: WssSettings = { ...DEFAULT_SETTINGS };
  private index: HeadingIndex | null = null;
  private tracker: ScrollTracker | null = null;
  private ui: StickyUI | null = null;
  private signature = '';
  private running = false;
  private siteAllowed = true;
  private forced = false;
  private overlayHeight = 0;
  /** 顶部被遮罩层挡住（对话框 / cookie 墙），此时收起 UI */
  private overlayBlocked = false;

  // 显示策略状态
  private snapshot: TrackerSnapshot | null = null;
  private shown = true;
  private dimmed = false;
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

  async boot(): Promise<void> {
    // 只在顶层窗口运行（manifest 也已限制 all_frames: false）
    if (window.self !== window.top) return;
    this.settings = await loadSettings();
    subscribeSettings((next) => this.applySettings(next));
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
    this.idleTimer = window.setInterval(this.idleTick, IDLE_TICK_INTERVAL);
    this.tocTimer = window.setInterval(this.probeToc, TOC_PROBE_INTERVAL);
    this.urlTimer = window.setInterval(() => {
      if (location.href === this.lastUrl) return;
      // SPA 路由变化：pushState 不会触发任何事件，只能轮询兜底
      this.lastUrl = location.href;
      this.forced = false;
      this.scheduleReindex();
    }, URL_POLL_INTERVAL);
  }

  private deactivate(): void {
    this.running = false;
    this.teardown();
  }

  private teardown(): void {
    this.tracker?.stop();
    this.tracker = null;
    this.ui?.destroy();
    this.ui = null;
    this.unobserve();
    this.observer?.disconnect();
    this.observer = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    for (const timer of [this.reindexTimer, this.layoutTimer, this.urlTimer, this.idleTimer, this.tocTimer]) {
      if (timer === 0) continue;
      window.clearTimeout(timer);
      window.clearInterval(timer);
    }
    this.reindexTimer = 0;
    this.layoutTimer = 0;
    this.urlTimer = 0;
    this.idleTimer = 0;
    this.tocTimer = 0;
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

    if (!force && index && this.index && signature === this.signature) {
      this.refreshLayout();
      return;
    }

    this.tracker?.stop();
    this.tracker = null;
    this.ui?.destroy();
    this.ui = null;
    this.index = index;
    this.signature = signature;

    if (!index || !(index.isArticle || this.forced)) {
      // 非文章页（列表页 / 搜索页 / 应用页）：保持静默，不注入任何 UI
      this.snapshot = null;
      return;
    }

    const ui = new StickyUI((headingIndex) => this.jumpTo(headingIndex));
    ui.setPathOptions({
      hideArticleTitle: this.settings.hideArticleTitle,
      maxCrumbs: this.settings.maxCrumbs,
    });
    ui.mount(index.headings);
    this.ui = ui;

    this.tocCandidates = this.collectTocCandidates();
    this.tocVisible = this.evaluateToc();
    this.snapshot = null;
    this.refreshLayout();
    this.applyPresentation();

    const tracker = new ScrollTracker(
      index.headings,
      (snapshot) => {
        this.snapshot = snapshot;
        this.ui?.update(snapshot);
      },
      {
        onActivity: this.handleScrollActivity,
        scope: index.scope,
        dockTop: () => this.pillTop(),
        heightOf: (headingIndex) => this.heightForHeading(headingIndex),
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
    void document.fonts?.ready.then(() => this.refreshLayout()).catch(() => undefined);
  }

  private observe(): void {
    if (this.observer || !document.body) return;
    const observer = new MutationObserver((records) => {
      const onlyOwnUi = records.every((record) => {
        const target = record.target;
        return target instanceof Element && target.closest(`#${HOST_ID}`) !== null;
      });
      if (onlyOwnUi) return;
      this.scheduleReindex();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    this.observer = observer;

    window.addEventListener('resize', this.scheduleLayoutRefresh, { passive: true });
    window.addEventListener('popstate', this.scheduleReindex);
    window.addEventListener('hashchange', this.scheduleLayoutRefresh);
    // 后台标签页里 rAF 不会运行，回到前台时补一次状态刷新
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
  }

  private unobserve(): void {
    window.removeEventListener('resize', this.scheduleLayoutRefresh);
    window.removeEventListener('popstate', this.scheduleReindex);
    window.removeEventListener('hashchange', this.scheduleLayoutRefresh);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
  }

  private handleVisibilityChange = (): void => {
    if (document.visibilityState !== 'visible') return;
    this.lastActivityAt = Date.now();
    this.refreshLayout();
  };

  private scheduleReindex = (): void => {
    if (this.reindexTimer !== 0) window.clearTimeout(this.reindexTimer);
    this.reindexTimer = window.setTimeout(() => {
      this.reindexTimer = 0;
      this.rebuild();
    }, REINDEX_DEBOUNCE);
  };

  private scheduleLayoutRefresh = (): void => {
    if (this.layoutTimer !== 0) window.clearTimeout(this.layoutTimer);
    this.layoutTimer = window.setTimeout(() => {
      this.layoutTimer = 0;
      this.refreshLayout();
    }, 120);
  };

  /** 刷新与布局相关的度量：固定导航栏高度、阅读基准线、胶囊位置 */
  private refreshLayout(): void {
    if (!this.index) return;
    this.updateLayoutMetrics();
    this.ui?.setAppearance(this.settings.appearance);
    this.ui?.setBarWidth(this.settings.barWidth);
    this.ui?.setTop(this.pillTop());
    this.ui?.setPosition(this.settings.position);
    this.ui?.setTheme(this.settings.theme);
    this.ui?.setColumn(this.columnBox());
    this.ui?.setPageStyle(this.sampleStyle());
    this.tracker?.refresh();
    this.probeToc();
    this.applyPresentation();
  }

  private updateLayoutMetrics(): void {
    const { bottom, blocked } = this.detectTopChrome();
    this.overlayHeight = bottom;
    this.overlayBlocked = blocked;
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
  private detectTopChrome(): { bottom: number; blocked: boolean } {
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
          visible:
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            (style.opacity === '' || Number(style.opacity) > 0.05),
        });
      }
    }

    return classifyTopChrome(candidates, viewport);
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
    if (this.ticks % 2 === 0) this.recalibrateOverlay();

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
    const { bottom, blocked } = this.detectTopChrome();
    if (bottom === this.overlayHeight && blocked === this.overlayBlocked) return;
    this.overlayHeight = bottom;
    this.overlayBlocked = blocked;
    this.ui?.setTop(this.pillTop());
    this.tracker?.refresh();
    this.applyPresentation();
  }

  private applyPresentation(): void {
    this.ui?.setPresentation({
      // 顶部被遮罩层盖住时不显示，免得浮在对话框上面
      visible: this.shown && !this.overlayBlocked,
      dim: this.dimmed,
      compact: this.settings.pageTocMode === 'adapt' && this.tocVisible,
    });
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
    chrome.runtime.onMessage.addListener(
      (
        message: unknown,
        _sender: chrome.runtime.MessageSender,
        sendResponse: (response?: unknown) => void,
      ) => {
        const type = (message as { type?: string } | null)?.type;
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
      },
    );
  }

  private status(): {
    active: boolean;
    enabled: boolean;
    siteEnabled: boolean;
    host: string;
    headings: number;
    scope: string | null;
    isArticle: boolean;
    pageTocVisible: boolean;
    displayPolicy: string;
    currentSection: string | null;
  } {
    const index = this.index;
    return {
      active: !!this.ui && !!this.tracker,
      enabled: this.settings.enabled,
      siteEnabled: this.siteAllowed,
      host: location.hostname,
      headings: index?.headings.length ?? 0,
      scope: index ? index.scope.tagName.toLowerCase() : null,
      isArticle: index?.isArticle ?? false,
      pageTocVisible: this.tocVisible,
      displayPolicy: this.settings.displayPolicy,
      currentSection:
        this.snapshot && this.snapshot.index >= 0
          ? (index?.headings[this.snapshot.index]?.text ?? null)
          : null,
    };
  }
}

const app = new StickyScrollApp();
void app.boot();
