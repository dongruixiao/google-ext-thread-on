import styleText from './style.css?inline';
import type { HeadingNode } from './extractor';
import { buildVisiblePath, type PathOptions } from './path';
import type { FloatingPosition } from '../shared/settings';
import { HOST_ID, Z_INDEX } from '../shared/constants';

import type { TrackerSnapshot } from './tracker';
import { t } from '../shared/i18n';
import {
  normalizeFloatingPosition,
  resolveFloatingLayout,
} from './floating-position';

const ICON_SVG = `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.75 4h10.5M2.75 8h7.5M2.75 12h4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" fill="none"/></svg>`;

/** Delay before closing so the pointer can cross the gap into the drawer. */
const CLOSE_DELAY = 260;

const EMPTY_SNAPSHOT: TrackerSnapshot = { index: -1, path: [], progress: 0 };
const PROGRESS_RING_CIRCUMFERENCE = 88;

export interface Presentation {
  /** Whether visibility policy and page state allow rendering. */
  visible: boolean;
  /** Reduce prominence after a period of inactivity. */
  dim: boolean;
  /** Native contents are visible; suppress the custom drawer. */
  compact: boolean;
}

const DEFAULT_PRESENTATION: Presentation = { visible: true, dim: false, compact: false };
const DEFAULT_PATH_OPTIONS: PathOptions = { hideArticleTitle: true, maxCrumbs: 3 };

const HOVER_TARGET = '.wss-pill, .wss-drawer';

/** Isolated view for the floating chapter capsule and outline. */
export class StickyUI {
  private host: HTMLDivElement | null = null;
  private root: HTMLDivElement | null = null;
  private pill: HTMLDivElement | null = null;
  private chapterTitle: HTMLElement | null = null;
  private progressBadge: HTMLElement | null = null;
  private progressRing: SVGCircleElement | null = null;
  private below: HTMLDivElement | null = null;
  private drawer: HTMLDivElement | null = null;
  private drawerPath: HTMLDivElement | null = null;
  /** Heading index to outline row. */
  private rows = new Map<number, HTMLButtonElement>();

  private headings: HeadingNode[] = [];
  private levels: number[] = [];
  private readonly pathOptions: PathOptions = DEFAULT_PATH_OPTIONS;
  private snapshot: TrackerSnapshot = { ...EMPTY_SNAPSHOT };
  private presentation: Presentation = { ...DEFAULT_PRESENTATION };

