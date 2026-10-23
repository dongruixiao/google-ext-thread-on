import {
  HOST_ID,
  IDLE_DIM_DELAY,
  IDLE_TICK_INTERVAL,
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
  saveSettings,
  subscribeSettings,
  type FloatingPosition,
  type WssSettings,
} from '../shared/settings';
import { STATUS_MESSAGE, type ContentStatus } from '../shared/protocol';
import {
  buildHeadingIndex,
  headingSignature,
  headingIndexStillAttached,
  type HeadingIndex,
} from './extractor';
import { FailureGuard } from './failure-guard';
import { findTocCandidates, isAnyTocVisible } from './page-toc';
import { ScrollTracker, type TrackerSnapshot } from './tracker';
import { detectTopChrome } from './top-chrome';
import { CapsuleUI } from './ui';

declare const __WSS_VERSION__: string;

class ReadingContextApp {
  private readonly guard = new FailureGuard({
    onFailSafe: (reason) => this.failSafe(reason),
  });
  private settings: WssSettings = { ...DEFAULT_SETTINGS };
  private index: HeadingIndex | null = null;
  private tracker: ScrollTracker | null = null;
  private ui: CapsuleUI | null = null;
  private signature = '';
  private running = false;
  private siteAllowed = true;
  private overlayHeight = 0;
  private foreignZIndex = 0;
  /** A dialog or overlay owns the top edge. */
  private overlayBlocked = false;
  /** Native find-in-page needs exclusive access to the top edge. */
  private findMode = false;
  private findTimer = 0;

