import { beforeEach, describe, expect, it } from 'vitest';
import { cloneHeading, estimateHeadingHeight } from './heading-clone';

describe('cloneHeading', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('把页面标题的排版样式搬运到克隆上', () => {
    document.body.innerHTML = `
      <h2
        id="src"
        style="font-family: Georgia, serif; font-size: 28px; font-weight: 800; color: rgb(10, 20, 30);
               line-height: 36px; letter-spacing: 1px; margin: 24px 0"
      >标题 <code>code()</code></h2>
    `;
    const source = document.getElementById('src') as HTMLElement;
    const clone = cloneHeading(source);

    expect(clone.textContent).toBe('标题 code()');
    expect(clone.style.getPropertyValue('font-size')).toBe('28px');
    expect(clone.style.getPropertyValue('font-weight')).toBe('800');
    expect(clone.style.getPropertyValue('line-height')).toBe('36px');
    expect(clone.style.getPropertyValue('letter-spacing')).toBe('1px');
    expect(clone.style.getPropertyValue('font-family')).toContain('Georgia');
  });

  it('清掉 id、去掉交互，并强制单行截断', () => {
    document.body.innerHTML = `
      <h2 id="src"><a id="inner" href="#x">链接标题</a></h2>
    `;
    const source = document.getElementById('src') as HTMLElement;
    const clone = cloneHeading(source);

    expect(clone.id).toBe('');
    expect(clone.querySelector('#inner')).toBeNull();
    expect(clone.querySelector('a')?.getAttribute('tabindex')).toBe('-1');
    expect(clone.style.getPropertyValue('margin')).toMatch(/^0(px)?$/);
    expect(clone.style.getPropertyValue('white-space')).toBe('nowrap');
    expect(clone.style.getPropertyValue('pointer-events')).toBe('none');
    expect(clone.querySelector('a')?.style.getPropertyValue('white-space')).toBe('nowrap');
  });
});

describe('estimateHeadingHeight', () => {
  it('按行高估算吸顶条高度', () => {
    document.body.innerHTML = '<h2 id="src" style="line-height: 34px">标题</h2>';
    const source = document.getElementById('src') as HTMLElement;
    expect(estimateHeadingHeight(source)).toBe(50); // 34 + 8 * 2
  });

  it('异常行高会被夹到可读区间', () => {
    document.body.innerHTML = '<h2 id="big" style="line-height: 200px">标题</h2>';
    const big = document.getElementById('big') as HTMLElement;
    expect(estimateHeadingHeight(big)).toBe(96);
    expect(estimateHeadingHeight(null)).toBeGreaterThanOrEqual(32);
  });

  it('把标题自身的上下内边距算进去，和实测条高一致', () => {
    document.body.innerHTML =
      '<h2 id="padded" style="line-height: 34px; padding-top: 8px; padding-bottom: 2px">标题</h2>';
    const padded = document.getElementById('padded') as HTMLElement;
    expect(estimateHeadingHeight(padded)).toBe(60); // 34 + 10 + 16
  });
});
