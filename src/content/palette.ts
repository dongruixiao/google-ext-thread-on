/**
 * 从页面里采样正文的底色与标题排版，
 * 让吸顶条看起来像页面自己长出来的，而不是外挂控件。
 */

export interface PageStyle {
  /** 正文底的实色（用于给吸顶条上色） */
  background: string;
  /** 标题文字颜色 */
  color: string;
  fontFamily: string;
  fontWeight: string;
  letterSpacing: string;
  /** 吸顶条标题字号（由正文标题按比例缩放而来） */
  titleSize: number;
}

const TRANSPARENT = /^(transparent|rgba\(0,\s*0,\s*0,\s*0\))$/;

/** 该颜色是否真正可见（非透明） */
export function isOpaqueColor(color: string | undefined | null): boolean {
  if (!color) return false;
  return !TRANSPARENT.test(color.trim());
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 从作用域往上找第一个有实色背景的祖先。
 * 找不到就返回空串，由调用方回退到插件主题色——
 * 宁可不用页面配色，也不要用错配色（例如深底配深字）。
 */
export function findBackground(scope: HTMLElement | null): string {
  let node: HTMLElement | null = scope;
  for (let depth = 0; node && depth < 16; depth += 1) {
    let background = '';
    try {
      background = getComputedStyle(node).backgroundColor;
    } catch {
      background = '';
    }
    if (isOpaqueColor(background)) return background;
    node = node.parentElement;
  }
  return '';
}

export function samplePageStyle(
  scope: HTMLElement | null,
  sampleHeading: HTMLElement | null,
): PageStyle {
  const background = findBackground(scope);
  const themeFallback = background === '';
  let color = '';
  let fontFamily = '';
  let fontWeight = '600';
  let letterSpacing = '';
  let headingSize = 17;

  if (sampleHeading) {
    try {
      const style = getComputedStyle(sampleHeading);
      // 没有可靠的页面底色时，文字颜色也交给插件主题决定，避免对比度事故
      if (!themeFallback) color = style.color;
      fontFamily = style.fontFamily;
      fontWeight = style.fontWeight || fontWeight;
      letterSpacing = style.letterSpacing;
      const parsed = Number.parseFloat(style.fontSize);
      if (Number.isFinite(parsed) && parsed > 0) headingSize = parsed;
    } catch {
      /* 采样失败时退回默认值 */
    }
  }

  if (!color && !themeFallback) {
    try {
      color = getComputedStyle(document.body).color || '';
    } catch {
      color = '';
    }
  }

  return {
    background,
    color,
    fontFamily,
    fontWeight,
    letterSpacing,
    // 标题整体偏大，吸顶条按比例缩小，并限制在可读区间内
    titleSize: Math.round(clamp(headingSize * 0.62, 13, 20) * 10) / 10,
  };
}
