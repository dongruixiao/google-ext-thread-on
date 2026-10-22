import { describe, expect, it } from 'vitest';
import {
  classifyTopChrome,
  highestForeignZIndex,
  type ChromeCandidate,
} from './chrome-detect';

const VIEWPORT = { width: 1200, height: 800 };

function candidate(overrides: Partial<ChromeCandidate> = {}): ChromeCandidate {
  return {
    top: 0,
    bottom: 64,
    width: 1200,
    height: 64,
    positioned: true,
    insideContent: false,
    opaque: true,
    dialog: false,
    zIndex: 0,
    visible: true,
    ...overrides,
  };
}

describe('classifyTopChrome', () => {
  it('识别站点顶部导航条，并给出避让高度', () => {
    const result = classifyTopChrome([candidate({ bottom: 64, height: 64 })], VIEWPORT);
    expect(result).toEqual({ bottom: 64, blocked: false });
  });

  it('正文里的 sticky 元素被无视（否则胶囊会掉到页面中间）', () => {
    const result = classifyTopChrome(
      [candidate({ insideContent: true, bottom: 900, height: 900 })],
      VIEWPORT,
    );
    expect(result).toEqual({ bottom: 0, blocked: false });
  });

  it('固定侧栏因为不够宽被无视', () => {
    const result = classifyTopChrome(
      [candidate({ width: 200, height: 800, bottom: 800 })],
      VIEWPORT,
    );
    expect(result).toEqual({ bottom: 0, blocked: false });
  });

  it('全屏遮罩层让 UI 收起，而不是贴到它下面', () => {
    const result = classifyTopChrome(
      [candidate({ height: 800, bottom: 800, opaque: true })],
      VIEWPORT,
    );
    expect(result).toEqual({ bottom: 0, blocked: true });
  });

  it('透明的全高容器既不避让也不遮挡（里面可能只是导航条）', () => {
    const result = classifyTopChrome(
      [candidate({ height: 800, bottom: 800, opaque: false })],
      VIEWPORT,
    );
    expect(result).toEqual({ bottom: 0, blocked: false });
  });

  it('取最高的那个导航条，过高的固定条既不避让也不当遮罩', () => {
    const result = classifyTopChrome(
      [candidate({ bottom: 48, height: 48 }), candidate({ bottom: 300, height: 300 })],
      VIEWPORT,
    );
    // 300px 已经超过“导航条”的合理高度（35% 视口），既不当顶部条也不当遮罩
    expect(result).toEqual({ bottom: 48, blocked: false });
  });

  it('非 fixed/sticky 的元素一律不算站点框架', () => {
    const result = classifyTopChrome([candidate({ positioned: false })], VIEWPORT);
    expect(result).toEqual({ bottom: 0, blocked: false });
  });

  it('站点搜索面板 / 对话框盖住顶部时让位', () => {
    const dialog = candidate({
      dialog: true,
      positioned: false,
      top: 0,
      bottom: 400,
      width: 520,
      height: 400,
    });
    expect(classifyTopChrome([dialog], VIEWPORT)).toEqual({ bottom: 0, blocked: true });
  });

  it('又小又矮的弹层不值得让位', () => {
    const tiny = candidate({ dialog: true, positioned: false, width: 120, height: 40, bottom: 40 });
    expect(classifyTopChrome([tiny], VIEWPORT)).toEqual({ bottom: 0, blocked: false });
  });

  it('统计顶部外来 UI 的最高层级，正文里的粘性元素不算', () => {
    expect(
      highestForeignZIndex([
        candidate({ zIndex: 30 }),
        candidate({ zIndex: 90, dialog: true, positioned: false }),
        candidate({ zIndex: 999, insideContent: true }),
        candidate({ zIndex: 999, positioned: false }),
      ]),
    ).toBe(90);
  });
});
