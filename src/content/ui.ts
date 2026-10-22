import styleText from './style.css?inline';
import type { HeadingNode } from './extractor';
import { buildVisiblePath, type PathOptions } from './path';
import type {
  FloatingPosition,
  PillPosition,
  ThemeMode,
} from '../shared/settings';
import { HOST_ID, Z_INDEX } from '../shared/constants';

import type { TrackerSnapshot } from './tracker';

const ICON_SVG = `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.75 4h10.5M2.75 8h7.5M2.75 12h4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" fill="none"/></svg>`;

/** 悬浮胶囊与抽屉之间的“穿越”缓冲：鼠标经过空隙时不至于闪烁收起 */
const CLOSE_DELAY = 260;

const EMPTY_SNAPSHOT: TrackerSnapshot = { index: -1, path: [], progress: 0 };

export interface Presentation {
  /** 当前策略是否允许显示（路径存在 + 显示策略判定） */
  visible: boolean;
  /** 淡出状态：静止一段时间后降低存在感 */
  dim: boolean;
  /** 原站目录可见时的极简模式（只显示当前小节、不弹抽屉） */
  compact: boolean;
}

const DEFAULT_PRESENTATION: Presentation = { visible: true, dim: false, compact: false };
const DEFAULT_PATH_OPTIONS: PathOptions = { hideArticleTitle: true, maxCrumbs: 3 };

const HOVER_TARGET = '.wss-pill, .wss-drawer';

/**
 * Shadow DOM 渲染层：可拖动的液态玻璃胶囊、悬停大纲和全局阅读进度。
 */
export class StickyUI {
  private host: HTMLDivElement | null = null;
  private root: HTMLDivElement | null = null;
  private pill: HTMLDivElement | null = null;
  private glassTitle: HTMLElement | null = null;
  private progressLayer: HTMLDivElement | null = null;
  private progressFill: HTMLElement | null = null;
  private below: HTMLDivElement | null = null;
  private drawer: HTMLDivElement | null = null;
  private drawerPath: HTMLDivElement | null = null;
  private drawerProgress: HTMLElement | null = null;
  /** 大纲行：标题下标 → 行按钮 */
  private rows = new Map<number, HTMLButtonElement>();

  private headings: HeadingNode[] = [];
  private levels: number[] = [];
  private position: PillPosition = 'top-center';
  private themeMode: ThemeMode = 'auto';
  private pathOptions: PathOptions = { ...DEFAULT_PATH_OPTIONS };
  private snapshot: TrackerSnapshot = { ...EMPTY_SNAPSHOT };
  private presentation: Presentation = { ...DEFAULT_PRESENTATION };

  private mediaQuery: MediaQueryList | null = null;
  private closeTimer = 0;
  private drawerOpen = false;
  private pinned = false;
  private pathKey = '';
  private currentIndex = -2;
  private progressLabel = '';
  private floatingPosition: FloatingPosition | null = null;
  private pillRect: { left: number; top: number; width: number; height: number } | null = null;
  private drag:
    | {
        pointerId: number;
        startX: number;
        startY: number;
        offsetX: number;
        offsetY: number;
        width: number;
        height: number;
        moved: boolean;
      }
    | null = null;
  private suppressClickUntil = 0;

  constructor(
    private readonly onJump: (index: number) => void,
    private readonly onError?: (action: string, error: unknown) => void,
    private readonly onFloatingPositionChange?: (
      position: FloatingPosition | null,
    ) => void,
  ) {}

