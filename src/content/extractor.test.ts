import { beforeEach, describe, expect, it } from 'vitest';
import {
  assessHeadingGeometry,
  buildHeadingIndex,
  headingIndexStillAttached,
  headingSignature,
  type HeadingNode,
} from './extractor';

function paragraph(length: number): string {
  return '状'.repeat(length);
}

function articlePage(): void {
  document.body.innerHTML = `
    <header><h1>站点名称</h1><nav><h2>导航里的标题</h2></nav></header>
    <main>
      <article class="post-content">
        <h1>一篇文章的标题</h1>
        <p>${paragraph(120)}</p>
        <h2 id="first">第一节标题</h2>
        <p>${paragraph(320)}</p>
        <h3>小节标题</h3>
        <p>${paragraph(310)}</p>
        <h2>第二节标题</h2>
        <p>${paragraph(300)}</p>
      </article>
      <aside><h3>侧边栏里的标题</h3></aside>
    </main>
    <footer><h3>页脚里的标题</h3></footer>
  `;
}

function listPage(): void {
  const cards = Array.from(
    { length: 8 },
    (_, index) => `
      <article class="card">
        <h2>第 ${index + 1} 篇摘要标题</h2>
        <p>${paragraph(60)}</p>
      </article>
    `,
  ).join('');
  document.body.innerHTML = `<main>${cards}</main>`;
}

/** Marketing page with almost all content inside links and cards. */
function marketingPage(): void {
  const cards = Array.from(
    { length: 8 },
    (_, index) => `
      <a class="card" href="#feature-${index}">
        <h2>产品能力 ${index + 1}</h2>
        <p>${paragraph(120)}</p>
      </a>
    `,
  ).join('');
  document.body.innerHTML = `<main><h1>把一切连接起来</h1>${cards}</main>`;
}

/** Article surface mixed with sidebar navigation headings. */
function pageWithSidebarHeadings(): void {
  document.body.innerHTML = `
    <main>
      <div class="repo-sidebar">
        <h2>Releases</h2>
        <h2>Packages</h2>
        <h2>Languages</h2>
        <h2>Contributors</h2>
      </div>
      <article class="markdown-body">
        <h1>项目说明</h1>
        <p>${paragraph(200)}</p>
        <h2>安装</h2>
        <p>${paragraph(320)}</p>
        <h2>使用</h2>
        <p>${paragraph(360)}</p>
      </article>
    </main>
  `;
}

function conversationPage(): void {
  document.body.innerHTML = `
    <main role="main">
      <div role="log">
        <article data-message-author-role="user"><p>${paragraph(120)}</p></article>
        <article data-message-author-role="assistant">
          <h2>先分析问题</h2><p>${paragraph(620)}</p>
          <h3>一个子问题</h3><p>${paragraph(420)}</p>
        </article>
        <article data-message-author-role="user"><p>${paragraph(100)}</p></article>
        <article data-message-author-role="assistant">
          <h2>再给出方案</h2><p>${paragraph(700)}</p>
        </article>
      </div>
    </main>
    <form style="position:fixed;left:240px;right:80px;bottom:16px">
      <textarea aria-label="Message"></textarea>
    </form>
  `;
  const control = document.querySelector('textarea') as HTMLElement;
  const rect = {
    x: 240,
    y: 700,
    top: 700,
    left: 240,
    right: 960,
    bottom: 752,
    width: 720,
    height: 52,
    toJSON: () => ({}),
  } as DOMRect;
  control.getBoundingClientRect = () => rect;
  control.getClientRects = () => [rect] as unknown as DOMRectList;
}

function geometryHeadings(
  boxes: Array<{ left: number; top: number; width?: number; height?: number }>,
): HeadingNode[] {
  return boxes.map((box, index) => {
    const element = document.createElement('h2');
    const width = box.width ?? 180;
    const height = box.height ?? 28;
    element.getBoundingClientRect = () =>
      ({
        x: box.left,
        y: box.top,
        left: box.left,
        right: box.left + width,
        top: box.top,
        bottom: box.top + height,
        width,
        height,
        toJSON: () => ({}),
      }) as DOMRect;
    return {
      id: `g${index}`,
      element,
      level: 2,
      text: `标题 ${index + 1}`,
      parentIndex: -1,
    };
  });
}

