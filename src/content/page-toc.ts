import { HOST_ID } from '../shared/constants';
import type { HeadingNode } from './extractor';

/** Detect a visible native table of contents and defer to it. */

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

/** Fallback scan is limited to structural containers. */
const FALLBACK_SELECTORS = 'nav, aside, [role="navigation"], [role="complementary"]';

/** Minimum number of links to article headings. */
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

/** Return document-ordered candidates, capped to bound scanning cost. */
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

/** Off-screen native contents provide no value to the reader. */
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