  mount(headings: HeadingNode[]): void {
    this.headings = headings;
    this.levels = headings.map((node) => node.level);
    this.destroy();

    const host = document.createElement('div');
    host.id = HOST_ID;
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = styleText;
    shadow.appendChild(style);

    const progressLayer = document.createElement('div');
    progressLayer.className = 'wss-global-progress';
    progressLayer.dataset.visible = 'false';
    progressLayer.style.setProperty('--wss-z-index', String(Z_INDEX));
    progressLayer.innerHTML = '<i></i>';

    const root = document.createElement('div');
    root.className = 'wss-root';
    root.dataset.visible = 'false';
    root.dataset.position = this.position;
    root.dataset.pinned = 'false';
    root.dataset.dragging = 'false';
    root.dataset.wssActive = 'true';
    root.style.setProperty('--wss-z-index', String(Z_INDEX));
    root.setAttribute('role', 'navigation');
    root.setAttribute('aria-label', '当前章节位置');
    root.innerHTML = `
      <div class="wss-pill" part="pill">
        <span class="wss-icon">${ICON_SVG}</span>
        <div class="wss-glass-title" data-wss-role="heading" role="button" tabindex="0"
             aria-label="展开或固定文章目录"></div>
      </div>
      <div class="wss-below">
        <div class="wss-drawer" part="drawer">
          <div class="wss-drawer-head">
            <span class="wss-drawer-title">文章目录</span>
            <span class="wss-drawer-progress"></span>
          </div>
          <div class="wss-drawer-path"></div>
          <div class="wss-outline" role="list"></div>
        </div>
      </div>
    `;
    shadow.appendChild(root);
    shadow.appendChild(progressLayer);

    this.host = host;
    this.root = root;
    this.pill = root.querySelector<HTMLDivElement>('.wss-pill');
    this.glassTitle = root.querySelector<HTMLElement>('.wss-glass-title');
    this.progressLayer = progressLayer;
    this.progressFill = progressLayer.querySelector<HTMLElement>('i');
    this.below = root.querySelector<HTMLDivElement>('.wss-below');
    this.drawer = root.querySelector<HTMLDivElement>('.wss-drawer');
    this.drawerPath = root.querySelector<HTMLDivElement>('.wss-drawer-path');
    this.drawerProgress = root.querySelector<HTMLElement>('.wss-drawer-progress');
    this.rows = new Map();

    const outline = root.querySelector<HTMLDivElement>('.wss-outline');
    if (outline) outline.appendChild(this.buildOutline());

    root.addEventListener('click', this.handleClick);
    root.addEventListener('pointerenter', this.handleEnter, true);
    root.addEventListener('pointerleave', this.handleLeave, true);
    root.addEventListener('focusin', this.handleEnter, true);
    root.addEventListener('focusout', this.handleLeave, true);
    root.addEventListener('keydown', this.handleKeyDown);
    this.pill?.addEventListener('pointerdown', this.handleDragStart);
    this.pill?.addEventListener('pointermove', this.handleGlassPointerMove);
    this.pill?.addEventListener('dblclick', this.handlePillDoubleClick);
    window.addEventListener('keydown', this.handleWindowKeyDown, true);
    window.addEventListener('pointerdown', this.handleOutsidePointerDown, true);
    window.addEventListener('pointermove', this.handleDragMove, { passive: false });
    window.addEventListener('pointerup', this.handleDragEnd);
    window.addEventListener('pointercancel', this.handleDragEnd);
    window.addEventListener('resize', this.handleViewportResize, { passive: true });

    if (typeof window.matchMedia === 'function') {
      this.mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      this.mediaQuery.addEventListener('change', this.applyTheme);
    }
    this.applyTheme();

    // 挂到 documentElement 而不是 body：body 上的 transform/filter 不会影响 fixed 定位
    document.documentElement.appendChild(host);
  }

