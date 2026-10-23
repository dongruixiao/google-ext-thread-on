import { describe, expect, it } from 'vitest';
import {
  normalizeFloatingPosition,
  resolveFloatingLayout,
  resolveJumpMarginTop,
} from './floating-position';

describe('floating capsule geometry', () => {
  it('keeps a legacy right-edge position fully inside the viewport', () => {
    const layout = resolveFloatingLayout(
      { x: 100, y: 20 },
      { width: 1280, height: 720 },
      { width: 180, height: 40 },
    );

    expect(layout.left).toBe(1092);
    expect(layout.left + 180).toBeLessThanOrEqual(1272);
    expect(layout.maxWidth).toBeGreaterThanOrEqual(140);
  });

  it('clamps the capsule after the viewport shrinks', () => {
    const layout = resolveFloatingLayout(
      { x: 100, y: 100 },
      { width: 700, height: 600 },
      { width: 220, height: 40 },
    );

    expect(layout.left).toBe(472);
    expect(layout.top).toBe(552);
    expect(layout.left + 220).toBeLessThanOrEqual(692);
  });

  it('round-trips a normalized position within one tenth of a percent', () => {
    const viewport = { width: 1280, height: 720 };
    const normalized = normalizeFloatingPosition(432, 240, viewport, 40);
    const layout = resolveFloatingLayout(normalized, viewport, {
      width: 180,
      height: 40,
    });

    expect(Math.abs(layout.left - 432)).toBeLessThanOrEqual(1);
    expect(Math.abs(layout.top - 240)).toBeLessThanOrEqual(1);
  });

  it('adds jump clearance only when the capsule overlaps the docking line', () => {
    expect(resolveJumpMarginTop(57, { top: 57, height: 40 })).toBe(99);
    expect(resolveJumpMarginTop(57, { top: 600, height: 40 })).toBe(57);
    expect(resolveJumpMarginTop(57, null)).toBe(57);
  });
});
