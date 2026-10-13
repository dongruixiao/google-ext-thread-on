/**
 * jsdom 不实现布局：给“可见性判定”提供最小可用的矩形信息，
 * 这样单元测试才能覆盖与 DOM 结构相关的启发式逻辑。
 * 需要隐藏某个元素时，测试里用 style="display:none"（jsdom 会正确计算样式）。
 */
const RECT = {
  x: 0,
  y: 0,
  width: 160,
  height: 24,
  top: 0,
  right: 160,
  bottom: 24,
  left: 0,
  toJSON() {
    return { ...this };
  },
} as DOMRect;

if (typeof Element !== 'undefined') {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
    return RECT;
  };
  Element.prototype.getClientRects = function getClientRects(): DOMRectList {
    return [RECT] as unknown as DOMRectList;
  };
}

// jsdom 的 scrollHeight 恒为 0，会让“滚动到底部”的兜底逻辑永远成立；
// 给它一个足够大的值，测试才能验证真实的滚动行为。
if (typeof document !== 'undefined') {
  Object.defineProperty(document.documentElement, 'scrollHeight', {
    configurable: true,
    get: () => 100_000,
  });
}
