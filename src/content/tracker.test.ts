import { beforeEach, describe, expect, it } from 'vitest';
import type { HeadingNode } from './extractor';
import { ScrollTracker, type TrackerSnapshot } from './tracker';

/** 伪造元素布局：返回 setter，改它的 top 等价于页面滚动 */
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

function createRig(heights: number[], dock = 60): Rig {
  const nodes: HeadingNode[] = heights.map((_, index) => {
    const element = document.createElement('h2');
    element.textContent = `小节 ${index + 1}`;
    document.body.appendChild(element);
    return { id: `h${index}`, element, level: index === 0 ? 1 : 2, text: `小节 ${index + 1}`, top: 0, parentIndex: index === 0 ? -1 : 0 };
  });
  const setters = nodes.map((node) => stubRect(node.element, 10_000));
  let dockTop = dock;
  const snapshots: TrackerSnapshot[] = [];
  const tracker = new ScrollTracker(nodes, (snapshot) => snapshots.push(snapshot), {
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

describe('吸顶时机', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('首次出现：标题完全滑到条后面才浮出，不会提前露出', () => {
    const rig = createRig([50, 40, 40]); // 条顶边 60，判定线 66
    rig.setTop(0, 300);
    rig.setTop(1, 900);
    rig.setTop(2, 1500);
    rig.flush();
    expect(rig.last()?.index).toBe(-1);

    rig.setTop(0, 90); // 标题还露在条下面
    rig.flush();
    expect(rig.last()?.index).toBe(-1);

    rig.setTop(0, 66); // 刚好滑到条后面
    rig.flush();
    expect(rig.last()?.index).toBe(0);

    rig.setTop(0, 20);
    rig.flush();
    expect(rig.last()?.index).toBe(0);
  });

  it('向下滚动：下一个标题滑到条后面才切换', () => {
    const rig = createRig([50, 40, 40]);
    rig.setTop(0, 66);
    rig.setTop(1, 400);
    rig.setTop(2, 900);
    rig.flush();
    expect(rig.last()?.index).toBe(0);

    rig.setTop(0, -200);
    rig.setTop(1, 85); // 标题还露在条下面
    rig.flush();
    expect(rig.last()?.index).toBe(0);

    rig.setTop(1, 66);
    rig.flush();
    expect(rig.last()?.index).toBe(1);
  });

  it('向上回滚：下级标题的原文一露头就退回上一级', () => {
    const rig = createRig([50, 40, 40]);
    rig.setTop(0, 60);
    rig.setTop(1, 60);
    rig.setTop(2, 900);
    rig.flush();
    expect(rig.last()?.index).toBe(1);

    rig.setTop(0, -50);
    rig.setTop(1, 70); // 下级标题刚开始重新露头 → 立刻回到上一节
    rig.flush();
    expect(rig.last()?.index).toBe(0);

    rig.setTop(0, 130); // 连第一级标题也露出来了 → 静默
    rig.flush();
    expect(rig.last()?.index).toBe(-1);
  });

  it('主动跳转后目标章节生效，回滚或继续下滚都会自然交接', () => {
    const rig = createRig([50, 40, 40]);
    rig.setTop(0, 66);
    rig.setTop(1, 400);
    rig.setTop(2, 900);
    rig.flush();
    expect(rig.last()?.index).toBe(0);

    // 跳转到第 2 节：落地时它的标题停在条下方（66 + 40 + 6 = 112 以内）
    rig.setTop(0, -1400);
    rig.setTop(1, -400);
    rig.setTop(2, 110);
    rig.flush();
    rig.tracker.focusIndex(2);
    expect(rig.last()?.index).toBe(2);

    // 回滚到目标标题重新露头 → 交还给上一节
    rig.setTop(0, -1200);
    rig.setTop(1, -200);
    rig.setTop(2, 140);
    rig.flush();
    expect(rig.last()?.index).toBe(1);

    // 继续下滚，被更深的标题取代 → 交还给下一节
    rig.setTop(0, -1400);
    rig.setTop(1, -600);
    rig.setTop(2, 60);
    rig.flush();
    expect(rig.last()?.index).toBe(2);
  });

  it('条高变化后基准线跟着变，不需要重新加载', () => {
    const rig = createRig([50, 40, 40]);
    rig.setTop(0, 400);
    rig.setTop(1, 123); // 比 112 低但比 82 高
    rig.setTop(2, 900);
    rig.flush();
    expect(rig.last()?.index).toBe(-1);

    rig.setDock(150); // 条整体下移 → 基准线也下移
    rig.flush();
    expect(rig.last()?.index).toBe(1);
  });
});

describe('整篇文章的阅读进度', () => {
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
      text: '标题',
      top: 0,
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

  it('0 表示刚开始读，1 表示正文末尾已进入视口底部', () => {
    const scope = document.createElement('article');
    document.body.appendChild(scope);
    const setTop = stubRect(scope, 100, 3000);
    const { snapshots, tracker } = trackScope(scope);
    const line = 44; // dockTop(0) + 默认条高(44)
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

  it('没有正文容器时不计算进度，也不会抛错', () => {
    const { snapshots, tracker } = trackScope(null);
    tracker.flush();
    expect(snapshots.at(-1)?.progress ?? 0).toBe(0);
  });

  it('正文比视口还短时直接算读完', () => {
    const scope = document.createElement('article');
    document.body.appendChild(scope);
    stubRect(scope, 300, 200);
    const { snapshots, tracker } = trackScope(scope);
    tracker.flush();
    expect(snapshots.at(-1)?.progress).toBe(1);
  });
});
