/**
 * 判断页面顶部的到底是「站点框架」（导航条 / 遮罩），还是正文内容（粘性小节头等）。
 *
 * 目的：
 * 1. 站点导航条 → 吸顶条贴在它下面；
 * 2. 正文里的 sticky 元素 → 完全无视（否则条会跟着它掉到页面中间）；
 * 3. 全屏遮罩 / 对话框 → 收起 UI，不要浮在别人头上。
 */

import { isOpaqueColor } from './palette';

export interface ChromeCandidate {
  /** 元素顶部（视口坐标） */
  top: number;
  bottom: number;
  width: number;
  height: number;
  /** 自身或近亲祖先是否 fixed / sticky */
  positioned: boolean;
  /** 是否位于正文容器内部 */
  insideContent: boolean;
  /** 是否有实色背景或背景图（用于识别遮罩层） */
  opaque: boolean;
  /** 是否是页面弹层（dialog / aria-modal / role=dialog） */
  dialog: boolean;
  /** 自身或近亲祖先声明的最高 z-index */
  zIndex: number;
  visible: boolean;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface TopChrome {
  /** 需要避让的高度（0 表示直接贴视口顶部） */
  bottom: number;
  /** 顶部被遮罩层挡住，UI 应当收起 */
  blocked: boolean;
}

/** 探针在 y=4 处取样，允许元素顶边有一点误差 */
const PROBE_TOLERANCE = 6;
/** 站点导航条至少要覆盖视口这个比例才算“横条”，避免把固定侧栏算进来 */
const MIN_BAR_WIDTH_RATIO = 0.6;
/** 避让高度上限：超过这个比例说明不是导航条 */
const MAX_BAR_HEIGHT_RATIO = 0.35;
/** 遮罩层至少要覆盖视口这个比例的高度 */
const MIN_BLOCKER_HEIGHT_RATIO = 0.6;
/** 弹层（站点搜索面板、对话框）至少要有这么大，才值得让位 */
const MIN_DIALOG_WIDTH_RATIO = 0.2;
const MIN_DIALOG_HEIGHT = 80;

export function classifyTopChrome(candidates: ChromeCandidate[], viewport: Viewport): TopChrome {
  const cap = viewport.height * MAX_BAR_HEIGHT_RATIO;
  let bottom = 0;
  let blocked = false;

  for (const candidate of candidates) {
    if (!candidate.visible) continue;

    // 页面弹层：搜索面板 / 对话框 / aria-modal，只要盖住顶部就让位
    if (
      candidate.dialog &&
      candidate.width >= viewport.width * MIN_DIALOG_WIDTH_RATIO &&
      candidate.height >= MIN_DIALOG_HEIGHT
    ) {
      blocked = true;
      continue;
    }

    if (!candidate.positioned) continue;
    if (candidate.insideContent) continue; // 正文里的 sticky 属于内容，不是站点框架
    if (candidate.top > PROBE_TOLERANCE || candidate.bottom <= 0) continue;
    if (candidate.width < viewport.width * MIN_BAR_WIDTH_RATIO) continue; // 横向条，不是侧栏

    if (candidate.height <= cap) {
      bottom = Math.max(bottom, candidate.bottom);
      continue;
    }
    // 又宽又高又实心：多半是遮罩层 / 对话框背景
    if (candidate.opaque && candidate.height >= viewport.height * MIN_BLOCKER_HEIGHT_RATIO) {
      blocked = true;
    }
  }

  return { bottom: Math.round(Math.min(bottom, cap)), blocked };
}
/** 自身或近亲祖先是否 fixed / sticky（站点框架通常挂在这样的容器里） */
export function isPositionedWithin(element: HTMLElement, depth = 4): boolean {
  let node: HTMLElement | null = element;
  for (let level = 0; node && level <= depth; level += 1) {
    let position = '';
    try {
      position = getComputedStyle(node).position;
    } catch {
      return false;
    }
    if (position === 'fixed' || position === 'sticky') return true;
    node = node.parentElement;
  }
  return false;
}

/** 取元素及近亲祖先里声明的最高 z-index；auto / 非法值按 0 处理 */
export function effectiveZIndex(element: HTMLElement, depth = 5): number {
  let highest = 0;
  let node: HTMLElement | null = element;
  for (let level = 0; node && level <= depth; level += 1) {
    try {
      const value = Number.parseInt(getComputedStyle(node).zIndex, 10);
      if (Number.isFinite(value)) highest = Math.max(highest, value);
    } catch {
      /* 单个节点读不到样式不影响其它祖先 */
    }
    node = node.parentElement;
  }
  return highest;
}

/** 顶部探针处可能与我们同处一层的外来 UI，最高声明的层级是多少 */
export function highestForeignZIndex(candidates: ChromeCandidate[]): number {
  let highest = 0;
  for (const candidate of candidates) {
    if (!candidate.visible || candidate.insideContent) continue;
    if (!candidate.positioned && !candidate.dialog) continue;
    highest = Math.max(highest, candidate.zIndex);
  }
  return highest;
}

/** 是否有实色背景或背景图（遮罩层一般两者占其一） */
export function hasSurface(style: CSSStyleDeclaration): boolean {
  return isOpaqueColor(style.backgroundColor) || (style.backgroundImage !== '' && style.backgroundImage !== 'none');
}

