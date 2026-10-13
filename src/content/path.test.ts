import { describe, expect, it } from 'vitest';
import { buildVisiblePath } from './path';

const LEVELS = [1, 2, 3, 3];

describe('buildVisiblePath', () => {
  it('默认丢掉文章大标题，只留次级标题', () => {
    const result = buildVisiblePath([0, 1, 2], LEVELS, {
      hideArticleTitle: true,
      maxCrumbs: 3,
    });
    expect(result.indexes).toEqual([1, 2]);
    expect(result.collapsed).toEqual([]);
  });

  it('保留大标题时原样输出', () => {
    const result = buildVisiblePath([0, 1, 2], LEVELS, {
      hideArticleTitle: false,
      maxCrumbs: 3,
    });
    expect(result.indexes).toEqual([0, 1, 2]);
  });

  it('超过层级上限时从顶部折叠，保留最近的层级', () => {
    const result = buildVisiblePath([0, 1, 2, 3], LEVELS, {
      hideArticleTitle: true,
      maxCrumbs: 2,
    });
    expect(result.indexes).toEqual([2, 3]);
    expect(result.collapsed).toEqual([1]);
  });

  it('全部被裁掉时至少保留当前小节', () => {
    const result = buildVisiblePath([0], LEVELS, {
      hideArticleTitle: true,
      maxCrumbs: 1,
    });
    expect(result.indexes).toEqual([0]);
    expect(result.collapsed).toEqual([]);
  });

  it('空路径返回空结果', () => {
    expect(buildVisiblePath([], LEVELS, { hideArticleTitle: true, maxCrumbs: 3 })).toEqual({
      indexes: [],
      collapsed: [],
    });
  });
});
