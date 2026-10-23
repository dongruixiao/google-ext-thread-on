/** Build the ancestor path shown by the outline header. */

export interface VisiblePath {
  /** Visible heading indexes, ordered from root to current. */
  indexes: number[];
  /** Ancestors collapsed behind the overflow affordance. */
  collapsed: number[];
}

export interface PathOptions {
  /** Hide the article-level h1 when nested headings exist. */
  hideArticleTitle: boolean;
  /** Maximum visible levels before collapsing ancestors. */
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

  // Never return an empty path after collapsing.
  if (indexes.length === 0) {
    indexes = [path[path.length - 1]];
  }

  return { indexes, collapsed };
}
