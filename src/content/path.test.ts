import { describe, expect, it } from 'vitest';
import { buildVisiblePath } from './path';
import { decideInlinePath, decidePathPlacement } from './path';

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

describe('decideInlinePath', () => {
  const base = {
    levels: [1, 2, 3],
    hideArticleTitle: true,
    maxChips: 2,
    viewportHeight: 800,
    parentDistance: 0,
  };

  it('关闭时永远不显示', () => {
    const result = decideInlinePath({ ...base, mode: 'off', path: [0, 1, 2], parentDistance: 5000 });
    expect(result.show).toBe(false);
  });

  it('按需模式：上级刚滚过去时不打扰', () => {
    const result = decideInlinePath({ ...base, mode: 'adaptive', path: [0, 1, 2], parentDistance: 300 });
    expect(result.show).toBe(false);
  });

  it('按需模式：上级已经滚出很远才显示（阈值 0.9 屏）', () => {
    const near = decideInlinePath({ ...base, mode: 'adaptive', path: [0, 1, 2], parentDistance: 700 });
    expect(near.show).toBe(false);
    const far = decideInlinePath({ ...base, mode: 'adaptive', path: [0, 1, 2], parentDistance: 760 });
    expect(far.show).toBe(true);
    expect(far.indexes).toEqual([1]);
    expect(far.trimmed).toBe(0);
  });

  it('总是显示：不带距离条件，并且会裁掉过远的祖先', () => {
    const result = decideInlinePath({
      ...base,
      mode: 'always',
      path: [0, 1, 2, 3],
      levels: [1, 2, 3, 4],
      parentDistance: 0,
    });
    expect(result.show).toBe(true);
    // 隐藏 h1 后是 [1,2,3]，上级是两个，全部显示
    expect(result.indexes).toEqual([1, 2]);
    expect(result.trimmed).toBe(0);
  });

  it('上级多于上限时只留最近的，并记录被省略的数量', () => {
    const result = decideInlinePath({
      ...base,
      mode: 'always',
      path: [0, 1, 2, 3],
      levels: [1, 2, 3, 4],
      maxChips: 1,
      parentDistance: 0,
    });
    expect(result.show).toBe(true);
    expect(result.indexes).toEqual([2]);
    expect(result.trimmed).toBe(1);
  });

  it('没有上级时不显示', () => {
    const result = decideInlinePath({ ...base, mode: 'always', path: [0, 1] });
    expect(result.show).toBe(false);
  });
});

describe('decidePathPlacement', () => {
  const base = { mode: 'always' as const, barWidth: 'full' as const, columnLeft: 0, columnRight: 0, minGutter: 96 };

  it('关闭时不放在任何地方', () => {
    expect(decidePathPlacement({ ...base, mode: 'off', columnLeft: 300 })).toBe('none');
  });

  it('左侧空白够 → 左侧', () => {
    expect(decidePathPlacement({ ...base, columnLeft: 150, columnRight: 150 })).toBe('left-gutter');
  });

  it('左侧不够但右侧够 → 右侧（适配左窄右宽的布局）', () => {
    expect(decidePathPlacement({ ...base, columnLeft: 40, columnRight: 300 })).toBe('right-gutter');
  });

  it('两侧都窄 → 退回条内右侧，由它先让步', () => {
    expect(decidePathPlacement({ ...base, columnLeft: 24, columnRight: 24 })).toBe('inline');
  });

  it('列宽模式没有条外空白 → 条内右侧', () => {
    expect(decidePathPlacement({ ...base, barWidth: 'column', columnLeft: 200, columnRight: 200 })).toBe('inline');
  });
});