  private mediaQuery: MediaQueryList | null = null;
  private closeTimer = 0;
  private drawerOpen = false;
  private pinned = false;
  private pathKey = '';
  private currentIndex = -2;
  private floatingPosition: FloatingPosition | null = null;
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
        latestLeft: number;
        latestTop: number;
      }
    | null = null;
  private dragFrame = 0;
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

    const root = document.createElement('div');
    root.className = 'wss-root';
    root.dataset.visible = 'false';
    root.dataset.position = 'top-center';
    root.dataset.pinned = 'false';
    root.dataset.dragging = 'false';
    root.dataset.wssActive = 'true';
    root.style.setProperty('--wss-z-index', String(Z_INDEX));
    root.setAttribute('role', 'navigation');
    root.setAttribute('aria-label', t('currentChapterAria'));
    root.innerHTML = `
      <div class="wss-pill" part="pill">
        <span class="wss-icon-badge" role="progressbar" aria-label="${t('readingProgressAria')}"
              aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
          <svg class="wss-progress-svg" viewBox="0 0 34 34" aria-hidden="true">
            <circle class="wss-progress-track" cx="17" cy="17" r="14"></circle>
            <circle class="wss-progress-ring" cx="17" cy="17" r="14"></circle>
          </svg>
          <span class="wss-icon">${ICON_SVG}</span>
        </span>
        <div class="wss-title" data-wss-role="heading" role="button" tabindex="0"
             aria-label="${t('outlineToggleAria')}"></div>
      </div>
      <div class="wss-below">
        <div class="wss-drawer" part="drawer">
          <div class="wss-drawer-path"></div>
          <div class="wss-outline" role="list"></div>
        </div>
      </div>
    `;
    shadow.appendChild(root);

    this.host = host;
    this.root = root;
    this.pill = root.querySelector<HTMLDivElement>('.wss-pill');
    this.chapterTitle = root.querySelector<HTMLElement>('.wss-title');
    this.progressBadge = root.querySelector<HTMLElement>('.wss-icon-badge');
    this.progressRing = root.querySelector<SVGCircleElement>('.wss-progress-ring');
    this.below = root.querySelector<HTMLDivElement>('.wss-below');
    this.drawer = root.querySelector<HTMLDivElement>('.wss-drawer');
    this.drawerPath = root.querySelector<HTMLDivElement>('.wss-drawer-path');
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

    // Attach to <html>: transforms or filters on <body> can break fixed positioning.
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
    this.chapterTitle = null;
    this.progressBadge = null;
    this.progressRing = null;
    this.below = null;
    this.drawer = null;
    this.drawerPath = null;
    this.rows = new Map();
    this.pathKey = '';
    this.currentIndex = -2;
    this.drawerOpen = false;
    this.pinned = false;
    this.floatingPosition = null;
    this.drag = null;
    if (this.dragFrame !== 0) {
      cancelAnimationFrame(this.dragFrame);
      this.dragFrame = 0;
    }
    this.snapshot = { ...EMPTY_SNAPSHOT };
    this.presentation = { ...DEFAULT_PRESENTATION };
  }

  setTop(px: number): void {
    this.root?.style.setProperty('--wss-top', `${Math.round(px)}px`);
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
  }

  setFloatingPosition(position: FloatingPosition | null): void {
    this.floatingPosition = position;
    this.applyFloatingPosition();
  }

  update(snapshot: TrackerSnapshot): void {
    this.snapshot = snapshot;
    this.render();
  }

  setPresentation(next: Partial<Presentation>): void {
    this.presentation = { ...this.presentation, ...next };
    this.render();
  }

  private render(): void {
    const root = this.root;
    if (!root) return;

    const { snapshot, presentation } = this;
    const current = snapshot.index >= 0 ? this.headings[snapshot.index] : undefined;
    // Keep the article-level h1 out of the chapter capsule.
    const suppressed =
      !!current &&
      this.pathOptions.hideArticleTitle &&
      current.level === 1 &&
      this.levels.some((level) => level > 1);
    const visible = !!current && !suppressed && presentation.visible;

    root.dataset.visible = String(visible);
    root.dataset.dim = String(visible && presentation.dim);
    root.dataset.compact = String(presentation.compact);
    const progress = Math.min(1, Math.max(0, snapshot.progress));
    if (this.progressRing) {
      this.progressRing.style.strokeDashoffset = String(
        PROGRESS_RING_CIRCUMFERENCE * (1 - progress),
      );
    }
    this.progressBadge?.setAttribute('aria-valuenow', String(Math.round(progress * 100)));
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
    const title = this.chapterTitle;
    const node = this.headings[index];
    if (!title || !node) return;
    const text = node.text || t('untitled');
    const changed = title.textContent !== text;
    title.textContent = text;
    title.title = t('outlineToggleAria');
    title.dataset.wssIndex = String(index);
    if (changed) {
      requestAnimationFrame(() => this.syncPillWidthLimit());
    }
  }

  /** Render the article heading tree as nested lists. */
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

  /** Show ancestors inside the drawer instead of expanding the capsule. */
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
      button.textContent = ancestor.text || t('untitled');
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

  /** Toggle the pinned state of the outline. */
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

  /** Scroll only the drawer; scrollIntoView would also move the host page. */
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
      root.dataset.position = 'top-center';
      root.style.removeProperty('--wss-x');
      root.style.removeProperty('--wss-y');
      this.syncPillWidthLimit();
      this.layoutDrawer();
      return;
    }

    pill.style.removeProperty('max-width');
    const rect = pill.getBoundingClientRect();
    const layout = resolveFloatingLayout(
      this.floatingPosition,
      { width: window.innerWidth, height: window.innerHeight },
      {
        width: rect.width || 180,
        height: rect.height || 40,
      },
    );
    pill.style.maxWidth = `${layout.maxWidth}px`;
    this.applyPixelPosition(layout.left, layout.top);
  }

  private applyPixelPosition(left: number, top: number): void {
    const root = this.root;
    if (!root) return;
    root.dataset.position = 'custom';
    root.style.setProperty('--wss-x', `${Math.round(left)}px`);
    root.style.setProperty('--wss-y', `${Math.round(top)}px`);
    this.layoutDrawer();
  }

  /** Flip the drawer above the capsule when there is not enough room below. */
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
  }

  private handleViewportResize = (): void => {
    this.safely('ui:resize', () => {
      this.applyFloatingPosition();
      this.layoutDrawer();
    });
  };

  /** Keep the left edge fixed while preventing long titles from overflowing. */
  private syncPillWidthLimit(): void {
    const root = this.root;
    const pill = this.pill;
    if (!root || !pill) return;
    pill.style.removeProperty('max-width');
    const left = root.getBoundingClientRect().left;
    const available = Math.max(140, window.innerWidth - left - 16);
    pill.style.maxWidth = `${Math.min(480, available)}px`;
  }

  private handleDragStart = (event: PointerEvent): void => {
    this.safely('ui:drag-start', () => {
      if (!this.pill || event.button !== 0) return;
      const rect = this.pill.getBoundingClientRect();
      this.drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        width: rect.width,
        height: rect.height,
        moved: false,
        latestLeft: rect.left,
        latestTop: rect.top,
      };
      this.closeDrawer();
      try {
        this.pill.setPointerCapture(event.pointerId);
      } catch {
        /* Window listeners still complete the drag without pointer capture. */
      }
    });
  };

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
      drag.latestLeft = left;
      drag.latestTop = top;
      if (this.dragFrame === 0) {
        this.dragFrame = requestAnimationFrame(this.flushDragFrame);
      }
    });
  };

  private flushDragFrame = (): void => {
    this.dragFrame = 0;
    const drag = this.drag;
    if (!drag) return;
    const root = this.root;
    if (!root) return;
    root.dataset.position = 'custom';
    root.style.setProperty('--wss-x', `${Math.round(drag.latestLeft)}px`);
    root.style.setProperty('--wss-y', `${Math.round(drag.latestTop)}px`);
  };

  private handleDragEnd = (event: PointerEvent): void => {
    this.safely('ui:drag-end', () => {
      const drag = this.drag;
      const root = this.root;
      const pill = this.pill;
      if (!drag || !root || drag.pointerId !== event.pointerId) return;
      if (this.dragFrame !== 0) {
        cancelAnimationFrame(this.dragFrame);
        this.dragFrame = 0;
      }
      root.style.setProperty('--wss-x', `${Math.round(drag.latestLeft)}px`);
      root.style.setProperty('--wss-y', `${Math.round(drag.latestTop)}px`);
      this.drag = null;
      root.dataset.dragging = 'false';
      try {
        pill?.releasePointerCapture(event.pointerId);
      } catch {
        /* ignore */
      }
      if (!drag.moved || !pill) return;

      this.suppressClickUntil = Date.now() + 350;
      this.floatingPosition = normalizeFloatingPosition(
        drag.latestLeft,
        drag.latestTop,
        { width: window.innerWidth, height: window.innerHeight },
        drag.height,
      );
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
      // The capsule title toggles the pinned outline.
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
      this.clearCloseTimer();
      this.openDrawer();
    });
  };

  private handleLeave = (event: Event): void => {
    this.safely('ui:leave', () => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest(HOVER_TARGET)) return;
      this.clearCloseTimer();
      // Pinned outlines remain open after the pointer leaves.
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

  /** Clicking outside the extension closes a pinned outline. */
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
      const resolved = prefersDark ? 'dark' : 'light';
      this.root.dataset.theme = resolved;
    });
  };
}
