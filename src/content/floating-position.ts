import type { FloatingPosition } from '../shared/settings';

const VIEWPORT_MARGIN = 8;
const VERTICAL_PADDING = 16;
const MIN_CAPSULE_WIDTH = 140;
const MAX_CAPSULE_WIDTH = 480;

export interface ViewportSize {
  width: number;
  height: number;
}

export interface CapsuleSize {
  width: number;
  height: number;
}

export interface FloatingLayout {
  left: number;
  top: number;
  maxWidth: number;
}

export function resolveFloatingLayout(
  position: FloatingPosition,
  viewport: ViewportSize,
  capsule: CapsuleSize,
): FloatingLayout {
  const width = Math.min(
    MAX_CAPSULE_WIDTH,
    Math.max(MIN_CAPSULE_WIDTH, capsule.width || 180),
  );
  const height = capsule.height || 40;
  const anchorRange = Math.max(1, viewport.width - VIEWPORT_MARGIN * 2);
  const maxY = Math.max(0, viewport.height - height - VERTICAL_PADDING);
  const desiredLeft = VIEWPORT_MARGIN + (position.x / 100) * anchorRange;

  // Legacy releases normalized x against capsule width. Clamp stored values
  // again at render time so upgraded settings can never hide the capsule.
  const left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(desiredLeft, viewport.width - width - VIEWPORT_MARGIN),
  );
  const top = Math.max(
    VIEWPORT_MARGIN,
    Math.min(
      VIEWPORT_MARGIN + (position.y / 100) * maxY,
      viewport.height - height - VIEWPORT_MARGIN,
    ),
  );
  const availableWidth = Math.max(
    MIN_CAPSULE_WIDTH,
    viewport.width - left - VERTICAL_PADDING,
  );

  return {
    left,
    top,
    maxWidth: Math.min(MAX_CAPSULE_WIDTH, availableWidth),
  };
}

export function normalizeFloatingPosition(
  left: number,
  top: number,
  viewport: ViewportSize,
  capsuleHeight: number,
): FloatingPosition {
  const anchorRange = Math.max(1, viewport.width - VIEWPORT_MARGIN * 2);
  const maxY = Math.max(1, viewport.height - capsuleHeight - VERTICAL_PADDING);
  return {
    x:
      Math.round(
        Math.max(0, Math.min(100, ((left - VIEWPORT_MARGIN) / anchorRange) * 100)) *
          10,
      ) / 10,
    y:
      Math.round(
        Math.max(0, Math.min(100, ((top - VIEWPORT_MARGIN) / maxY) * 100)) * 10,
      ) / 10,
  };
}
