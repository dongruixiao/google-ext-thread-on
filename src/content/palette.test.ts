import { beforeEach, describe, expect, it } from 'vitest';
import { findBackground, samplePageStyle } from './palette';

describe('findBackground', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.body.removeAttribute('style');
  });

  it('向上找到第一个有实色背景的祖先', () => {
    document.body.innerHTML = `
      <div id="wrapper" style="background-color: rgb(250, 250, 252)">
        <main><article id="scope"><h2>标题</h2></article></main>
      </div>
    `;
    const scope = document.getElementById('scope') as HTMLElement;
    expect(findBackground(scope)).toBe('rgb(250, 250, 252)');
  });

  it('整条链都没有实色背景时返回空串（交由主题兜底）', () => {
    document.body.style.backgroundColor = 'rgb(18, 20, 28)';
    document.body.innerHTML = '<main><article id="scope"><h2>标题</h2></article></main>';
    const scope = document.getElementById('scope') as HTMLElement;
    expect(findBackground(scope)).toBe('rgb(18, 20, 28)');

    document.body.removeAttribute('style');
    expect(findBackground(scope)).toBe('');
  });
});

describe('samplePageStyle', () => {
  it('字号按比例缩放并限制在可读区间', () => {
    document.body.innerHTML = `
      <main><article id="scope" style="background-color: #fff">
        <h2 id="h" style="font-size: 40px; color: rgb(20, 20, 20)">很长的小节标题</h2>
      </article></main>
    `;
    const scope = document.getElementById('scope') as HTMLElement;
    const heading = document.getElementById('h') as HTMLElement;
    const style = samplePageStyle(scope, heading);
    expect(style.background).toBe('rgb(255, 255, 255)');
    expect(style.color).toBe('rgb(20, 20, 20)');
    expect(style.titleSize).toBe(20); // 40 * 0.62 = 24.8 → 上限 20
  });

  it('缺少标题时给出可用的默认值', () => {
    const style = samplePageStyle(null, null);
    expect(style.titleSize).toBeGreaterThanOrEqual(13);
    expect(style.background).toBe('');
    expect(style.color).toBe('');
  });

  it('采样不到底色时不采样文字颜色，避免深底深字', () => {
    document.body.innerHTML = `
      <main><article id="scope">
        <h2 id="h" style="color: rgb(17, 17, 17); font-size: 20px">标题</h2>
      </article></main>
    `;
    const scope = document.getElementById('scope') as HTMLElement;
    const heading = document.getElementById('h') as HTMLElement;
    const style = samplePageStyle(scope, heading);
    expect(style.background).toBe('');
    expect(style.color).toBe('');
    expect(style.titleSize).toBe(13);
  });
});