  destroy(): void {
    this.clearCloseTimer();
    if (this.root) {
      this.root.removeEventListener('click', this.handleClick);
      this.root.removeEventListener('pointerenter', this.handleEnter, true);
      this.root.removeEventListener('pointerleave', this.handleLeave, true);
      this.root.removeEventListener('focusin', this.handleEnter, true);
      this.root.removeEventListener('focusout', this.handleLeave, true);
      this.root.removeEventListener('keydown', this.handleKeyDown);
    }
    this.pill?.removeEventListener('pointerdown', this.handleDragStart);
    this.pill?.removeEventListener('pointermove', this.handleGlassPointerMove);
    this.pill?.removeEventListener('dblclick', this.handlePillDoubleClick);
    window.removeEventListener('keydown', this.handleWindowKeyDown, true);
    window.removeEventListener('pointerdown', this.handleOutsidePointerDown, true);
    window.removeEventListener('pointermove', this.handleDragMove);
    window.removeEventListener('pointerup', this.handleDragEnd);
    window.removeEventListener('pointercancel', this.handleDragEnd);
    window.removeEventListener('resize', this.handleViewportResize);
    this.mediaQuery?.removeEventListener('change', this.applyTheme);
    this.mediaQuery = null;
    this.host?.remove();
    this.host = null;
    this.root = null;
    this.pill = null;
    this.glassTitle = null;
    this.progressLayer = null;
    this.progressFill = null;
    this.below = null;
    this.drawer = null;
    this.drawerPath = null;
    this.drawerProgress = null;
    this.rows = new Map();
    this.pathKey = '';
    this.currentIndex = -2;
    this.drawerOpen = false;
    this.pinned = false;
    this.progressLabel = '';
    this.floatingPosition = null;
    this.pillRect = null;
    this.drag = null;
    this.snapshot = { ...EMPTY_SNAPSHOT };
    this.presentation = { ...DEFAULT_PRESENTATION };
  }

  setTop(px: number): void {
    this.root?.style.setProperty('--wss-top', `${Math.round(px)}px`);
    this.pillRect = null;
    this.layoutDrawer();
  }

  setDiagnostics(scope: string, stats: string): void {
    if (!this.root) return;
    this.root.dataset.wssScope = scope;
    this.root.dataset.wssStats = stats;
  }

  setZIndex(value: number): void {
    const zIndex = String(Math.max(1, Math.round(value)));
    this.root?.style.setProperty('--wss-z-index', zIndex);
    this.progressLayer?.style.setProperty('--wss-z-index', zIndex);
  }

  setPosition(position: PillPosition): void {
    this.position = position;
    if (!this.floatingPosition && this.root) this.root.dataset.position = position;
    this.applyFloatingPosition();
  }

  setFloatingPosition(position: FloatingPosition | null): void {
    this.floatingPosition = position;
    this.applyFloatingPosition();
  }

  setTheme(mode: ThemeMode): void {
    this.themeMode = mode;
    this.applyTheme();
  }

  setPathOptions(options: Partial<PathOptions>): void {
    this.pathOptions = { ...this.pathOptions, ...options };
    this.pathKey = '';
  }

  update(snapshot: TrackerSnapshot): void {
    this.snapshot = snapshot;
    this.render();
  }

  setPresentation(next: Partial<Presentation>): void {
    this.presentation = { ...this.presentation, ...next };
    this.render();
  }

  isDrawerOpen(): boolean {
    return this.drawerOpen;
  }

  // ── 渲染 ────────────────────────────────────────────

