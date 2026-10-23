import { beforeEach, describe, expect, it } from 'vitest';
import type { HeadingNode } from './extractor';
import { ScrollTracker, isScrollRelevant, type TrackerSnapshot } from './tracker';

/** Return a setter that simulates scrolling by changing heading positions. */
function stubRect(element: HTMLElement, top: number, height = 40): (nextTop: number) => void {
  let current = top;
  element.getBoundingClientRect = () =>
    ({
      top: current,
      height,
      bottom: current + height,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: current,
      toJSON: () => ({}),
    }) as DOMRect;
  return (nextTop: number) => {
    current = nextTop;
  };
}

interface Rig {
  tracker: ScrollTracker;
  snapshots: TrackerSnapshot[];
  setTop: (index: number, top: number) => void;
  setDock: (px: number) => void;
  flush: () => void;
  last: () => TrackerSnapshot | undefined;
}

function createRig(heights: number[], dock = 60, scope: HTMLElement | null = null): Rig {
  const nodes: HeadingNode[] = heights.map((_, index) => {
    const element = document.createElement('h2');
    element.textContent = `小节 ${index + 1}`;
    document.body.appendChild(element);
    return { id: `h${index}`, element, level: index === 0 ? 1 : 2, text: `小节 ${index + 1}`, parentIndex: index === 0 ? -1 : 0 };
  });
  const setters = nodes.map((node) => stubRect(node.element, 10_000));
  let dockTop = dock;
  const snapshots: TrackerSnapshot[] = [];
  const tracker = new ScrollTracker(nodes, (snapshot) => snapshots.push(snapshot), {
    scope,
    dockTop: () => dockTop,
    heightOf: (index) => heights[index] ?? 44,
  });
  return {
    tracker,
    snapshots,
    setTop: (index, top) => setters[index]?.(top),
    setDock: (px) => {
      dockTop = px;
    },
    flush: () => tracker.flush(),
    last: () => snapshots.at(-1),
  };
}

describe('heading activation timing', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('waits until the first heading crosses the docking line', () => {
    const rig = createRig([50, 40, 40]); // Toolbar top is 60; active line is 66.
    rig.setTop(0, 300);
    rig.setTop(1, 900);
    rig.setTop(2, 1500);
    rig.flush();
    expect(rig.last()?.index).toBe(-1);

    rig.setTop(0, 90); // Still visible below the docking line.
    rig.flush();
    expect(rig.last()?.index).toBe(-1);

    rig.setTop(0, 66); // Crossed the docking line.
    rig.flush();
    expect(rig.last()?.index).toBe(0);

    rig.setTop(0, 20);
    rig.flush();
    expect(rig.last()?.index).toBe(0);
  });

  it('switches only after the next heading crosses the line', () => {
    const rig = createRig([50, 40, 40]);
    rig.setTop(0, 66);
    rig.setTop(1, 400);
    rig.setTop(2, 900);
    rig.flush();
    expect(rig.last()?.index).toBe(0);

    rig.setTop(0, -200);
    rig.setTop(1, 85); // Still visible below the docking line.
    rig.flush();
    expect(rig.last()?.index).toBe(0);

    rig.setTop(1, 66);
    rig.flush();
    expect(rig.last()?.index).toBe(1);
  });

  it('hands back to the parent as soon as a child reappears', () => {
    const rig = createRig([50, 40, 40]);
    rig.setTop(0, 60);
    rig.setTop(1, 60);
    rig.setTop(2, 900);
    rig.flush();
    expect(rig.last()?.index).toBe(1);

    rig.setTop(0, -50);
    rig.setTop(1, 70); // The child heading is visible again.
    rig.flush();
    expect(rig.last()?.index).toBe(0);

    rig.setTop(0, 130); // Even the root heading is below the line.
    rig.flush();
    expect(rig.last()?.index).toBe(-1);
  });

  it('keeps a jump target active until geometry takes over', () => {
    const rig = createRig([50, 40, 40]);
    rig.setTop(0, 66);
    rig.setTop(1, 400);
    rig.setTop(2, 900);
    rig.flush();
    expect(rig.last()?.index).toBe(0);

    // A jump lands the target below the capsule, within 66 + 40 + 6.
    rig.setTop(0, -1400);
    rig.setTop(1, -400);
    rig.setTop(2, 110);
    rig.flush();
    rig.tracker.focusIndex(2);
    expect(rig.last()?.index).toBe(2);

    // Scroll-back makes the target visible again.
    rig.setTop(0, -1200);
    rig.setTop(1, -200);
    rig.setTop(2, 140);
    rig.flush();
    expect(rig.last()?.index).toBe(1);

    // A deeper heading replaces the override.
    rig.setTop(0, -1400);
    rig.setTop(1, -600);
    rig.setTop(2, 60);
    rig.flush();
    expect(rig.last()?.index).toBe(2);
  });

  it('recalculates when the docking height changes', () => {
    const rig = createRig([50, 40, 40]);
    rig.setTop(0, 400);
    rig.setTop(1, 123); // Below 112, but above the lower line.
    rig.setTop(2, 900);
    rig.flush();
    expect(rig.last()?.index).toBe(-1);

    rig.setDock(150); // Move the docking line downward.
    rig.flush();
    expect(rig.last()?.index).toBe(1);
  });

  it('does not promote visible headings before the real document bottom', () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'scrollY');
    let scrollY = 99_000;
    Object.defineProperty(window, 'scrollY', {
      configurable: true,
      get: () => scrollY,
    });
    try {
      const rig = createRig([50, 40, 40]);
      rig.setTop(0, 66);
      rig.setTop(1, 180);
      rig.setTop(2, 360);
      rig.flush();
      expect(rig.last()?.index).toBe(0);

      // Only the final heading may take over at the true document bottom.
      scrollY = 99_900;
      rig.flush();
      expect(rig.last()?.index).toBe(2);
    } finally {
      if (descriptor) Object.defineProperty(window, 'scrollY', descriptor);
      else Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
    }
  });

  it('uses article geometry for nested scroll containers', () => {
    const scrollContainer = document.createElement('div');
    scrollContainer.style.overflowY = 'auto';
    const scope = document.createElement('article');
    scrollContainer.appendChild(scope);
    document.body.appendChild(scrollContainer);
    let scrollTop = 0;
    Object.defineProperties(scrollContainer, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 600 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
    });
    const rig = createRig([50, 40, 40], 60, scope);
    rig.setTop(0, 66);
    rig.setTop(1, 180);
    rig.setTop(2, 360);
    rig.flush();
    expect(rig.last()?.index).toBe(0);

    scrollContainer.scrollTop = 400;
    rig.flush();
    expect(rig.last()?.index).toBe(2);
  });

  it('does not promote the final heading on an article that fits on screen', () => {
    const scrollHeight = Object.getOwnPropertyDescriptor(
      document.documentElement,
      'scrollHeight',
    );
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      configurable: true,
      value: 300,
    });
    try {
      const scope = document.createElement('article');
      document.body.appendChild(scope);
      stubRect(scope, 100, 300);
      const rig = createRig([50, 40, 40], 60, scope);
      rig.setTop(0, 66);
      rig.setTop(1, 180);
      rig.setTop(2, 260);
      rig.flush();

      expect(rig.last()?.index).toBe(0);
    } finally {
      if (scrollHeight) {
        Object.defineProperty(document.documentElement, 'scrollHeight', scrollHeight);
      }
    }
  });
});

