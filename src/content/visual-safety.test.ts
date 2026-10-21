import { beforeEach, describe, expect, it } from 'vitest';
import { assessVisualSafety } from './visual-safety';

function headings(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('h2')];
}

describe('assessVisualSafety', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.body.removeAttribute('style');
  });

  it('稳定的实色背景和高对比标题可以安全融合', () => {
    document.body.innerHTML = `
      <article id="scope" style="background-color: rgb(255, 255, 255)">
        <h2 style="color: rgb(20, 20, 20); font-size: 32px; font-weight: 700">标题一</h2>
        <h2 style="color: rgb(20, 20, 20); font-size: 32px; font-weight: 700">标题二</h2>
      </article>
    `;
    expect(assessVisualSafety(document.getElementById('scope') as HTMLElement, headings())).toMatchObject({
      safe: true,
      reason: 'safe',
      background: 'rgb(255, 255, 255)',
    });
  });

  it('鲜艳但统一且对比足够的纯色背景仍然可用', () => {
    document.body.innerHTML = `
      <article id="scope" style="background-color: rgb(220, 0, 130)">
        <h2 style="color: rgb(255, 255, 255); font-size: 32px; font-weight: 700">标题一</h2>
        <h2 style="color: rgb(255, 255, 255); font-size: 32px; font-weight: 700">标题二</h2>
      </article>
    `;
    expect(assessVisualSafety(document.getElementById('scope') as HTMLElement, headings()).safe).toBe(true);
  });

  it('渐变或图片背景不会被猜测成某种纯色', () => {
    document.body.innerHTML = `
      <article id="scope" style="background-image: linear-gradient(red, blue)">
        <h2 style="color: white; font-size: 32px">标题一</h2>
        <h2 style="color: white; font-size: 32px">标题二</h2>
      </article>
    `;
    expect(assessVisualSafety(document.getElementById('scope') as HTMLElement, headings())).toMatchObject({
      safe: false,
      reason: 'background-complex',
    });
  });

  it('低对比度标题保持静默', () => {
    document.body.innerHTML = `
      <article id="scope" style="background-color: rgb(255, 255, 255)">
        <h2 style="color: rgb(174, 174, 174); font-size: 16px; font-weight: 400">标题一</h2>
        <h2 style="color: rgb(174, 174, 174); font-size: 16px; font-weight: 400">标题二</h2>
      </article>
    `;
    expect(assessVisualSafety(document.getElementById('scope') as HTMLElement, headings())).toMatchObject({
      safe: false,
      reason: 'low-contrast',
    });
  });

  it('依赖混合模式或滤镜的标题效果保持不变，直接静默', () => {
    document.body.innerHTML = `
      <article id="scope" style="background-color: white">
        <h2 style="color: black; font-size: 32px; mix-blend-mode: multiply">标题一</h2>
        <h2 style="color: black; font-size: 32px">标题二</h2>
      </article>
    `;
    expect(assessVisualSafety(document.getElementById('scope') as HTMLElement, headings())).toMatchObject({
      safe: false,
      reason: 'title-effect',
    });
  });

  it('局部提示卡片的背景差异不会误伤整页，仍按吸顶表面检查对比度', () => {
    document.body.innerHTML = `
      <article id="scope" style="background-color: white">
        <div style="background-color: rgb(240, 240, 240)">
          <h2 style="color: black; font-size: 32px">标题一</h2>
        </div>
        <div style="background-color: rgb(100, 100, 100)">
          <h2 style="color: black; font-size: 32px">标题二</h2>
        </div>
      </article>
    `;
    expect(assessVisualSafety(document.getElementById('scope') as HTMLElement, headings())).toMatchObject({
      safe: true,
      reason: 'safe',
    });
  });
});
