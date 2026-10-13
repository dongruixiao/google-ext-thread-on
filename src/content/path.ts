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
