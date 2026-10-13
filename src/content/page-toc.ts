import { HOST_ID } from '../shared/constants';
import type { HeadingNode } from './extractor';

/**
 * 原站目录探测：
 * 如果页面本身已经有「当前可见」的目录（sticky 侧栏 / 文内 TOC），
 * 我们就退让成极简指示器，避免和原站目录抢戏。
 */

const TOC_SELECTORS = [
  '#toc',
  '[id*="toc" i]',
  '[class*="toc" i]',
  '.table-of-contents',
  '.markdown-toc',
  '.post-toc',
  '.sidebar-toc',
  '.article-toc',
  '.outline',
  'nav[aria-label*="目录"]',
  '[aria-label*="contents" i]',
  '[aria-label*="on this page" i]',
].join(',');

/** 兜底扫描范围：只在这些结构性容器里找目录，避免全页扫描 */
const FALLBACK_SELECTORS = 'nav, aside, [role="navigation"], [role="complementary"]';

/** 至少多少个指向正文标题的链接才算目录 */
const MIN_TOC_LINKS = 3;

function collectTargetIds(headings: HeadingNode[]): Set<string> {
  const ids = new Set<string>();
  for (const heading of headings) {
    if (heading.element.id) ids.add(heading.element.id);
  }
  return ids;
}

function countHeadingLinks(root: HTMLElement, targets: Set<string>): number {
  let count = 0;
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = anchor.getAttribute('href') ?? '';
    const hashIndex = href.indexOf('#');
    if (hashIndex < 0) continue;
    const id = decodeURIComponent(href.slice(hashIndex + 1));
    if (targets.has(id)) count += 1;
  }
  return count;
}

/** 找出页面上可能是目录的容器（按文档顺序，最多 12 个） */
export function findTocCandidates(headings: HeadingNode[]): HTMLElement[] {
  if (headings.length < MIN_TOC_LINKS) return [];
  const targets = collectTargetIds(headings);
  if (targets.size < MIN_TOC_LINKS) return [];

  const found = new Set<HTMLElement>();
  for (const element of document.querySelectorAll<HTMLElement>(TOC_SELECTORS)) {
    if (found.size >= 12) break;
    if (element.closest(`#${HOST_ID}`)) continue;
    if (countHeadingLinks(element, targets) >= MIN_TOC_LINKS) found.add(element);
  }

  if (found.size === 0) {
    for (const element of document.querySelectorAll<HTMLElement>(FALLBACK_SELECTORS)) {
      if (found.size >= 12) break;
      if (element.closest(`#${HOST_ID}`)) continue;
      if (countHeadingLinks(element, targets) >= MIN_TOC_LINKS + 1) found.add(element);
    }
  }

  return [...found];
}

/** 目录此刻是否真的出现在视口里（贴在屏幕外的目录帮不了用户） */
export function isAnyTocVisible(candidates: HTMLElement[]): boolean {
  for (const element of candidates) {
    if (!element.isConnected) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width < 80 || rect.height < 60) continue;
    if (rect.bottom < 40 || rect.top > window.innerHeight - 40) continue;
    let style: CSSStyleDeclaration;
    try {
      style = getComputedStyle(element);
    } catch {
      continue;
    }
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if (style.opacity !== '' && Number(style.opacity) === 0) continue;
    return true;
  }
  return false;
}