describe('buildHeadingIndex', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('builds a hierarchy while excluding site chrome headings', () => {
    articlePage();
    const index = buildHeadingIndex();
    expect(index).not.toBeNull();
    if (!index) return;

    expect(index.isReadingCandidate).toBe(true);
    expect(index.headings.map((node) => node.text)).toEqual([
      '一篇文章的标题',
      '第一节标题',
      '小节标题',
      '第二节标题',
    ]);
    expect(index.headings.map((node) => node.level)).toEqual([1, 2, 3, 2]);
    expect(index.headings.map((node) => node.parentIndex)).toEqual([-1, 0, 1, 0]);
    expect(index.scope.tagName.toLowerCase()).toBe('article');
  });

  it('generates stable IDs for headings without native IDs', () => {
    articlePage();
    const index = buildHeadingIndex();
    const withoutNativeId = index?.headings.find((node) => node.text === '小节标题');
    expect(withoutNativeId?.id).toBe('wss-3');
    expect(withoutNativeId?.element.dataset.wssId).toBe('wss-3');

    const withNativeId = index?.headings.find((node) => node.text === '第一节标题');
    expect(withNativeId?.id).toBe('first');
  });

  it('rejects list and card aggregation pages', () => {
    listPage();
    const index = buildHeadingIndex();
    expect(index).not.toBeNull();
    expect(index?.isReadingCandidate).toBe(false);
    expect(
      document.querySelector('[data-wss-id], [data-wss-scope], [data-wss-stats]'),
    ).toBeNull();
  });

  it('rejects marketing pages dominated by links', () => {
    marketingPage();
    const index = buildHeadingIndex();
    expect(index?.isReadingCandidate).toBe(false);
    expect(
      document.querySelector('[data-wss-id], [data-wss-scope], [data-wss-stats]'),
    ).toBeNull();
  });

  it('keeps conversation pages silent', () => {
    conversationPage();
    const index = buildHeadingIndex();
    expect(index).not.toBeNull();
    expect(index?.isConversation).toBe(true);
    expect(index?.conversationReason).toBe('explicit-message-roles');
    expect(index?.isReadingCandidate).toBe(false);
    expect(index?.diagnostics).toContain('conv=1');
    expect(
      document.querySelector('[data-wss-id], [data-wss-scope], [data-wss-stats]'),
    ).toBeNull();
  });

  it('does not depend on the page background palette', () => {
    document.body.innerHTML = `
      <article style="background-image: linear-gradient(red, blue)">
        <h1 style="color: white; font-size: 40px">文章标题</h1>
        <p>${paragraph(120)}</p>
        <h2 style="color: white; font-size: 32px">第一节</h2>
        <p>${paragraph(720)}</p>
        <h2 style="color: white; font-size: 32px">第二节</h2>
        <p>${paragraph(680)}</p>
      </article>
    `;
    const index = buildHeadingIndex();
    expect(index?.isReadingCandidate).toBe(true);
  });

  it('omits sidebar navigation headings without section text', () => {
    pageWithSidebarHeadings();
    const index = buildHeadingIndex();
    const texts = index?.headings.map((node) => node.text) ?? [];
    expect(texts).toEqual(['项目说明', '安装', '使用']);
    expect(index?.isReadingCandidate).toBe(true);
  });

  it('keeps short summaries and their required ancestors', () => {
    document.body.innerHTML = `
      <article>
        <h1>文章标题</h1>
        <p>${paragraph(120)}</p>
        <h2>第一节</h2>
        <p>${paragraph(360)}</p>
        <h2>带子标题的章节</h2>
        <h3>子标题</h3>
        <p>${paragraph(180)}</p>
        <h2>总结</h2>
        <p>${paragraph(20)}</p>
      </article>
    `;
    const index = buildHeadingIndex();
    expect(index?.headings.map((node) => node.text)).toEqual([
      '文章标题',
      '第一节',
      '带子标题的章节',
      '子标题',
      '总结',
    ]);
    expect(index?.headings.at(-1)?.parentIndex).toBe(0);
  });

  it('returns null when no headings exist', () => {
    document.body.innerHTML = '<main><p>只有正文，没有标题</p></main>';
    expect(buildHeadingIndex()).toBeNull();
  });

  it('changes the signature when heading structure changes', () => {
    articlePage();
    const first = buildHeadingIndex();
    const before = first ? headingSignature(first) : '';
    document.querySelector('#first')?.remove();
    const second = buildHeadingIndex();
    const after = second ? headingSignature(second) : '';
    expect(before).not.toBe('');
    expect(before).not.toBe(after);
  });

  it('rejects a reused index after identical DOM is replaced', () => {
    articlePage();
    const first = buildHeadingIndex();
    expect(first).not.toBeNull();
    if (!first) return;
    expect(headingIndexStillAttached(first)).toBe(true);

    const beforeSignature = headingSignature(first);
    const article = document.querySelector('article');
    if (!article) return;
    article.innerHTML = article.innerHTML;
    const second = buildHeadingIndex();
    expect(second).not.toBeNull();
    if (!second) return;

    expect(headingSignature(second)).toBe(beforeSignature);
    expect(headingIndexStillAttached(first)).toBe(false);
    expect(headingIndexStillAttached(second)).toBe(true);
  });
});

describe('heading geometry gate', () => {
  it('accepts independent headings in one reading column', () => {
    const geometry = assessHeadingGeometry(
      geometryHeadings([
        { left: 320, top: 100 },
        { left: 321, top: 180 },
        { left: 319, top: 260 },
      ]),
      1280,
    );
    expect(geometry.reliable).toBe(true);
    expect(geometry.alignedRatio).toBe(1);
    expect(geometry.overlapRatio).toBe(0);
  });

  it('rejects headings spread across columns', () => {
    const geometry = assessHeadingGeometry(
      geometryHeadings([
        { left: 80, top: 100 },
        { left: 520, top: 180 },
        { left: 960, top: 260 },
      ]),
      1280,
    );
    expect(geometry.reliable).toBe(false);
  });

  it('rejects many hidden headings stacked at one point', () => {
    const geometry = assessHeadingGeometry(
      geometryHeadings([
        { left: 320, top: 100 },
        { left: 320, top: 100 },
        { left: 320, top: 100 },
      ]),
      1280,
    );
    expect(geometry.reliable).toBe(false);
    expect(geometry.overlapRatio).toBe(1);
  });

  it('rejects unmeasurable or horizontally clipped headings', () => {
    const geometry = assessHeadingGeometry(
      geometryHeadings([
        { left: 320, top: 100, width: 0 },
        { left: 1400, top: 180 },
        { left: 320, top: 260, height: 0 },
      ]),
      1280,
    );
    expect(geometry.reliable).toBe(false);
    expect(geometry.measurable).toBe(0);
  });
});