  private render(): void {
    const root = this.root;
    if (!root) return;

    const { snapshot, presentation } = this;
    const current = snapshot.index >= 0 ? this.headings[snapshot.index] : undefined;
    // 文章大标题不作为“章节”吸顶：还停在引言时保持静默
    const suppressed =
      !!current &&
      this.pathOptions.hideArticleTitle &&
      current.level === 1 &&
      this.levels.some((level) => level > 1);
    const visible = !!current && !suppressed && presentation.visible;

    root.dataset.visible = String(visible);
    root.dataset.dim = String(visible && presentation.dim);
    root.dataset.compact = String(presentation.compact);
    // 整篇进度线是全局阅读反馈，不跟胶囊的智能显隐一起消失。
    if (this.progressLayer) this.progressLayer.dataset.visible = 'true';
    if (this.progressFill) {
      this.progressFill.style.width = `${(snapshot.progress * 100).toFixed(1)}%`;
    }
    const progressLabel = `${Math.round(snapshot.progress * 100)}%`;
    if (this.drawerProgress && progressLabel !== this.progressLabel) {
      this.drawerProgress.textContent = progressLabel;
      this.progressLabel = progressLabel;
    }

    if (!visible) {
      this.unpin();
      this.currentIndex = -2;
      return;
    }

    if (presentation.compact && this.drawerOpen) this.closeDrawer();

    this.renderGlassTitle(snapshot.index);

    const key = [
      snapshot.path.join('>'),
      this.pathOptions.hideArticleTitle ? 'h1-hidden' : 'h1-shown',
      this.pathOptions.maxCrumbs,
      presentation.compact ? 'compact' : 'full',
    ].join('|');
    if (key !== this.pathKey) {
      this.renderDrawerPath(snapshot, presentation);
      this.pathKey = key;
    }

    if (snapshot.index !== this.currentIndex) {
      this.highlightRows(snapshot);
      this.currentIndex = snapshot.index;
    }

  }

  private renderGlassTitle(index: number): void {
    const title = this.glassTitle;
    const node = this.headings[index];
    if (!title || !node) return;
    const text = node.text || '(无标题)';
    const changed = title.textContent !== text;
    title.textContent = text;
    title.title = `${node.text}（点击固定目录）`;
    title.dataset.wssIndex = String(index);
    if (changed) {
      requestAnimationFrame(() => {
        if (this.floatingPosition) this.applyFloatingPosition();
        else this.capturePillRect();
      });
    }
  }

  /** 大纲按标题树渲染成嵌套列表：层级关系一眼能看出来 */
  private buildOutline(): HTMLOListElement {
    const children = this.headings.map(() => [] as number[]);
    const roots: number[] = [];
    this.headings.forEach((node, index) => {
      const parent = node.parentIndex;
      if (parent >= 0 && parent < this.headings.length) children[parent].push(index);
      else roots.push(index);
    });

    const build = (indices: number[], depth: number): HTMLOListElement => {
      const list = document.createElement('ol');
      list.className = 'wss-outline-level';
      if (depth > 0) list.dataset.depth = String(depth);
      for (const index of indices) {
        const node = this.headings[index];
        if (!node) continue;
        const item = document.createElement('li');
        item.className = 'wss-outline-item';
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'wss-row';
        row.dataset.wssIndex = String(index);
        row.textContent = node.text;
        row.title = node.text;
        item.appendChild(row);
        this.rows.set(index, row);
        const subtree = children[index];
        if (subtree.length > 0) item.appendChild(build(subtree, depth + 1));
        list.appendChild(item);
      }
      return list;
    };

    return build(roots, 0);
  }

