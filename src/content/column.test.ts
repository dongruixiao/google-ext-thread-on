import { describe, expect, it } from 'vitest';
import { deriveColumnBox } from './column';

const box = (left: number, right: number) => ({ left, right, width: right - left });

describe('deriveColumnBox', () => {
  it('用标题的左缘 + 同列段落的右缘推出正文列（pi.dev 那种整宽容器）', () => {
    const result = deriveColumnBox({
      headingBoxes: [box(380, 560), box(380, 673), box(380, 859)],
      blockBoxes: [box(380, 885), box(380, 884), box(380, 883)],
      // 容器是整宽的（把左侧目录也框进来了）
      scopeBox: box(0, 1265),
      viewportWidth: 1280,
    });
    // 右缘取中位数：883/884/885 的中位数是 884（不被最宽一块带跑）
    expect(result).toEqual({ left: 380, right: 884, width: 504 });
  });

  it('侧栏里的段落不会把右缘带走', () => {
    const result = deriveColumnBox({
      headingBoxes: [box(380, 560), box(380, 859)],
      blockBoxes: [box(66, 320), box(380, 885), box(380, 884)],
      scopeBox: box(0, 1265),
      viewportWidth: 1280,
    });
    expect(result?.right).toBe(885);
    expect(result?.left).toBe(380);
  });

  it('拿不到段落时按标题左缘 + 兜底宽度', () => {
    const result = deriveColumnBox({
      headingBoxes: [box(200, 400), box(200, 500)],
      blockBoxes: [],
      scopeBox: box(0, 1265),
      viewportWidth: 1280,
    });
    expect(result).toEqual({ left: 200, right: 920, width: 720 });
  });

  it('标题不足两个时回退到容器矩形', () => {
    const result = deriveColumnBox({
      headingBoxes: [box(380, 560)],
      blockBoxes: [],
      scopeBox: box(100, 900),
      viewportWidth: 1280,
    });
    expect(result).toEqual({ left: 100, right: 900, width: 800 });
  });

  it('推不出可信的列时返回 null', () => {
    const result = deriveColumnBox({
      headingBoxes: [],
      blockBoxes: [],
      scopeBox: box(0, 120),
      viewportWidth: 1280,
    });
    expect(result).toBeNull();
  });
});
