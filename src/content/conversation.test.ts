import { beforeEach, describe, expect, it } from 'vitest';
import { detectConversationSurface } from './conversation';

function longText(length = 180): string {
  return '这是一段用于证明当前区域包含真实内容的文字。'.repeat(Math.ceil(length / 20)).slice(0, length);
}

function stubComposer(element: HTMLElement, top = 700, width = 720): void {
  const rect = {
    x: 240,
    y: top,
    top,
    left: 240,
    right: 240 + width,
    bottom: top + 52,
    width,
    height: 52,
    toJSON: () => ({}),
  } as DOMRect;
  element.getBoundingClientRect = () => rect;
  element.getClientRects = () => [rect] as unknown as DOMRectList;
}

function composer(markup = '<textarea aria-label="Message"></textarea>'): HTMLElement {
  document.body.insertAdjacentHTML(
    'beforeend',
    `<form style="position:fixed;left:240px;right:80px;bottom:16px">${markup}</form>`,
  );
  const form = document.querySelector('form') as HTMLElement;
  const control = form.querySelector('textarea, [contenteditable], [role="textbox"]') as HTMLElement;
  stubComposer(control);
  return control;
}

describe('detectConversationSurface', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('识别带明确用户/助手角色的持续对话', () => {
    document.body.innerHTML = `
      <main>
        <article data-message-author-role="user"><p>${longText(120)}</p></article>
        <article data-message-author-role="assistant">
          <h2>实现方案</h2><p>${longText(320)}</p>
        </article>
        <article data-message-author-role="user"><p>${longText(100)}</p></article>
        <article data-message-author-role="assistant">
          <h2>补充说明</h2><p>${longText(300)}</p>
        </article>
      </main>
    `;
    composer();
    const result = detectConversationSurface();
    expect(result.detected).toBe(true);
    expect(result.reason).toBe('explicit-message-roles');
    expect(result.turns).toBe(4);
  });

  it('识别通用语义消息元素组成的对话', () => {
    document.body.innerHTML = `
      <main>
        <user-query>${longText(80)}</user-query>
        <model-response><h2>回答</h2><p>${longText(280)}</p></model-response>
        <user-query>${longText(90)}</user-query>
        <model-response><h2>继续</h2><p>${longText(260)}</p></model-response>
      </main>
    `;
    composer('<div contenteditable="true" role="textbox"></div>');
    expect(detectConversationSurface()).toMatchObject({
      detected: true,
      reason: 'semantic-turn-elements',
      turns: 4,
    });
  });

  it('没有语义角色时，ARIA 对话日志也能作为证据', () => {
    document.body.innerHTML = `
      <main role="main">
        <div role="log">
          <section>${longText(140)}</section>
          <section><h2>回答标题</h2><p>${longText(240)}</p></section>
        </div>
      </main>
    `;
    composer('<div contenteditable="true"></div>');
    expect(detectConversationSurface()).toMatchObject({
      detected: true,
      reason: 'aria-transcript',
      turns: 2,
    });
  });

  it('普通文章底部的静态评论框不会把文章判成聊天页', () => {
    document.body.innerHTML = `
      <article>
        <h1>长文章</h1><p>${longText(800)}</p>
        <h2>第一节</h2><p>${longText(700)}</p>
        <h2>第二节</h2><p>${longText(600)}</p>
      </article>
      <form><textarea aria-label="评论"></textarea></form>
    `;
    const control = document.querySelector('textarea') as HTMLElement;
    stubComposer(control, 120, 600);
    expect(detectConversationSurface().detected).toBe(false);
  });

  it('固定的搜索框不会被当成对话输入区', () => {
    document.body.innerHTML = `
      <main><article><h2>结果一</h2><p>${longText(200)}</p></article>
      <article><h2>结果二</h2><p>${longText(200)}</p></article></main>
      <form role="search" style="position:fixed;bottom:0">
        <textarea aria-label="Search"></textarea>
      </form>
    `;
    const control = document.querySelector('textarea') as HTMLElement;
    stubComposer(control);
    expect(detectConversationSurface().detected).toBe(false);
  });
});