  /** 大纲顶部的“上级路径”：胶囊里不堆层级，层级放这里 */
  private renderDrawerPath(snapshot: TrackerSnapshot, presentation: Presentation): void {
    const path = this.drawerPath;
    if (!path) return;
    path.replaceChildren();

    const node = this.headings[snapshot.index];
    if (!node) return;

    let ancestors: number[] = [];
    if (!presentation.compact) {
      const visible = buildVisiblePath(snapshot.path, this.levels, this.pathOptions);
      ancestors = [...visible.collapsed, ...visible.indexes].filter(
        (index) => index !== snapshot.index,
      );
    }
    if (ancestors.length === 0) {
      path.hidden = true;
      return;
    }
    path.hidden = false;

    ancestors.forEach((headingIndex, position) => {
      const ancestor = this.headings[headingIndex];
      if (!ancestor) return;
      if (position > 0) {
        const separator = document.createElement('span');
        separator.className = 'wss-sep';
        separator.textContent = '›';
        separator.setAttribute('aria-hidden', 'true');
        path.appendChild(separator);
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'wss-crumb';
      button.dataset.wssIndex = String(headingIndex);
      button.textContent = ancestor.text || '(无标题)';
      button.title = ancestor.text;
      path.appendChild(button);
    });
  }

  private highlightRows(snapshot: TrackerSnapshot): void {
    const inPath = new Set(snapshot.path);
    for (const [index, row] of this.rows) {
      row.dataset.inPath = String(inPath.has(index));
      row.dataset.current = String(index === snapshot.index);
      if (index === snapshot.index) row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
    }
    if (this.drawerOpen) this.scrollRowIntoDrawer(snapshot.index);
  }

  // ── 抽屉交互 ────────────────────────────────────────

  private openDrawer = (): void => {
    this.clearCloseTimer();
    if (this.drawerOpen || !this.drawer || this.presentation.compact) return;
    this.layoutDrawer();
    this.drawerOpen = true;
    this.drawer.classList.add('is-open');
    this.scrollRowIntoDrawer(this.currentIndex);
  };

  private closeDrawer = (): void => {
    this.clearCloseTimer();
    this.pinned = false;
    if (this.root) this.root.dataset.pinned = 'false';
    if (!this.drawerOpen || !this.drawer) return;
    this.drawerOpen = false;
    this.drawer.classList.remove('is-open');
  };

  private unpin(): void {
    this.pinned = false;
    if (this.root) this.root.dataset.pinned = 'false';
    if (this.drawerOpen) this.closeDrawer();
  }

  /** 点击标题：把大纲钉住 / 取消钉住 */
  private togglePin(): void {
    if (this.presentation.compact) return;
    if (this.pinned) {
      this.closeDrawer();
      return;
    }
    this.pinned = true;
    if (this.root) this.root.dataset.pinned = 'true';
    this.openDrawer();
  }

  private clearCloseTimer(): void {
    if (this.closeTimer !== 0) {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = 0;
    }
  }

  private safely(action: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.onError?.(action, error);
    }
  }

  /**
   * 只滚动抽屉自身，绝不调用 scrollIntoView：
   * 抽屉挂在 fixed 宿主里，scrollIntoView 会连整页一起滚。
   */
  private scrollRowIntoDrawer(index: number): void {
    const drawer = this.drawer;
    const row = this.rows.get(index);
    if (!drawer || !row) return;
    const rowRect = row.getBoundingClientRect();
    const top = rowRect.top - drawer.getBoundingClientRect().top + drawer.scrollTop;
    const bottom = top + rowRect.height;
    const viewTop = drawer.scrollTop;
    const viewBottom = viewTop + drawer.clientHeight;
    if (top < viewTop + 24) {
      drawer.scrollTop = Math.max(0, top - 24);
    } else if (bottom > viewBottom - 12) {
      drawer.scrollTop = bottom - drawer.clientHeight + 12;
    }
  }

  private applyFloatingPosition(): void {
    const root = this.root;
    const pill = this.pill;
    if (!root || !pill) return;
    if (!this.floatingPosition) {
      root.dataset.position = this.position;
      root.style.removeProperty('left');
      root.style.removeProperty('top');
      this.capturePillRect();
      this.layoutDrawer();
      return;
    }

    const rect = pill.getBoundingClientRect();
    const width = rect.width || 280;
    const height = rect.height || 38;
    const maxX = Math.max(0, window.innerWidth - width - 16);
    const maxY = Math.max(0, window.innerHeight - height - 16);
    const left = 8 + (this.floatingPosition.x / 100) * maxX;
    const top = 8 + (this.floatingPosition.y / 100) * maxY;
    this.applyPixelPosition(left, top);
  }

  private applyPixelPosition(left: number, top: number): void {
    const root = this.root;
    if (!root) return;
    root.dataset.position = 'custom';
    root.style.left = `${Math.round(left)}px`;
    root.style.top = `${Math.round(top)}px`;
    if (this.pillRect) {
      this.pillRect.left = Math.round(left);
      this.pillRect.top = Math.round(top);
    }
    this.layoutDrawer();
  }

