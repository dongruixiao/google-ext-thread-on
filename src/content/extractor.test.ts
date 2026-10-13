import { beforeEach, describe, expect, it } from 'vitest';
import { buildHeadingIndex, headingSignature } from './extractor';

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

/** 营销首页：文字几乎都在链接/卡片里 */
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

/** 正文里混着侧栏导航标题（GitHub 仓库页那种结构） */
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

describe('buildHeadingIndex', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('在文章页构建出层级链，并排除站点框架里的标题', () => {
    articlePage();
    const index = buildHeadingIndex();
    expect(index).not.toBeNull();
    if (!index) return;

    expect(index.isArticle).toBe(true);
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

  it('标题缺少 id 时生成占位标识', () => {
    articlePage();
    const index = buildHeadingIndex();
    const withoutNativeId = index?.headings.find((node) => node.text === '小节标题');
    expect(withoutNativeId?.id).toBe('wss-3');
    expect(withoutNativeId?.element.dataset.wssId).toBe('wss-3');

    const withNativeId = index?.headings.find((node) => node.text === '第一节标题');
    expect(withNativeId?.id).toBe('first');
  });

  it('列表页 / 卡片聚合页不会误判为文章', () => {
    listPage();
    const index = buildHeadingIndex();
    expect(index).not.toBeNull();
    expect(index?.isArticle).toBe(false);
  });

  it('营销首页（文字大多在链接里）不会误激活', () => {
    marketingPage();
    const index = buildHeadingIndex();
    expect(index?.isArticle).toBe(false);
  });

  it('侧栏导航标题没有正文，不进入大纲', () => {
    pageWithSidebarHeadings();
    const index = buildHeadingIndex();
    const texts = index?.headings.map((node) => node.text) ?? [];
    expect(texts).toEqual(['项目说明', '安装', '使用']);
    expect(index?.isArticle).toBe(true);
  });

  it('没有标题时返回 null', () => {
    document.body.innerHTML = '<main><p>只有正文，没有标题</p></main>';
    expect(buildHeadingIndex()).toBeNull();
  });

  it('索引指纹随标题结构变化', () => {
    articlePage();
    const first = buildHeadingIndex();
    const before = first ? headingSignature(first) : '';
    document.querySelector('#first')?.remove();
    const second = buildHeadingIndex();
    const after = second ? headingSignature(second) : '';
    expect(before).not.toBe('');
    expect(before).not.toBe(after);
  });
});
