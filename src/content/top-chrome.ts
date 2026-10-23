import {
  classifyTopChrome,
  effectiveZIndex,
  hasSurface,
  highestForeignZIndex,
  isPositionedWithin,
  type ChromeCandidate,
  type TopChrome,
} from './chrome-detect';
import { HOST_ID } from '../shared/constants';

const PROBES = [0.5, 0.08, 0.92];

export interface TopChromeMetrics extends TopChrome {
  foreignZIndex: number;
}

/**
 * Classify elements at the top edge as site chrome, article content, or an
 * overlay. Sticky elements inside the article must not move the dock line.
 */
export function detectTopChrome(scope: HTMLElement | null): TopChromeMetrics {
  const probeY = 4;
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const candidates: ChromeCandidate[] = [];

  for (const ratio of PROBES) {
    const x = Math.round(viewport.width * ratio);
    let elements: Element[] = [];
    try {
      elements = document.elementsFromPoint(x, probeY);
    } catch {
      elements = [];
    }

    for (const element of elements) {
      if (!(element instanceof HTMLElement)) continue;
      if (element.closest(`#${HOST_ID}`)) continue;

      let style: CSSStyleDeclaration;
      try {
        style = getComputedStyle(element);
      } catch {
        continue;
      }

      const rect = element.getBoundingClientRect();
      candidates.push({
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
        positioned: isPositionedWithin(element),
        insideContent: scope !== null && scope !== element && scope.contains(element),
        opaque: hasSurface(style),
        zIndex: effectiveZIndex(element),
        dialog:
          element.matches('dialog[open], [aria-modal="true"], [role="dialog"]') ||
          element.closest('dialog[open], [aria-modal="true"], [role="dialog"]') !== null,
        visible:
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          (style.opacity === '' || Number(style.opacity) > 0.05),
      });
    }
  }

  return {
    ...classifyTopChrome(candidates, viewport),
    foreignZIndex: highestForeignZIndex(candidates),
  };
}