  /**
   * 自由拖动后，目录不能仍然假设自己在顶部。
   * 下方空间不足就向上展开，左右空间不足就换边，保证控件始终留在视口内。
   */
  private layoutDrawer(): void {
    const root = this.root;
    const below = this.below;
    const pill = this.pill;
    if (!root || !below || !pill) return;

    const rect = pill.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const margin = 12;
    const gap = 6;
    const availableBelow = window.innerHeight - rect.bottom - gap - margin;
    const availableAbove = rect.top - gap - margin;
    const placement = availableBelow >= 210 || availableBelow >= availableAbove ? 'below' : 'above';
    const availableHeight =
      placement === 'below' ? availableBelow : availableAbove;
    const maxHeight = Math.max(96, Math.min(520, Math.floor(availableHeight)));
    below.dataset.placement = placement;
    root.style.setProperty('--wss-drawer-max-height', `${maxHeight}px`);

    if (!this.floatingPosition) {
      root.dataset.drawerAlign = this.position === 'top-right' ? 'right' : 'center';
      return;
    }

    const leftSpace = rect.left - margin;
    const rightSpace = window.innerWidth - rect.right - margin;
    root.dataset.drawerAlign = rightSpace >= leftSpace ? 'left' : 'right';
  }

  private handleViewportResize = (): void => {
    this.safely('ui:resize', () => {
      this.applyFloatingPosition();
      this.layoutDrawer();
    });
  };

  private normalizedPosition(
    left: number,
    top: number,
    width: number,
    height: number,
  ): FloatingPosition {
    const maxX = Math.max(1, window.innerWidth - width - 16);
    const maxY = Math.max(1, window.innerHeight - height - 16);
    return {
      x: Math.round(Math.max(0, Math.min(100, ((left - 8) / maxX) * 100)) * 10) / 10,
      y: Math.round(Math.max(0, Math.min(100, ((top - 8) / maxY) * 100)) * 10) / 10,
    };
  }

