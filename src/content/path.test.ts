import { describe, expect, it } from 'vitest';
import { buildVisiblePath } from './path';

const LEVELS = [1, 2, 3, 3];

describe('buildVisiblePath', () => {
  it('hides the article title by default', () => {
    const result = buildVisiblePath([0, 1, 2], LEVELS, {
      hideArticleTitle: true,
      maxCrumbs: 3,
    });
    expect(result.indexes).toEqual([1, 2]);
    expect(result.collapsed).toEqual([]);
  });

  it('keeps the article title when configured', () => {
    const result = buildVisiblePath([0, 1, 2], LEVELS, {
      hideArticleTitle: false,
      maxCrumbs: 3,
    });
    expect(result.indexes).toEqual([0, 1, 2]);
  });

  it('collapses ancestors from the top when over the limit', () => {
    const result = buildVisiblePath([0, 1, 2, 3], LEVELS, {
      hideArticleTitle: true,
      maxCrumbs: 2,
    });
    expect(result.indexes).toEqual([2, 3]);
    expect(result.collapsed).toEqual([1]);
  });

  it('always keeps the current section', () => {
    const result = buildVisiblePath([0], LEVELS, {
      hideArticleTitle: true,
      maxCrumbs: 1,
    });
    expect(result.indexes).toEqual([0]);
    expect(result.collapsed).toEqual([]);
  });

  it('returns an empty path for empty input', () => {
    expect(buildVisiblePath([], LEVELS, { hideArticleTitle: true, maxCrumbs: 3 })).toEqual({
      indexes: [],
      collapsed: [],
    });
  });
});
