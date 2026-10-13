/**
 * 面包屑路径裁剪：决定“哪几级真的显示在胶囊里”。
 * 纯函数，便于单独测试。
 */

export interface VisiblePath {
  /** 需要展示的标题下标（从根到当前） */
  indexes: number[];
  /** 被折叠掉、可在悬停时展开的祖先下标 */
  collapsed: number[];
}

export interface PathOptions {
  /** 不显示文章大标题（h1 根级） */
  hideArticleTitle: boolean;
  /** 最多显示几级 */
  maxCrumbs: number;
}

export function buildVisiblePath(
  path: number[],
  levels: number[],
  options: PathOptions,
): VisiblePath {
  if (path.length === 0) return { indexes: [], collapsed: [] };

  let indexes = [...path];
  if (options.hideArticleTitle && indexes.length > 1 && levels[indexes[0]] === 1) {
    indexes = indexes.slice(1);
  }

  let collapsed: number[] = [];
  if (indexes.length > options.maxCrumbs) {
    collapsed = indexes.slice(0, indexes.length - options.maxCrumbs);
    indexes = indexes.slice(indexes.length - options.maxCrumbs);
  }

  // 兜底：全部被裁掉时至少保留当前小节，避免出现空胶囊
  if (indexes.length === 0) {
    indexes = [path[path.length - 1]];
  }

  return { indexes, collapsed };
}

export interface InlinePathDecision {
  /** 是否在吸顶条里显示上级路径 */
  show: boolean;
  /** 需要显示的上级下标（从根到近，只保留最后 maxChips 个） */
  indexes: number[];
  /** 被省略掉的上级数量（>0 时前面加一个 …） */
  trimmed: number;
}

export interface InlinePathOptions {
  mode: 'off' | 'adaptive' | 'always';
  /** 当前层级链（含当前标题） */
  path: number[];
  /** 隐藏文章大标题时的裁剪规则（与面包屑一致） */
  hideArticleTitle: boolean;
  levels: number[];
  /** 最多显示几个上级 */
  maxChips: number;
  /**
   * 最近一个上级标题的底边距视口顶部的距离（px，正数表示已经滚出屏幕上方多远）。
   * 只有在“上级已经离得很远”时按需显示才有意义。
   */
  parentDistance: number;
  viewportHeight: number;
}

/** 上级离得足够远才提醒：这个比例可调，越大越安静 */
export const INLINE_PATH_THRESHOLD = 0.9;

/**
 * 决定吸顶条里要不要显示上级路径。
 * 纯函数，便于单测：真正的产品判断是"上级标题已经滚出视野很久了，该提醒一下"。
 */
export function decideInlinePath(options: InlinePathOptions): InlinePathDecision {
  const empty: InlinePathDecision = { show: false, indexes: [], trimmed: 0 };
  if (options.mode === 'off') return empty;

  let path = [...options.path];
  if (options.hideArticleTitle && path.length > 1 && options.levels[path[0]] === 1) {
    path = path.slice(1);
  }
  const ancestors = path.slice(0, -1);
  if (ancestors.length === 0) return empty;

  if (options.mode === 'adaptive') {
    const farEnough = options.parentDistance >= options.viewportHeight * INLINE_PATH_THRESHOLD;
    if (!farEnough) return empty;
  }

  const visible = ancestors.slice(-options.maxChips);
  return { show: true, indexes: visible, trimmed: ancestors.length - visible.length };
}
