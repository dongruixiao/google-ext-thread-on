import styleText from './style.css?inline';
import type { HeadingNode } from './extractor';
import { BAR_PADDING_BLOCK, cloneHeading, estimateHeadingHeight } from './heading-clone';
import type { Appearance, BarWidth, PillPosition, ThemeMode } from '../shared/settings';
import { HOST_ID } from '../shared/constants';
import { buildVisiblePath, decideInlinePath, type PathOptions } from './path';
import type { PageStyle } from './palette';
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

export interface ColumnBox {
  left: number;
  right: number;
  width: number;
}

const DEFAULT_PRESENTATION: Presentation = { visible: true, dim: false, compact: false };
const DEFAULT_PATH_OPTIONS: PathOptions = { hideArticleTitle: true, maxCrumbs: 3 };

const HOVER_TARGET = '.wss-pill, .wss-bar-inner, .wss-drawer';

/**
 * Shadow DOM 渲染层，支持两种形态：
 * - bar：吸顶条。把当前标题**原样克隆**进来（字体、字号、颜色全部照搬页面），
 *        悬停展开大纲，点击标题可以把大纲钉住。
 * - pill：悬浮毛玻璃胶囊，用插件自己的紧凑排版显示层级链。
 */
export class StickyUI {
  private host: HTMLDivElement | null = null;
  private root: HTMLDivElement | null = null;
  private crumbs: HTMLOListElement | null = null;
  private headingSlot: HTMLElement | null = null;
  private inlinePath: HTMLElement | null = null;
  private drawer: HTMLDivElement | null = null;
  private drawerPath: HTMLDivElement | null = null;
  private drawerProgress: HTMLElement | null = null;
  /** 进度条在两种形态里各有一个节点，宽度要一起更新 */
  private progressFills: HTMLElement[] = [];
  /** 大纲行：标题下标 → 行按钮 */
  private rows = new Map<number, HTMLButtonElement>();

  private headings: HeadingNode[] = [];
  private levels: number[] = [];
  private position: PillPosition = 'top-center';
  private themeMode: ThemeMode = 'auto';
  private appearance: Appearance = 'bar';
  private barWidth: BarWidth = 'full';
  private pathOptions: PathOptions = { ...DEFAULT_PATH_OPTIONS };
  private pathMode: 'off' | 'adaptive' | 'always' = 'adaptive';
  private snapshot: TrackerSnapshot = { ...EMPTY_SNAPSHOT };
  private presentation: Presentation = { ...DEFAULT_PRESENTATION };

  private mediaQuery: MediaQueryList | null = null;
  private closeTimer = 0;
  private drawerOpen = false;
  private pinned = false;
  private crumbsKey = '';
  private cloneIndex = -2;
  private currentIndex = -2;
  private progressLabel = '';