  private handleDragStart = (event: PointerEvent): void => {
    this.safely('ui:drag-start', () => {
      if (!this.pill || event.button !== 0) return;
      const rect = this.pill.getBoundingClientRect();
      this.pillRect = {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      };
      this.drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        width: rect.width,
        height: rect.height,
        moved: false,
      };
      this.closeDrawer();
      try {
        this.pill.setPointerCapture(event.pointerId);
      } catch {
        /* pointer capture 不可用时仍可用 window 监听完成拖动 */
      }
    });
  };

  private handleGlassPointerMove = (event: PointerEvent): void => {
    this.safely('ui:glass-pointer', () => {
      const pill = this.pill;
      if (!pill) return;
      const rect = this.pillRect ?? this.capturePillRect();
      if (!rect) return;
      if (rect.width <= 0 || rect.height <= 0) return;
      pill.style.setProperty(
        '--wss-pointer-x',
        `${Math.round(((event.clientX - rect.left) / rect.width) * 100)}%`,
      );
      pill.style.setProperty(
        '--wss-pointer-y',
        `${Math.round(((event.clientY - rect.top) / rect.height) * 100)}%`,
      );
    });
  };

  private capturePillRect(): {
    left: number;
    top: number;
    width: number;
    height: number;
  } | null {
    const rect = this.pill?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    this.pillRect = {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
    return this.pillRect;
  }

  private handleDragMove = (event: PointerEvent): void => {
    this.safely('ui:drag-move', () => {
      const drag = this.drag;
      const root = this.root;
      if (!drag || !root || drag.pointerId !== event.pointerId) return;
      if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) {
        return;
      }
      drag.moved = true;
      event.preventDefault();
      root.dataset.dragging = 'true';
      const maxX = Math.max(8, window.innerWidth - drag.width - 8);
      const maxY = Math.max(8, window.innerHeight - drag.height - 8);
      const left = Math.max(8, Math.min(maxX, event.clientX - drag.offsetX));
      const top = Math.max(8, Math.min(maxY, event.clientY - drag.offsetY));
      this.applyPixelPosition(left, top);
    });
  };

  private handleDragEnd = (event: PointerEvent): void => {
    this.safely('ui:drag-end', () => {
      const drag = this.drag;
      const root = this.root;
      const pill = this.pill;
      if (!drag || !root || drag.pointerId !== event.pointerId) return;
      this.drag = null;
      root.dataset.dragging = 'false';
      try {
        pill?.releasePointerCapture(event.pointerId);
      } catch {
        /* ignore */
      }
      if (!drag.moved || !pill) return;

      const rect = pill.getBoundingClientRect();
      this.pillRect = {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      };
      this.suppressClickUntil = Date.now() + 350;
      this.floatingPosition = this.normalizedPosition(rect.left, rect.top, rect.width, rect.height);
      this.onFloatingPositionChange?.(this.floatingPosition);
    });
  };

  private handlePillDoubleClick = (event: MouseEvent): void => {
    this.safely('ui:drag-reset', () => {
      event.preventDefault();
      event.stopPropagation();
      this.suppressClickUntil = Date.now() + 350;
      this.floatingPosition = null;
      this.onFloatingPositionChange?.(null);
      this.applyFloatingPosition();
      this.closeDrawer();
    });
  };

  private handleClick = (event: MouseEvent): void => {
    this.safely('ui:click', () => {
      if (Date.now() < this.suppressClickUntil) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const target = event.target as HTMLElement | null;
      const trigger = target?.closest<HTMLElement>('[data-wss-index], [data-wss-role="heading"]');
      if (!trigger) return;
      event.stopPropagation();
      // 点击胶囊里的标题 → 固定/取消固定目录
      if (trigger.dataset.wssRole === 'heading') {
        this.togglePin();
        return;
      }
      const index = Number.parseInt(trigger.dataset.wssIndex ?? '', 10);
      if (Number.isFinite(index)) this.onJump(index);
    });
  };

  private handleEnter = (event: Event): void => {
    this.safely('ui:enter', () => {
      if (this.drag) return;
      const target = event.target as HTMLElement | null;
      if (!target?.closest(HOVER_TARGET)) return;
      this.capturePillRect();
      this.clearCloseTimer();
      this.openDrawer();
    });
  };

  private handleLeave = (event: Event): void => {
    this.safely('ui:leave', () => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest(HOVER_TARGET)) return;
      this.clearCloseTimer();
      // 被钉住的大纲不随鼠标离开而收起
      if (this.pinned) return;
      this.closeTimer = window.setTimeout(() => {
        this.closeTimer = 0;
        this.safely('ui:close', () => {
          if (!this.pinned) this.closeDrawer();
        });
      }, CLOSE_DELAY);
    });
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    this.safely('ui:key', () => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const target = event.target as HTMLElement | null;
      if (target?.dataset.wssRole === 'heading') {
        event.preventDefault();
        this.togglePin();
      }
    });
  };

  private handleWindowKeyDown = (event: KeyboardEvent): void => {
    this.safely('ui:escape', () => {
      if (event.key === 'Escape') this.closeDrawer();
    });
  };

  /** 点到 UI 之外就取消钉住 */
  private handleOutsidePointerDown = (event: Event): void => {
    this.safely('ui:outside', () => {
      if (!this.drawerOpen || !this.host) return;
      if (event.composedPath().includes(this.host)) return;
      this.closeDrawer();
    });
  };

  private applyTheme = (): void => {
    this.safely('ui:theme', () => {
      if (!this.root) return;
      const prefersDark = this.mediaQuery ? this.mediaQuery.matches : false;
      const resolved = this.themeMode === 'auto' ? (prefersDark ? 'dark' : 'light') : this.themeMode;
      this.root.dataset.theme = resolved;
      if (this.progressLayer) this.progressLayer.dataset.theme = resolved;
    });
  };
}
