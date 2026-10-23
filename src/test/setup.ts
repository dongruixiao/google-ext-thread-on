/**
 * jsdom has no layout engine. Provide enough geometry for visibility and
 * heuristic tests; use style="display:none" when a test needs hidden nodes.
 */
function layoutRect(element: Element): DOMRect {
  // Spread synthetic nodes vertically so the overlap gate does not reject
  // every fixture. Real browsers obtain these values from layout.
  const nodes = [...document.querySelectorAll('*')];
  const top = Math.max(0, nodes.indexOf(element)) * 40;
  return {
    x: 0,
    y: top,
    width: 160,
    height: 24,
    top,
    right: 160,
    bottom: top + 24,
    left: 0,
    toJSON() {
      return { ...this };
    },
  } as DOMRect;
}

if (typeof Element !== 'undefined') {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
    return layoutRect(this);
  };
  Element.prototype.getClientRects = function getClientRects(): DOMRectList {
    return [layoutRect(this)] as unknown as DOMRectList;
  };
}

// jsdom reports scrollHeight as 0, which would always satisfy the bottom gate.
if (typeof document !== 'undefined') {
  Object.defineProperty(document.documentElement, 'scrollHeight', {
    configurable: true,
    get: () => 100_000,
  });
}
