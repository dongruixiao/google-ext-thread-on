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
  it('detects a site toolbar and returns its dock offset', () => {
    const result = classifyTopChrome([candidate({ bottom: 64, height: 64 })], VIEWPORT);
    expect(result).toEqual({ bottom: 64, blocked: false });
  });

  it('ignores sticky elements inside the article', () => {
    const result = classifyTopChrome(
      [candidate({ insideContent: true, bottom: 900, height: 900 })],
      VIEWPORT,
    );
    expect(result).toEqual({ bottom: 0, blocked: false });
  });

  it('ignores fixed sidebars that are too narrow', () => {
    const result = classifyTopChrome(
      [candidate({ width: 200, height: 800, bottom: 800 })],
      VIEWPORT,
    );
    expect(result).toEqual({ bottom: 0, blocked: false });
  });

  it('hides for a full-page overlay', () => {
    const result = classifyTopChrome(
      [candidate({ height: 800, bottom: 800, opaque: true })],
      VIEWPORT,
    );
    expect(result).toEqual({ bottom: 0, blocked: true });
  });

  it('ignores a transparent full-height container', () => {
    const result = classifyTopChrome(
      [candidate({ height: 800, bottom: 800, opaque: false })],
      VIEWPORT,
    );
    expect(result).toEqual({ bottom: 0, blocked: false });
  });

  it('ignores fixed surfaces taller than the toolbar limit', () => {
    const result = classifyTopChrome(
      [candidate({ bottom: 48, height: 48 }), candidate({ bottom: 300, height: 300 })],
      VIEWPORT,
    );
    // 300px exceeds the 35% toolbar cap but is not opaque.
    expect(result).toEqual({ bottom: 48, blocked: false });
  });

  it('ignores normal-flow elements', () => {
    const result = classifyTopChrome([candidate({ positioned: false })], VIEWPORT);
    expect(result).toEqual({ bottom: 0, blocked: false });
  });

  it('yields to site search panels and dialogs', () => {
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

  it('ignores tiny dialogs', () => {
    const tiny = candidate({ dialog: true, positioned: false, width: 120, height: 40, bottom: 40 });
    expect(classifyTopChrome([tiny], VIEWPORT)).toEqual({ bottom: 0, blocked: false });
  });

  it('finds the highest foreign layer outside article content', () => {
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
