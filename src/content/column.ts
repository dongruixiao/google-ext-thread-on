/**
 * 推导「正文列」的位置。
 *
 * 不能直接拿正文容器的矩形：很多文档站把左侧目录也放在 <main> 里，
 * 容器本身是整宽的（例如 pi.dev 的 main.content-shell 是 0→1265），
 * 于是吸顶标题会被贴到视口最左边，和正文文字对不齐。
 *
 * 正确做法是**从内容本身量**：用我们索引到的标题取列的左缘，
 * 再用同一列里的段落取右缘。
 */

export interface Box {
  left: number;
  right: number;
  width: number;
}

export interface ColumnInput {
  /** 正文列里的标题矩形（已按正文容器与噪音区过滤过） */
  headingBoxes: Box[];
  /** 内容块矩形（段落、代码块、引用等） */
  blockBoxes: Box[];
  /** 兜底：正文容器自身的矩形 */
  scopeBox: Box | null;
  viewportWidth: number;
}

/** 推导出来的列至少要这么宽，否则认为不可信 */
const MIN_COLUMN_WIDTH = 240;
/** 判定“同一个列”的横向容差 */
const COLUMN_TOLERANCE = 48;
/** 兜底列宽（拿不到内容块时） */
const FALLBACK_WIDTH = 720;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function isValid(box: Box): boolean {
  return Number.isFinite(box.left) && Number.isFinite(box.right) && box.width > 0;
}

export function deriveColumnBox(input: ColumnInput): Box | null {
  const headings = input.headingBoxes.filter(isValid);
  const blocks = input.blockBoxes.filter(isValid);

  if (headings.length >= 2) {
    const left = median(headings.map((box) => box.left));
    const inColumn = blocks.filter(
      (box) => Math.abs(box.left - left) <= COLUMN_TOLERANCE && box.width >= 120,
    );
    const right = inColumn.length >= 2
      ? median(inColumn.map((box) => box.right))
      : Math.min(input.viewportWidth, left + FALLBACK_WIDTH);
    const width = right - left;
    if (width >= MIN_COLUMN_WIDTH) return { left, right, width };
  }

  if (input.scopeBox && input.scopeBox.width >= MIN_COLUMN_WIDTH) {
    return { ...input.scopeBox };
  }
  return null;
}