  constructor(private readonly onJump: (index: number) => void) {}

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
    root.dataset.position = this.position;
    root.dataset.appearance = this.appearance;
    root.dataset.barWidth = this.barWidth;
    root.dataset.pinned = 'false';
    root.setAttribute('role', 'navigation');
    root.setAttribute('aria-label', '当前章节位置');
    root.innerHTML = `
      <div class="wss-bar" part="bar">
        <div class="wss-bar-sheet" aria-hidden="true"></div>
        <div class="wss-bar-inner">
          <div class="wss-bar-path" hidden></div>
          <div class="wss-bar-heading" data-wss-role="heading" role="button" tabindex="0"
               aria-label="展开或固定文章目录"></div>
          <span class="wss-bar-caret" aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 16 16"><path d="M4 6.5 8 10.5l4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
          </span>
          <span class="wss-progress" aria-hidden="true"><i></i></span>
        </div>
      </div>
      <div class="wss-pill" part="pill">
        <span class="wss-icon">${ICON_SVG}</span>
        <ol class="wss-crumbs"></ol>
        <span class="wss-progress" aria-hidden="true"><i></i></span>
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

    this.host = host;
    this.root = root;
    this.crumbs = root.querySelector<HTMLOListElement>('.wss-pill > .wss-crumbs');
    this.headingSlot = root.querySelector<HTMLElement>('.wss-bar-heading');
    this.inlinePath = root.querySelector<HTMLElement>('.wss-bar-path');
    this.drawer = root.querySelector<HTMLDivElement>('.wss-drawer');
    this.drawerPath = root.querySelector<HTMLDivElement>('.wss-drawer-path');
    this.drawerProgress = root.querySelector<HTMLElement>('.wss-drawer-progress');
    this.progressFills = [...root.querySelectorAll<HTMLElement>('.wss-progress > i')];
    this.rows = new Map();

    const outline = root.querySelector<HTMLDivElement>('.wss-outline');
    if (outline) outline.appendChild(this.buildOutline());

    root.addEventListener('click', this.handleClick);
    root.addEventListener('pointerenter', this.handleEnter, true);
    root.addEventListener('pointerleave', this.handleLeave, true);
    root.addEventListener('focusin', this.handleEnter, true);
    root.addEventListener('focusout', this.handleLeave, true);
    root.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keydown', this.handleWindowKeyDown, true);
    window.addEventListener('pointerdown', this.handleOutsidePointerDown, true);

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
    window.removeEventListener('keydown', this.handleWindowKeyDown, true);
    window.removeEventListener('pointerdown', this.handleOutsidePointerDown, true);
    this.mediaQuery?.removeEventListener('change', this.applyTheme);
    this.mediaQuery = null;
    this.host?.remove();
    this.host = null;
    this.root = null;
    this.crumbs = null;
    this.headingSlot = null;
    this.inlinePath = null;
    this.drawer = null;
    this.drawerPath = null;
    this.drawerProgress = null;
    this.progressFills = [];
    this.rows = new Map();
    this.crumbsKey = '';
    this.cloneIndex = -2;
    this.currentIndex = -2;
    this.drawerOpen = false;
    this.pinned = false;
    this.progressLabel = '';
    this.snapshot = { ...EMPTY_SNAPSHOT };
    this.presentation = { ...DEFAULT_PRESENTATION };
  }

  setTop(px: number): void {
    this.root?.style.setProperty('--wss-top', `${Math.round(px)}px`);
  }

  setPosition(position: PillPosition): void {
    this.position = position;
    if (this.root) this.root.dataset.position = position;
  }

  setTheme(mode: ThemeMode): void {
    this.themeMode = mode;
    this.applyTheme();
  }

  setAppearance(appearance: Appearance): void {
    if (appearance === this.appearance) return;
    this.appearance = appearance;
    this.crumbsKey = '';
    this.cloneIndex = -2; // 形态切换后需要重新克隆并重新量高度
    if (this.root) this.root.dataset.appearance = appearance;
    this.render();
  }

  setBarWidth(width: BarWidth): void {
    this.barWidth = width;
    if (this.root) this.root.dataset.barWidth = width;
  }

  /** 正文列的位置：吸顶条按它对齐，看起来像是文章自己的标题栏 */
  setColumn(column: ColumnBox | null): void {
    const root = this.root;
    if (!root) return;
    if (!column) {
      root.style.removeProperty('--wss-col-left');
      root.style.removeProperty('--wss-col-width');
      root.style.removeProperty('--wss-col-right');
      return;
    }
    const viewport = window.innerWidth;
    const left = Math.max(0, Math.min(column.left, viewport));
    const right = Math.max(left, Math.min(column.right, viewport));
    root.style.setProperty('--wss-col-left', `${Math.round(left)}px`);
    root.style.setProperty('--wss-col-width', `${Math.round(right - left)}px`);
    root.style.setProperty('--wss-col-right', `${Math.round(viewport - right)}px`);
  }

  /** 用页面自身的配色给条与抽屉上色（标题本身由克隆自带样式） */
  setPageStyle(page: PageStyle): void {
    const root = this.root;
    if (!root) return;
    for (const [name, value] of [
      ['--wss-page-bg', page.background],
      ['--wss-page-fg', page.color],
    ] as const) {
      if (value) root.style.setProperty(name, value);
      else root.style.removeProperty(name);
    }
    root.style.setProperty('--wss-title-size', `${page.titleSize}px`);
    root.style.setProperty('--wss-title-weight', page.fontWeight);
    if (page.fontFamily) root.style.setProperty('--wss-page-font', page.fontFamily);
    if (page.letterSpacing) root.style.setProperty('--wss-letter-spacing', page.letterSpacing);
  }

  setPathOptions(options: Partial<PathOptions>): void {
    this.pathOptions = { ...this.pathOptions, ...options };
    this.crumbsKey = '';
  }

  setPathMode(mode: 'off' | 'adaptive' | 'always'): void {
    this.pathMode = mode;
    this.crumbsKey = '';
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

    if (!visible) {
      this.unpin();
      this.currentIndex = -2;
      return;
    }

    if (presentation.compact && this.drawerOpen) this.closeDrawer();

    this.ensureHeadingClone(snapshot.index);
    this.renderInlinePath(snapshot);

    const key = [
      snapshot.path.join('>'),
      this.pathOptions.hideArticleTitle ? 'h1-hidden' : 'h1-shown',
      this.pathOptions.maxCrumbs,
      presentation.compact ? 'compact' : 'full',
    ].join('|');
    if (key !== this.crumbsKey) {
      this.renderCrumbs(snapshot, presentation);
      this.renderDrawerPath(snapshot, presentation);
      this.crumbsKey = key;
    }

    if (snapshot.index !== this.currentIndex) {
      this.highlightRows(snapshot);
      this.currentIndex = snapshot.index;
    }

    const width = `${(snapshot.progress * 100).toFixed(1)}%`;
    for (const fill of this.progressFills) fill.style.width = width;

    const label = `${Math.round(snapshot.progress * 100)}%`;
    if (this.drawerProgress && label !== this.progressLabel) {
      this.drawerProgress.textContent = label;
      this.progressLabel = label;
    }
  }

  /** 吸顶主体：把网页里的当前标题原样克隆进条里 */
  /**
   * 上级路径：不做两行堆叠（太占视觉），而是在必要时把最近几级上级
   * 以小字内联在标题左侧；条高完全不变。
   */
  private renderInlinePath(snapshot: TrackerSnapshot): void {
    const host = this.inlinePath;
    if (!host) return;
    host.replaceChildren();

    const parentIndex = snapshot.path[snapshot.path.length - 2];
    const parent = parentIndex !== undefined ? this.headings[parentIndex] : undefined;
    const parentDistance = parent ? Math.round(-parent.element.getBoundingClientRect().bottom) : 0;

    const decision = decideInlinePath({
      mode: this.pathMode,
      path: snapshot.path,
      levels: this.levels,
      hideArticleTitle: this.pathOptions.hideArticleTitle,
      maxChips: 2,
      parentDistance,
      viewportHeight: window.innerHeight,
    });

    if (!decision.show || this.presentation.compact) {
      host.hidden = true;
      return;
    }
    host.hidden = false;

    if (decision.trimmed > 0) {
      const ellipsis = document.createElement('span');
      ellipsis.className = 'wss-path-more';
      ellipsis.textContent = '…';
      host.appendChild(ellipsis);
    }
    decision.indexes.forEach((headingIndex, position) => {
      const node = this.headings[headingIndex];
      if (!node) return;
      if (position > 0 || decision.trimmed > 0) {
        const separator = document.createElement('span');
        separator.className = 'wss-path-sep';
        separator.textContent = '›';
        host.appendChild(separator);
      }
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'wss-path-chip';
      chip.dataset.wssIndex = String(headingIndex);
      chip.textContent = node.text || '(无标题)';
      chip.title = node.text;
      host.appendChild(chip);
    });
  }
  private ensureHeadingClone(index: number): void {
    const slot = this.headingSlot;
    if (!slot) return;
    if (this.cloneIndex === index && slot.firstElementChild) {
      this.applyBarHeight();
      return;
    }
    const node = this.headings[index];
    slot.replaceChildren();
    this.cloneIndex = index;
    if (node) {
      const clone = cloneHeading(node.element);
      clone.dataset.wssClone = 'true';
      slot.appendChild(clone);
      slot.dataset.wssIndex = String(index);
      slot.title = `${node.text}（点击固定目录）`;
    }
    this.applyBarHeight();
  }

  /** 吸顶条高度跟着标题的自然高度走（VS Code 里行高决定 sticky 行高） */
  private applyBarHeight(): void {
    const root = this.root;
    const slot = this.headingSlot;
    if (!root || !slot) return;
    const node = this.cloneIndex >= 0 ? this.headings[this.cloneIndex] : undefined;
    const measured = slot.getBoundingClientRect().height;
    const height =
      measured > 4
        ? Math.round(measured + BAR_PADDING_BLOCK * 2)
        : estimateHeadingHeight(node?.element ?? null);
    root.style.setProperty('--wss-bar-height', `${height}px`);
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

  private renderCrumbs(snapshot: TrackerSnapshot, presentation: Presentation): void {
    const crumbs = this.crumbs;
    if (!crumbs) return;
    crumbs.replaceChildren();

    const visible = presentation.compact
      ? { indexes: [snapshot.index], collapsed: [] }
      : buildVisiblePath(snapshot.path, this.levels, this.pathOptions);
    const ancestors = presentation.compact ? [] : visible.collapsed;
    const sequence = [...ancestors, ...visible.indexes];

    if (ancestors.length > 0) {
      const item = document.createElement('li');
      item.className = 'wss-more-item';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'wss-more';
      button.dataset.role = 'ancestor';
      button.textContent = '…';
      button.title = `还有 ${ancestors.length} 级上级标题，悬停展开`;
      button.setAttribute('aria-label', `还有 ${ancestors.length} 级上级标题`);
      item.appendChild(button);
      crumbs.appendChild(item);
    }

    sequence.forEach((headingIndex, positionInSequence) => {
      const node = this.headings[headingIndex];
      if (!node) return;

      if (positionInSequence > 0) {
        const separator = document.createElement('li');
        separator.className = 'wss-sep';
        separator.textContent = '›';
        separator.setAttribute('aria-hidden', 'true');
        crumbs.appendChild(separator);
      }

      const isCurrent = headingIndex === snapshot.index;
      const item = document.createElement('li');
      if (ancestors.includes(headingIndex)) item.className = 'is-ancestor';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'wss-crumb';
      button.dataset.role = isCurrent ? 'current' : 'ancestor';
      button.dataset.wssIndex = String(headingIndex);
      button.dataset.current = String(isCurrent);
      button.textContent = node.text || '(无标题)';
      button.title = node.text;
      item.appendChild(button);
      crumbs.appendChild(item);
    });
  }

  /** 大纲顶部的“上级路径”：吸顶条里不堆层级，层级放这里 */
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

  private handleClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    const trigger = target?.closest<HTMLElement>('[data-wss-index], [data-wss-role="heading"]');
    if (!trigger) return;
    event.stopPropagation();
    // 点击吸顶条里的标题 → 固定/取消固定目录
    if (trigger.dataset.wssRole === 'heading') {
      this.togglePin();
      return;
    }
    const index = Number.parseInt(trigger.dataset.wssIndex ?? '', 10);
    if (Number.isFinite(index)) this.onJump(index);
  };

  private handleEnter = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    if (!target?.closest(HOVER_TARGET)) return;
    this.clearCloseTimer();
    this.openDrawer();
  };

  private handleLeave = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    if (!target?.closest(HOVER_TARGET)) return;
    this.clearCloseTimer();
    // 被钉住的大纲不随鼠标离开而收起
    if (this.pinned) return;
    this.closeTimer = window.setTimeout(() => {
      this.closeTimer = 0;
      if (!this.pinned) this.closeDrawer();
    }, CLOSE_DELAY);
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target as HTMLElement | null;
    if (target?.dataset.wssRole === 'heading') {
      event.preventDefault();
      this.togglePin();
    }
  };

  private handleWindowKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.closeDrawer();
  };

  /** 点到 UI 之外就取消钉住 */
  private handleOutsidePointerDown = (event: Event): void => {
    if (!this.drawerOpen || !this.host) return;
    if (event.composedPath().includes(this.host)) return;
    this.closeDrawer();
  };

  private applyTheme = (): void => {
    if (!this.root) return;
    const prefersDark = this.mediaQuery ? this.mediaQuery.matches : false;
    const resolved = this.themeMode === 'auto' ? (prefersDark ? 'dark' : 'light') : this.themeMode;
    this.root.dataset.theme = resolved;
  };
}
