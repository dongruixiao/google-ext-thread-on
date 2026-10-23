/** Build the ancestor heading trail shown in the outline header. */
export function buildAncestorPath(
  path: number[],
  levels: number[],
  hideArticleTitle = true,
): number[] {
  if (path.length <= 1) return [];
  const start = hideArticleTitle && levels[path[0]] === 1 ? 1 : 0;
  return path.slice(start, -1);
}