  private snapshot: TrackerSnapshot | null = null;
  private shown = true;
  private dimmed = false;
  private failSafeTripped = false;
  private lastActivityAt = 0;
  /** Keep the capsule visible briefly after an intentional jump. */
  private keepVisibleUntil = 0;
  /** Used to amortize periodic layout calibration. */
  private ticks = 0;

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
      // Startup has no retry path; leave the page clean on any failure.
      this.failSafe('boot failed');
    }
  }

  private async boot(): Promise<void> {
    // Manifest already limits execution to the top frame; keep a guard for dev builds.
    if (window.self !== window.top) return;
    this.settings = await loadSettings();
    this.unsubscribeSettings = subscribeSettings((next) => {
      this.guard.run('settings-change', () => this.applySettings(next));
    });
    this.listenForMessages();
    this.applySettings(this.settings);
  }

  private applySettings(next: WssSettings): void {
    const previousPolicy = this.settings.displayPolicy;
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

    const policyChanged = previousPolicy !== next.displayPolicy;
    if (policyChanged) {
      this.shown = true;
      this.dimmed = false;
      this.lastActivityAt = Date.now();
    }
    this.ui?.setFloatingPosition(next.floatingPositions[location.hostname] ?? null);
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
        // pushState emits no event, so route changes need polling.
        this.lastUrl = location.href;
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
      /* Continue cleanup if a subsystem is already detached. */
    }
    this.tracker = null;
    try {
      this.ui?.destroy();
    } catch {
      /* A detached shadow root must not block the rest of cleanup. */
    }
    this.ui = null;
    try {
      this.unobserve();
      this.observer?.disconnect();
    } catch {
      /* Page teardown may already have removed listeners. */
    }
    this.observer = null;
    try {
      this.resizeObserver?.disconnect();
    } catch {
      /* ResizeObserver may already be invalid. */
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

  /** Reuse an attached, unchanged tree and refresh measurements only. */
  private rebuild(): void {
    if (!this.running) return;
    const index = buildHeadingIndex();
    const signature = index ? headingSignature(index) : '';

    if (
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

    if (!index || !this.canActivate(index)) {
      // Unsupported pages remain completely silent.
      this.snapshot = null;
      return;
    }

    const ui = new CapsuleUI(
      (headingIndex) => this.jumpTo(headingIndex),
      (action, error) => this.guard.report(action, error),
      (position) => this.saveFloatingPosition(position),
    );
    ui.mount(index.headings);
    ui.setFloatingPosition(this.settings.floatingPositions[location.hostname] ?? null);
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
        heightOf: () => PILL_HEIGHT,
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
    // rAF pauses in background tabs, so refresh when visibility resumes.
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
  }

  private handleVisibilityChange = (): void => {
    this.guard.run('visibility', () => {
      if (document.visibilityState !== 'visible') return;
      this.lastActivityAt = Date.now();
      this.refreshLayout();
    });
  };

  /**
   * Find-in-page occupies the same top layer as the capsule. Hide our UI on
   * Ctrl/Cmd+F and restore it on Escape, pointer input, or a timeout.
   */
  private handleGlobalKeyDown = (event: KeyboardEvent): void => {
    this.guard.run('global-key', () => {
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === 'f' && !event.altKey) {
        this.setFindMode(true);
        return;
      }
      if (key === 'escape' && this.findMode) this.setFindMode(false);
    });
  };

  private handleGlobalPointerDown = (): void => {
    this.guard.run('global-pointer', () => {
      if (this.findMode) this.setFindMode(false);
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

  /** Refresh site chrome, docking line, and layering metrics. */
  private refreshLayout(): void {
    if (!this.index || !this.ui) return;
    this.updateLayoutMetrics();
    this.ui.setTop(this.pillTop());
    this.ui.setZIndex(this.layerZIndex());
    this.tracker?.refresh();
    this.probeToc();
    this.applyPresentation();
  }

  private updateLayoutMetrics(): void {
    const { bottom, blocked, foreignZIndex } = detectTopChrome(this.index?.scope ?? null);
    this.overlayHeight = bottom;
    this.overlayBlocked = blocked;
    this.foreignZIndex = foreignZIndex;
  }

  private pillTop(): number {
    // Default position clears native chrome; custom positions are per host.
    return this.overlayHeight + PILL_GAP;
  }

  /** Stay below any foreign UI already using the top layer. */
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
    // Temporarily offset native smooth scrolling by the capsule height.
    element.style.scrollMarginTop = `${this.ui?.getJumpMarginTop(this.pillTop()) ?? this.pillTop()}px`;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    element.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    window.setTimeout(() => {
      element.style.scrollMarginTop = previousMargin;
    }, 1000);
  }

  private handleScrollActivity = (direction: 1 | -1): void => {
    this.lastActivityAt = Date.now();
    if (this.dimmed) this.dimmed = false;

    switch (this.settings.displayPolicy) {
      case 'always':
        this.shown = true;
        break;
      default:
        // Smart mode yields on scroll-back except immediately after a jump.
        this.shown = direction === 1 || Date.now() < this.keepVisibleUntil;
        break;
    }
    this.applyPresentation();
  };

  private idleTick = (): void => {
    if (!this.running || !this.ui || document.visibilityState !== 'visible') return;
    // Auto-hiding headers change the useful docking line during scroll.
    this.ticks += 1;
    if (this.ticks % 2 === 0) {
      this.recalibrateOverlay();
    }

    const policy = this.settings.displayPolicy;
    if (policy === 'always') return;
    const idle = Date.now() - this.lastActivityAt;
    const shouldDim = idle > IDLE_DIM_DELAY;
    if (shouldDim !== this.dimmed) {
      this.dimmed = shouldDim;
      this.applyPresentation();
    }
  };

  private recalibrateOverlay(): void {
    if (!this.index || !this.ui) return;
    const { bottom, blocked, foreignZIndex } = detectTopChrome(this.index?.scope ?? null);
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

  private applyPresentation(): void {
    this.ui?.setPresentation({
      // Never float above a blocking overlay.
      visible: this.shown && !this.overlayBlocked && !this.findMode,
      dim: this.dimmed,
      compact: this.tocVisible,
    });
  }

  private canActivate(index: HeadingIndex | null): boolean {
    if (!index || index.isConversation) return false;
    return index.isReadingCandidate;
  }

  private saveFloatingPosition(position: FloatingPosition | null): void {
    const host = location.hostname;
    const floatingPositions = { ...this.settings.floatingPositions };
    if (position) floatingPositions[host] = position;
    else delete floatingPositions[host];
    this.settings = { ...this.settings, floatingPositions };
    this.ui?.setFloatingPosition(position);
    void saveSettings(this.settings);
  }

  private collectTocCandidates(): HTMLElement[] {
    if (!this.index) return [];
    return findTocCandidates(this.index.headings);
  }

  private evaluateToc(): boolean {
    return isAnyTocVisible(this.tocCandidates);
  }

  private probeToc = (): void => {
    if (!this.running || !this.ui || document.visibilityState !== 'visible') return;
    const next = this.evaluateToc();
    if (next === this.tocVisible) return;
    this.tocVisible = next;
    this.applyPresentation();
  };

  private listenForMessages(): void {
    if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage) return;
    const listener = (
      message: unknown,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response?: unknown) => void,
    ): void => {
      const type = (message as { type?: string } | null)?.type;
      this.guard.run(`message:${type ?? 'unknown'}`, () => {
        if (type === STATUS_MESSAGE) {
          sendResponse(this.status());
          return;
        }
      });
    };
    this.messageListener = listener;
    chrome.runtime.onMessage.addListener(listener);
  }

  private failSafe(_reason: string): void {
    if (this.failSafeTripped) return;
    this.failSafeTripped = true;
    this.running = false;
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
      /* The page may already be gone or frozen. */
    }
  }

  private status(): ContentStatus {
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
      isReadingCandidate: index?.isReadingCandidate ?? false,
      geometryReliable: index?.stats.geometryReliable ?? false,
      pageTocVisible: this.tocVisible,
      dockTop: this.pillTop(),
      layerZIndex: this.layerZIndex(),
      contentVersion: __WSS_VERSION__,
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
    if (!index.isReadingCandidate) {
      return index.stats.geometryReliable ? 'content-not-article' : 'heading-geometry-unreliable';
    }
    return this.canActivate(index) && this.ui && this.tracker ? 'active' : 'inactive';
  }
}

const app = new ReadingContextApp();
void app.start();