describe('scroll relevance', () => {
  it('accepts window scrolling and ancestors of the article', () => {
    const outer = document.createElement('div');
    const scope = document.createElement('article');
    outer.appendChild(scope);

    expect(isScrollRelevant(document, scope)).toBe(true);
    expect(isScrollRelevant(window, scope)).toBe(true);
    expect(isScrollRelevant(outer, scope)).toBe(true);
    expect(isScrollRelevant(scope, scope)).toBe(true);
  });

  it('ignores unrelated nested scrollers', () => {
    const scope = document.createElement('article');
    const codeBlock = document.createElement('pre');
    scope.appendChild(codeBlock);

    expect(isScrollRelevant(codeBlock, scope)).toBe(false);
    expect(isScrollRelevant(document.createElement('aside'), scope)).toBe(false);
  });
});

describe('article reading progress', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  function trackScope(scope: HTMLElement | null): {
    snapshots: TrackerSnapshot[];
    tracker: ScrollTracker;
  } {
    const element = document.createElement('h2');
    document.body.appendChild(element);
    stubRect(element, 0);
    const node: HeadingNode = {
      id: 'h',
      element,
      level: 2,
      text: 'Heading',
      parentIndex: -1,
    };
    const snapshots: TrackerSnapshot[] = [];
    const tracker = new ScrollTracker([node], (snapshot) => snapshots.push(snapshot), {
      scope,
      dockTop: () => 0,
      heightOf: () => 44,
    });
    return { snapshots, tracker };
  }

  it('moves from 0 at the start to 1 when the article end is visible', () => {
    const scope = document.createElement('article');
    document.body.appendChild(scope);
    const setTop = stubRect(scope, 100, 3000);
    const { snapshots, tracker } = trackScope(scope);
    const line = 44; // dockTop(0) + default capsule height.
    const range = 3000 + line - window.innerHeight;

    tracker.flush();
    setTop(line);
    tracker.flush();
    expect(snapshots.at(-1)?.progress).toBe(0);

    const endTop = window.innerHeight - 3000;
    const midTop = (line + endTop) / 2;
    setTop(midTop);
    tracker.flush();
    expect(snapshots.at(-1)?.progress).toBeCloseTo((line - midTop) / range, 3);

    setTop(endTop);
    tracker.flush();
    expect(snapshots.at(-1)?.progress).toBeCloseTo(1, 3);
  });

  it('returns zero progress without an article scope', () => {
    const { snapshots, tracker } = trackScope(null);
    tracker.flush();
    expect(snapshots.at(-1)?.progress ?? 0).toBe(0);
  });

  it('treats an article shorter than the viewport as complete', () => {
    const scope = document.createElement('article');
    document.body.appendChild(scope);
    stubRect(scope, 300, 200);
    const { snapshots, tracker } = trackScope(scope);
    tracker.flush();
    expect(snapshots.at(-1)?.progress).toBe(1);
  });
});
