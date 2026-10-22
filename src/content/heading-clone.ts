/**
 * 把网页里的标题“原样搬进”吸顶条。
 *
 * Shadow DOM 会隔离页面样式，所以这里克隆标题的 DOM 结构，
 * 再把它（以及它的内联子节点）的计算样式快照过去——
 * 字体、字号、字重、行高、颜色、渐变文字、内边距全部照搬，
 * 看起来就像页面自己的标题被钉住了。页面本身不做任何修改。
 */

/** 需要搬过来的视觉属性（只取排版相关的，不搬定位/动画） */
const STYLE_PROPERTIES = [
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-variant',
  'font-feature-settings',
  'font-variation-settings',
  'font-optical-sizing',
  'line-height',
  'letter-spacing',
  'word-spacing',
  'text-transform',
  'text-decoration',
  'text-decoration-line',
  'text-decoration-color',
  'text-decoration-style',
  'text-decoration-thickness',
  'text-underline-offset',
  'text-shadow',
  'text-align',
  'text-indent',
  'word-break',
  'overflow-wrap',
  'hyphens',
  'color',
  'background',
  'background-color',
  'background-image',
  'background-clip',
  'background-size',
  'background-position',
  '-webkit-background-clip',
  '-webkit-text-fill-color',
  '-webkit-text-stroke',
  '-webkit-text-stroke-color',
  '-webkit-text-stroke-width',
  'display',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-radius',
  'box-sizing',
  'opacity',
  'direction',
  'vertical-align',
  'filter',
  'mix-blend-mode',
  'font-synthesis',
] as const;

const MAX_CLONED_DESCENDANTS = 32;

function copyComputedStyles(source: Element, target: HTMLElement): void {
  let computed: CSSStyleDeclaration;
  try {
    computed = getComputedStyle(source);
  } catch {
    return;
  }
  for (const property of STYLE_PROPERTIES) {
    const value = computed.getPropertyValue(property);
    if (!value) continue;
    target.style.setProperty(property, value);
  }
}

function sanitize(clone: HTMLElement): void {
  clone.removeAttribute('id');
  clone.removeAttribute('data-wss-id');
  clone.removeAttribute('data-wss-scope');
  for (const node of clone.querySelectorAll('[id]')) node.removeAttribute('id');
  // 克隆只负责“长得像”，交互全部由吸顶条自己接管
  for (const node of clone.querySelectorAll('a, button')) {
    node.setAttribute('tabindex', '-1');
  }
}

/**
 * 标题吸顶后会占用的高度：行高 + 标题自身的上下内边距/边框 + 条的上下留白。
 * 与渲染后实测的高度一致，判定“什么时候该吸顶”就靠它，避免过早或过晚。
 */
export function estimateHeadingHeight(source: HTMLElement | null): number {
  let lineHeight = Number.NaN;
  let fontSize = Number.NaN;
  let padding = 0;
  let border = 0;
  if (source) {
    try {
      const computed = getComputedStyle(source);
      lineHeight = Number.parseFloat(computed.lineHeight);
      fontSize = Number.parseFloat(computed.fontSize);
      padding =
        (Number.parseFloat(computed.paddingTop) || 0) +
        (Number.parseFloat(computed.paddingBottom) || 0);
      border =
        (Number.parseFloat(computed.borderTopWidth) || 0) +
        (Number.parseFloat(computed.borderBottomWidth) || 0);
    } catch {
      /* 拿不到样式就用下面的兜底值 */
    }
  }
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
    lineHeight = (Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 17) * 1.5;
  }
  const height = lineHeight + padding + border;
  return Math.round(Math.min(Math.max(height, 24), 96));
}

/**
 * 克隆标题并搬运样式。
 * 返回的节点可以直接塞进吸顶条，外观与页面上的原始标题一致。
 */
export function cloneHeading(source: HTMLElement): HTMLElement {
  const clone = source.cloneNode(true) as HTMLElement;
  sanitize(clone);
  copyComputedStyles(source, clone);

  const sourceNodes = source.querySelectorAll('*');
  const cloneNodes = clone.querySelectorAll('*');
  const limit = Math.min(sourceNodes.length, cloneNodes.length, MAX_CLONED_DESCENDANTS);
  for (let i = 0; i < limit; i += 1) {
    const target = cloneNodes[i];
    if (target instanceof HTMLElement) copyComputedStyles(sourceNodes[i], target);
  }

  // 单行展示：超出部分截断，免得把吸顶条撑爆
  clone.style.setProperty('margin', '0', 'important');
  clone.style.setProperty('max-width', '100%', 'important');
  clone.style.setProperty('overflow', 'hidden', 'important');
  clone.style.setProperty('text-overflow', 'ellipsis', 'important');
  for (const node of [clone, ...clone.querySelectorAll<HTMLElement>('*')]) {
    node.style.setProperty('white-space', 'nowrap', 'important');
  }
  clone.style.setProperty('pointer-events', 'none');

  return clone;
}
