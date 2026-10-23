/**
 * Distinguish site chrome from article content near the top edge.
 * Toolbars become a dock offset; content sticky elements are ignored;
 * dialogs and full-screen overlays suppress the extension UI.
 */

export interface ChromeCandidate {
  top: number;
  bottom: number;
  width: number;
  height: number;
  /** Whether the element or a nearby ancestor is fixed or sticky. */
  positioned: boolean;
  /** Whether the element belongs to the detected article. */
  insideContent: boolean;
  /** Solid backgrounds and images are evidence of an overlay surface. */
  opaque: boolean;
  /** dialog, aria-modal, or role=dialog. */
  dialog: boolean;
  /** Highest z-index declared by the element or a nearby ancestor. */
  zIndex: number;
  visible: boolean;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface TopChrome {
  /** Top chrome height to avoid. Zero means the viewport edge is clear. */
  bottom: number;
  /** The extension should hide while this overlay is present. */
  blocked: boolean;
}

/** Probes sample near y=4, allowing for sub-pixel layout variance. */
const PROBE_TOLERANCE = 6;
/** Fixed sidebars are too narrow to count as top chrome. */
const MIN_BAR_WIDTH_RATIO = 0.6;
/** Taller surfaces are overlays, not toolbars. */
const MAX_BAR_HEIGHT_RATIO = 0.35;
/** Minimum viewport coverage for a non-toolbar blocker. */
const MIN_BLOCKER_HEIGHT_RATIO = 0.6;
/** Ignore tiny decorative dialogs. */
const MIN_DIALOG_WIDTH_RATIO = 0.2;
const MIN_DIALOG_HEIGHT = 80;
const TRANSPARENT = /^(transparent|rgba\(0,\s*0,\s*0,\s*0\))$/;

function isOpaqueColor(color: string | undefined | null): boolean {
  return !!color && !TRANSPARENT.test(color.trim());
}

export function classifyTopChrome(candidates: ChromeCandidate[], viewport: Viewport): TopChrome {
  const cap = viewport.height * MAX_BAR_HEIGHT_RATIO;
  let bottom = 0;
  let blocked = false;

  for (const candidate of candidates) {
    if (!candidate.visible) continue;

    // Site search panels and dialogs take precedence over the extension.
    if (
      candidate.dialog &&
      candidate.width >= viewport.width * MIN_DIALOG_WIDTH_RATIO &&
      candidate.height >= MIN_DIALOG_HEIGHT
    ) {
      blocked = true;
      continue;
    }

    if (!candidate.positioned) continue;
    if (candidate.insideContent) continue;
    if (candidate.top > PROBE_TOLERANCE || candidate.bottom <= 0) continue;
    if (candidate.width < viewport.width * MIN_BAR_WIDTH_RATIO) continue;

    if (candidate.height <= cap) {
      bottom = Math.max(bottom, candidate.bottom);
      continue;
    }
    // A wide, tall surface is more likely a modal backdrop than a toolbar.
    if (candidate.opaque && candidate.height >= viewport.height * MIN_BLOCKER_HEIGHT_RATIO) {
      blocked = true;
    }
  }

  return { bottom: Math.round(Math.min(bottom, cap)), blocked };
}
export function isPositionedWithin(element: HTMLElement, depth = 4): boolean {
  let node: HTMLElement | null = element;
  for (let level = 0; node && level <= depth; level += 1) {
    let position = '';
    try {
      position = getComputedStyle(node).position;
    } catch {
      return false;
    }
    if (position === 'fixed' || position === 'sticky') return true;
    node = node.parentElement;
  }
  return false;
}

/** Invalid and auto z-index values are treated as zero. */
export function effectiveZIndex(element: HTMLElement, depth = 5): number {
  let highest = 0;
  let node: HTMLElement | null = element;
  for (let level = 0; node && level <= depth; level += 1) {
    try {
      const value = Number.parseInt(getComputedStyle(node).zIndex, 10);
      if (Number.isFinite(value)) highest = Math.max(highest, value);
    } catch {
      /* One inaccessible node should not invalidate its ancestors. */
    }
    node = node.parentElement;
  }
  return highest;
}

/** Highest z-index among foreign chrome at the viewport edge. */
export function highestForeignZIndex(candidates: ChromeCandidate[]): number {
  let highest = 0;
  for (const candidate of candidates) {
    if (!candidate.visible || candidate.insideContent) continue;
    if (!candidate.positioned && !candidate.dialog) continue;
    highest = Math.max(highest, candidate.zIndex);
  }
  return highest;
}

export function hasSurface(style: CSSStyleDeclaration): boolean {
  return isOpaqueColor(style.backgroundColor) || (style.backgroundImage !== '' && style.backgroundImage !== 'none');
}

