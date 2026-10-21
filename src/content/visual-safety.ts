export type VisualSafetyReason =
  | 'safe'
  | 'background-complex'
  | 'background-unstable'
  | 'title-effect'
  | 'text-color-unresolvable'
  | 'low-contrast';

export interface VisualSafety {
  safe: boolean;
  reason: VisualSafetyReason;
  background: string;
  foreground: string;
  contrast: number;
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface BackgroundInfo {
  color: string | null;
  rgba: Rgba | null;
  complex: boolean;
}

const WHITE = 'rgb(255, 255, 255)';
const BLACK = 'rgb(0, 0, 0)';
const MAX_SAMPLED_HEADINGS = 8;
const modernColorCache = new Map<string, Rgba | null>();

function parseColor(value: string): Rgba | null {
  const color = value.trim().toLowerCase();
  if (!color || color === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (color === 'white') return { r: 255, g: 255, b: 255, a: 1 };
  if (color === 'black') return { r: 0, g: 0, b: 0, a: 1 };

  const hex = color.match(/^#([\da-f]{3,8})$/i);
  if (hex) {
    const raw = hex[1];
    const expand = (part: string) => Number.parseInt(part.length === 1 ? part + part : part, 16);
    if (raw.length === 3 || raw.length === 4) {
      return {
        r: expand(raw[0]),
        g: expand(raw[1]),
        b: expand(raw[2]),
        a: raw.length === 4 ? expand(raw[3]) / 255 : 1,
      };
    }
    if (raw.length === 6 || raw.length === 8) {
      return {
        r: expand(raw.slice(0, 2)),
        g: expand(raw.slice(2, 4)),
        b: expand(raw.slice(4, 6)),
        a: raw.length === 8 ? expand(raw.slice(6, 8)) / 255 : 1,
      };
    }
  }

  const rgb = color.match(/^rgba?\((.*)\)$/);
  if (rgb) {
    const parts = rgb[1].replace('/', ' ').split(/[\s,]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const channel = (part: string) =>
      part.endsWith('%') ? Number.parseFloat(part) * 2.55 : Number.parseFloat(part);
    const alphaText = parts[3] ?? '1';
    const alpha = alphaText.endsWith('%')
      ? Number.parseFloat(alphaText) / 100
      : Number.parseFloat(alphaText);
    const [r, g, b] = parts.slice(0, 3).map(channel);
    if (![r, g, b, alpha].every(Number.isFinite)) return null;
    return {
      r: Math.max(0, Math.min(255, r)),
      g: Math.max(0, Math.min(255, g)),
      b: Math.max(0, Math.min(255, b)),
      a: Math.max(0, Math.min(1, alpha)),
    };
  }

  // 现代 CSS 颜色（lab / oklch / display-p3 等）交给浏览器自身的
  // 颜色解析器栅格化，避免维护一套不完整的色彩空间转换。
  if (modernColorCache.has(color)) return modernColorCache.get(color) ?? null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, alpha] = context.getImageData(0, 0, 1, 1).data;
    const parsed = { r, g, b, a: alpha / 255 };
    modernColorCache.set(color, parsed);
    return parsed;
  } catch {
    modernColorCache.set(color, null);
    return null;
  }
}

function composite(foreground: Rgba, background: Rgba): Rgba {
  const alpha = foreground.a + background.a * (1 - foreground.a);
  if (alpha <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / alpha,
    g: (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / alpha,
    b: (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / alpha,
    a: alpha,
  };
}

function luminance(color: Rgba): number {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function contrastRatio(foreground: Rgba, background: Rgba): number {
  const a = luminance(composite(foreground, background));
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function resolveBackground(element: HTMLElement): BackgroundInfo {
  let node: HTMLElement | null = element;
  for (let depth = 0; node && depth < 20; depth += 1) {
    let style: CSSStyleDeclaration;
    try {
      style = getComputedStyle(node);
    } catch {
      return { color: null, rgba: null, complex: true };
    }

    if (
      style.backgroundImage !== 'none' ||
      (style.backgroundBlendMode && style.backgroundBlendMode !== 'normal')
    ) {
      return { color: null, rgba: null, complex: true };
    }

    const rgba = parseColor(style.backgroundColor);
    if (!rgba) return { color: null, rgba: null, complex: true };
    if (rgba.a >= 0.98) {
      return { color: style.backgroundColor, rgba, complex: false };
    }
    if (rgba.a > 0.02) {
      return { color: null, rgba: null, complex: true };
    }
    node = node.parentElement;
  }

  // 浏览器默认画布是白色；若页面依赖深色 color-scheme 却没有可采样底色，
  // 后续对比度会失败并保持静默，而不是猜一个主题色覆盖页面。
  return { color: WHITE, rgba: parseColor(WHITE), complex: false };
}

function sampleHeadings(headings: HTMLElement[]): HTMLElement[] {
  if (headings.length <= MAX_SAMPLED_HEADINGS) return headings;
  const step = (headings.length - 1) / (MAX_SAMPLED_HEADINGS - 1);
  return Array.from(
    { length: MAX_SAMPLED_HEADINGS },
    (_, index) => headings[Math.round(index * step)],
  );
}

/**
 * 判断页面是否拥有一个足够稳定、可安全融合的视觉表面。
 *
 * 鲜艳但统一的实色背景是允许的；渐变、图片、半透明叠层、标题混合模式、
 * 渐变文字和低对比度都会让插件放弃展示，而不是在页面上创造新的颜色系统。
 */
export function assessVisualSafety(
  scope: HTMLElement,
  headingElements: HTMLElement[],
): VisualSafety {
  const base = resolveBackground(scope);
  if (base.complex || !base.rgba || !base.color) {
    return {
      safe: false,
      reason: 'background-complex',
      background: '',
      foreground: '',
      contrast: 0,
    };
  }

  const sampled = sampleHeadings(headingElements);
  let minimumContrast = Number.POSITIVE_INFINITY;
  let foreground = '';

  for (const heading of sampled) {
    let style: CSSStyleDeclaration;
    try {
      style = getComputedStyle(heading);
    } catch {
      return {
        safe: false,
        reason: 'title-effect',
        background: base.color,
        foreground: '',
        contrast: 0,
      };
    }

    const backgroundClip = [
      style.getPropertyValue('background-clip'),
      style.getPropertyValue('-webkit-background-clip'),
    ].join(' ');
    const textFill = style.getPropertyValue('-webkit-text-fill-color');
    const fillColor = textFill ? parseColor(textFill) : null;
    const blendMode = style.getPropertyValue('mix-blend-mode');
    if (
      style.backgroundImage !== 'none' ||
      backgroundClip.includes('text') ||
      (fillColor !== null && fillColor.a < 0.05) ||
      (blendMode !== '' && blendMode !== 'normal') ||
      style.filter !== 'none'
    ) {
      return {
        safe: false,
        reason: 'title-effect',
        background: base.color,
        foreground: '',
        contrast: 0,
      };
    }

    const color = parseColor(style.color);
    if (!color) {
      return {
        safe: false,
        reason: 'text-color-unresolvable',
        background: base.color,
        foreground: style.color,
        contrast: 0,
      };
    }

    const fontSize = Number.parseFloat(style.fontSize);
    const fontWeight = Number.parseInt(style.fontWeight, 10);
    const largeText =
      (Number.isFinite(fontSize) && fontSize >= 24) ||
      (Number.isFinite(fontSize) && fontSize >= 18.66 && fontWeight >= 700);
    const ratio = contrastRatio(color, base.rgba);
    minimumContrast = Math.min(minimumContrast, ratio);
    foreground = style.color;
    if (ratio < (largeText ? 3 : 4.5)) {
      return {
        safe: false,
        reason: 'low-contrast',
        background: base.color,
        foreground: style.color,
        contrast: Number(ratio.toFixed(2)),
      };
    }
  }

  return {
    safe: true,
    reason: 'safe',
    background: base.color,
    foreground: foreground || BLACK,
    contrast: Number((Number.isFinite(minimumContrast) ? minimumContrast : 0).toFixed(2)),
  };
}
