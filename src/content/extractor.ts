import { HOST_ID } from '../shared/constants';
import { detectConversationSurface, type ConversationReason } from './conversation';

export interface HeadingNode {
  /** Native ID or a generated stable identifier. */
  id: string;
  element: HTMLElement;
  /** 1 = h1, 2 = h2, and so on. */
  level: number;
  text: string;
  /** Parent index, or -1 for a root heading. */
  parentIndex: number;
}

export interface HeadingStats {
  headingCount: number;
  scopeText: number;
  bodyText: number;
  /** Scope text as a share of the full document. */
  scopeShare: number;
  /** Paragraph text as a share of all page paragraph text. */
  paragraphShare: number;
  /** Effective headings as a share of all page headings. */
  headingShare: number;
  /** Whether headings share a stable reading column. */
  columnAligned: boolean;
  /** Whether geometry is reliable enough to avoid false activation. */
  geometryReliable: boolean;
  /** Text length of the longest section. */
  longestSection: number;
  /** Whether the heading tree contains nested levels. */
  hasHierarchy: boolean;
  /** Link text as a share of scope text. */
  linkRatio: number;
  /** Paragraph text as a share of scope text. */
  paragraphRatio: number;
}

export interface HeadingIndex {
  scope: HTMLElement;
  headings: HeadingNode[];
  /** Whether the page has a trustworthy long-form structure. */
  isReadingCandidate: boolean;
  /** Conversation and agent workspaces must remain silent. */
  isConversation: boolean;
  conversationReason: ConversationReason;
  stats: HeadingStats;
  /** Stable diagnostics snapshot captured during indexing. */
  diagnostics: string;
}

/** Semantic containers take precedence over class-name heuristics. */
const SEMANTIC_SELECTOR = 'article, main, [role="main"]';

const HEURISTIC_SELECTOR = [
  '.post-content',
  '.post-body',
  '.markdown-body',
  '.md-content',
  '.entry-content',
  '.article-content',
  '.article-body',
  '.rich_media_content',
  '.prose',
  '.article',
  '#content',
  '.content',
].join(',');

/** Headings inside site chrome are not article structure. */
export const SITE_CHROME_SELECTOR = [
  'nav',
  'aside',
  'footer',
  '[role="navigation"]',
  '[role="complementary"]',
  '[role="contentinfo"]',
  '[role="banner"]',
  '[role="search"]',
  '[role="dialog"]',
  '[aria-hidden="true"]',
  '[hidden]',
  'form',
  '#comments',
  '[id^="comments"]',
  '[class~="comments"]',
  '.comment-list',
  '.comment-section',
].join(',');

const HEADING_SELECTOR = 'h1, h2, h3, h4';
const MAX_LEVEL = 4;
/**
 * Very short sections are valid in READMEs, legal texts, and summaries.
 * Page-level density metrics handle list and search pages instead.
 */
const MIN_SECTION_TEXT = 4;

/** Inline framework payloads must not count as readable page text. */
const SKIP_TEXT_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'TEMPLATE',
  'NOSCRIPT',
  'IFRAME',
  'CANVAS',
  'SVG',
]);

/** Shared, cached text measurement for one indexing pass. */
type Measure = (element: Element) => number;

function createMeasure(): Measure {
  const cache = new Map<Element, number>();
  const count = (element: Element): number => {
    let total = 0;
    for (const child of element.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        total += (child.nodeValue ?? '').length;
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const node = child as Element;
      if (SKIP_TEXT_TAGS.has(node.tagName)) continue;
      total += count(node);
    }
    return total;
  };
  return (element) => {
    const hit = cache.get(element);
    if (hit !== undefined) return hit;
    const value = count(element);
    cache.set(element, value);
    return value;
  };
}

function isVisible(el: HTMLElement): boolean {
  try {
    if (el.getClientRects().length === 0) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (style.opacity === '0') return false;
    return true;
  } catch {
    return false;
  }
}

/** Normalize whitespace, zero-width characters, and Markdown heading marks. */
function normalizeHeadingText(el: HTMLElement): string {
  return (el.textContent ?? '')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^#+\s*/, '')
    .replace(/\s*#+$/, '')
    .slice(0, 240);
}

function levelOf(el: HTMLElement): number {
  const level = Number.parseInt(el.tagName.slice(1), 10);
  return Number.isFinite(level) ? Math.min(level, MAX_LEVEL) : MAX_LEVEL;
}

interface ScopeCandidate {
  element: HTMLElement;
  headings: number;
  text: number;
  /** Text inside paragraph-like content blocks. */
  paragraphText: number;
  /** Whether the candidate came from a semantic element. */
  semantic: boolean;
  score: number;
}

/** Blocks used to distinguish prose from navigation, cards, and tables. */
const CONTENT_BLOCK_SELECTOR = 'p, li, pre, blockquote';
/** Broader blocks used to measure section depth. */
const SECTION_BLOCK_SELECTOR = 'p, li, pre, blockquote, td, dd';

function collectScopeCandidates(measure: Measure): ScopeCandidate[] {
  const seen = new Set<HTMLElement>();
  const candidates: ScopeCandidate[] = [];
  [SEMANTIC_SELECTOR, HEURISTIC_SELECTOR].forEach((selector, group) => {
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      if (seen.has(element)) continue;
      seen.add(element);
      if (element.closest(`#${HOST_ID}`)) continue;
      const headings = element.querySelectorAll(HEADING_SELECTOR).length;
      if (headings === 0) continue;
      const text = measure(element);
      if (text < 200) continue;
      let paragraphText = 0;
      for (const block of element.querySelectorAll(CONTENT_BLOCK_SELECTOR)) {
        paragraphText += measure(block);
      }
      candidates.push({
        element,
        headings,
        text,
        paragraphText,
        semantic: group === 0,
        score: headings * 1200 + Math.min(text, 60000) * 0.6,
      });
    }
  });
  return candidates;
}

/**
 * Refine a broad semantic container into a denser descendant when that
 * descendant owns most paragraph text and has less navigation noise.
 */
function pickScope(candidates: ScopeCandidate[]): ScopeCandidate | null {
  if (candidates.length === 0) return null;
  const best = candidates.reduce((top, item) => (item.score > top.score ? item : top));
  // Prefer the tightest overlapping candidate when scores are close.
  let chosen = candidates
    .filter(
      (candidate) =>
        candidate.score >= best.score * 0.6 &&
        (best.element.contains(candidate.element) || candidate.element.contains(best.element)),
    )
    .reduce((tightest, candidate) => (candidate.text < tightest.text ? candidate : tightest));

  for (let round = 0; round < 4; round += 1) {
    let next: ScopeCandidate | null = null;
    for (const candidate of candidates) {
      if (candidate.element === chosen.element) continue;
      if (!chosen.element.contains(candidate.element)) continue;
      // Coverage prevents moving into a small aside or subtitle block.
      const coverage = chosen.paragraphText > 0 ? candidate.paragraphText / chosen.paragraphText : 0;
      if (coverage < 0.6) continue;
      // Dense prose per heading is a strong article signal.
      const density = candidate.paragraphText / Math.max(1, candidate.headings);
      const chosenDensity = chosen.paragraphText / Math.max(1, chosen.headings);
      if (density < chosenDensity * 1.4) continue;
      // Choose the tightest qualifying descendant.
      if (!next || candidate.text < next.text) next = candidate;
    }
    if (!next) break;
    chosen = next;
  }
  return chosen;
}

/** Collect visible, non-empty headings outside site chrome. */
function collectHeadings(scope: HTMLElement, scopeIsBodyish: boolean): HeadingNode[] {
  const ignoreSelector = scopeIsBodyish ? `${SITE_CHROME_SELECTOR}, header` : SITE_CHROME_SELECTOR;
  const nodes: HeadingNode[] = [];
  for (const el of scope.querySelectorAll<HTMLElement>(HEADING_SELECTOR)) {
    if (el.closest(`#${HOST_ID}`)) continue;
    if (el.closest(ignoreSelector)) continue;
    if (!isVisible(el)) continue;
    const text = normalizeHeadingText(el);
    if (!text) continue;
    nodes.push({
      id: el.id || '',
      element: el,
      level: levelOf(el),
      text,
      parentIndex: -1,
    });
  }
  return nodes;
}

/** Reconstruct parent links from document order and heading levels. */
function linkParents(headings: HeadingNode[]): void {
  const stack: number[] = [];
  headings.forEach((node, index) => {
    while (stack.length > 0 && headings[stack[stack.length - 1]].level >= node.level) {
      stack.pop();
    }
    node.parentIndex = stack.length > 0 ? stack[stack.length - 1] : -1;
    stack.push(index);
  });
}

/** Add stable IDs for jumping and diagnostics without changing native IDs. */
function ensureIds(headings: HeadingNode[], scope: HTMLElement): void {
  const used = new Set<string>();
  headings.forEach((node, index) => {
    if (!node.id) {
      node.id = `wss-${index + 1}`;
    }
    let candidate = node.id;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${node.id}-${suffix}`;
      suffix += 1;
    }
    used.add(candidate);
    node.element.dataset.wssId = candidate;
  });
  scope.dataset.wssScope = 'true';
}

/** Assign paragraph-like text to the heading immediately before it. */
function sectionTexts(
  scope: HTMLElement,
  headings: HeadingNode[],
  measure: Measure,
): number[] {
  if (headings.length === 0) return [];
  const totals = new Array<number>(headings.length).fill(0);
  const isBefore = (headingEl: HTMLElement, block: Element): boolean => {
    const position = headingEl.compareDocumentPosition(block);
    return (position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  };
  for (const block of scope.querySelectorAll<HTMLElement>(SECTION_BLOCK_SELECTOR)) {
    if (block.closest(SITE_CHROME_SELECTOR)) continue;
    if (block.parentElement?.closest(SECTION_BLOCK_SELECTOR)) continue;
    let section = 0;
    let low = 0;
    let high = headings.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (isBefore(headings[mid].element, block)) {
        section = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    const length = measure(block);
    if (Number.isFinite(length)) totals[section] += length;
  }
  return totals;
}

/**
 * Remove headings that own no content, while retaining their ancestors so
 * the surviving subtree keeps its original hierarchy.
 */
function selectSectionHeadings(raw: HeadingNode[], lengths: number[]): HeadingNode[] {
  linkParents(raw);
  const meaningful = raw
    .map((_, index) => index)
    .filter((index) => (lengths[index] ?? 0) >= MIN_SECTION_TEXT);

  const selected = new Set<number>(meaningful);

  for (const index of [...selected]) {
    for (let parent = raw[index]?.parentIndex ?? -1; parent >= 0; parent = raw[parent].parentIndex) {
      selected.add(parent);
    }
  }

  if (selected.size < 2) return raw;
  return raw.filter((_, index) => selected.has(index));
}

/** Page-level gate for article-like long-form content. */
function decideArticle(stats: HeadingStats, semanticScope: boolean): boolean {
  if (stats.headingCount < 2) return false;
  if (stats.scopeText < 400) return false;
  // A card on a list page owns only a small share of page headings.
  if (stats.headingShare < 0.25 && stats.bodyText >= 800) return false;

  // Navigation, marketing, and search results are mostly links.
  if (stats.linkRatio > 0.55) return false;
  if (stats.paragraphRatio < 0.4) return false;

  // Body-level fallbacks need column evidence to reject multi-column pages.
  if (!semanticScope && !stats.columnAligned) return false;

  // A long section is sufficient on its own.
  if (stats.longestSection >= 500) return true;
  // Short pages still need hierarchy and enough section depth.
  return stats.hasHierarchy && stats.headingCount >= 3 && stats.longestSection >= 280;
}

/** Compute structural ratios used by the article gate. */
function computeRatios(scope: HTMLElement, measure: Measure): {
  linkRatio: number;
  paragraphRatio: number;
  paragraphText: number;
} {
  const total = Math.max(1, measure(scope));
  let linkText = 0;
  for (const anchor of scope.querySelectorAll('a')) linkText += measure(anchor);
  let paragraphText = 0;
  for (const block of scope.querySelectorAll(CONTENT_BLOCK_SELECTOR)) {
    if (block.parentElement?.closest(CONTENT_BLOCK_SELECTOR)) continue;
    paragraphText += measure(block);
  }
  return {
    linkRatio: Math.min(1, linkText / total),
    paragraphRatio: Math.min(1, paragraphText / total),
    paragraphText,
  };
}

export interface HeadingGeometry {
  reliable: boolean;
  measurable: number;
  alignedRatio: number;
  overlapRatio: number;
}

interface MeasuredHeading {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Reject virtualized, hidden, overlapping, or multi-column heading sets.
 * A false negative is preferable to anchoring the wrong text.
 */
export function assessHeadingGeometry(
  headings: HeadingNode[],
  viewportWidth = window.innerWidth,
): HeadingGeometry {
  const boxes: MeasuredHeading[] = [];
  for (const node of headings) {
    try {
      const rect = node.element.getBoundingClientRect();
      const visibleLeft = Math.max(0, rect.left);
      const visibleRight = Math.min(viewportWidth, rect.right);
      if (
        !Number.isFinite(rect.left) ||
        !Number.isFinite(rect.right) ||
        !Number.isFinite(rect.top) ||
        !Number.isFinite(rect.bottom) ||
        rect.width < 24 ||
        rect.height < 8 ||
        visibleRight - visibleLeft < 24
      ) {
        continue;
      }
      boxes.push({
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
      });
    } catch {
      /* An unmeasurable heading cannot count as positive evidence. */
    }
  }

  if (boxes.length < 2 || boxes.length / Math.max(1, headings.length) < 0.8) {
    return {
      reliable: false,
      measurable: boxes.length,
      alignedRatio: 0,
      overlapRatio: 0,
    };
  }

  const lefts = boxes.map((box) => box.left).sort((a, b) => a - b);
  const medianLeft = lefts[Math.floor(lefts.length / 2)];
  const tolerance = Math.max(48, Math.min(72, viewportWidth * 0.06));
  const alignedRatio =
    boxes.filter((box) => Math.abs(box.left - medianLeft) <= tolerance).length / boxes.length;

  const ordered = [...boxes].sort((a, b) => a.top - b.top || a.left - b.left);
  let overlaps = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    const overlap = Math.min(previous.bottom, current.bottom) - Math.max(previous.top, current.top);
    const shortest = Math.min(previous.bottom - previous.top, current.bottom - current.top);
    if (overlap > shortest * 0.7) overlaps += 1;
  }
  const overlapRatio = overlaps / Math.max(1, ordered.length - 1);

  return {
    reliable: alignedRatio >= 0.7 && overlapRatio <= 0.15,
    measurable: boxes.length,
    alignedRatio,
    overlapRatio,
  };
}

/** Build the heading index, returning null when no trustworthy scope exists. */
export function buildHeadingIndex(): HeadingIndex | null {
  const body = document.body;
  if (!body) return null;

  const conversation = detectConversationSurface(document);
  const measure = createMeasure();
  const bodyText = measure(body);
  const bodyParagraphText = computeRatios(body, measure).paragraphText;

  // Count effective headings after removing empty site chrome.
  const countEffectiveHeadings = (scope: HTMLElement, scopeIsBodyish: boolean): number => {
    const raw = collectHeadings(scope, scopeIsBodyish);
    if (raw.length < 2) return raw.length;
    const lengths = sectionTexts(scope, raw, measure);
    return selectSectionHeadings(raw, lengths).length;
  };
  const bodyHeadingCount = countEffectiveHeadings(body, true);
  const attempts: Array<{ scope: HTMLElement; scopeIsBodyish: boolean; semantic: boolean }> = [];
  const picked = pickScope(collectScopeCandidates(measure));
  if (picked) attempts.push({ scope: picked.element, scopeIsBodyish: false, semantic: picked.semantic });
  attempts.push({ scope: body, scopeIsBodyish: true, semantic: false });

  for (const attempt of attempts) {
    const rawHeadings = collectHeadings(attempt.scope, attempt.scopeIsBodyish);
    if (rawHeadings.length < 2) continue;

    // Drop headings without section text; keep required ancestors.
    const sectionLengths = sectionTexts(attempt.scope, rawHeadings, measure);
    const headings = selectSectionHeadings(rawHeadings, sectionLengths);
    const selectedSet = new Set(headings);
    const kept = rawHeadings
      .map((node, index) => ({ node, text: sectionLengths[index] ?? 0 }))
      .filter((item) => selectedSet.has(item.node));
    if (headings.length < 2) continue;

    // Filtering changes array indexes, so rebuild parent links.
    linkParents(headings);
    const scopeText = measure(attempt.scope);
    const ratios = computeRatios(attempt.scope, measure);
    const longestSection =
      kept.length >= 2
        ? kept.reduce((max, item) => Math.max(max, item.text), 0)
        : sectionLengths.reduce((max, value) => Math.max(max, value), 0);
    const paragraphShare =
      bodyParagraphText > 0 ? Math.min(1, ratios.paragraphText / bodyParagraphText) : 1;
    const headingShare =
      attempt.scopeIsBodyish || bodyHeadingCount === 0
        ? 1
        : Math.min(1, headings.length / bodyHeadingCount);
    const geometry = assessHeadingGeometry(headings);
    const columnAligned = geometry.reliable && geometry.alignedRatio >= 0.7;
    const stats: HeadingStats = {
      headingCount: headings.length,
      scopeText,
      bodyText,
      scopeShare: bodyText > 0 ? Math.min(1, scopeText / bodyText) : 1,
      paragraphShare,
      headingShare,
      columnAligned,
      geometryReliable: geometry.reliable,
      longestSection,
      hasHierarchy: headings.some((node) => node.parentIndex !== -1),
      linkRatio: ratios.linkRatio,
      paragraphRatio: ratios.paragraphRatio,
    };
    const isReadingCandidate =
      !conversation.detected &&
      geometry.reliable &&
      decideArticle(stats, attempt.semantic);
    const diagnostics = [
      `h=${stats.headingCount}`,
      `text=${stats.scopeText}`,
      `share=${stats.scopeShare.toFixed(2)}`,
      `longest=${stats.longestSection}`,
      `link=${stats.linkRatio.toFixed(2)}`,
      `para=${stats.paragraphRatio.toFixed(2)}`,
      `pShare=${stats.paragraphShare.toFixed(2)}`,
      `hShare=${stats.headingShare.toFixed(2)}`,
      `col=${stats.columnAligned ? 1 : 0}`,
      `geo=${stats.geometryReliable ? 1 : 0}`,
      `meas=${geometry.measurable}/${headings.length}`,
      `align=${geometry.alignedRatio.toFixed(2)}`,
      `overlap=${geometry.overlapRatio.toFixed(2)}`,
      `hier=${stats.hasHierarchy ? 1 : 0}`,
      `kept=${headings.length}/${rawHeadings.length}`,
      `sem=${attempt.semantic ? 1 : 0}`,
      `conv=${conversation.detected ? 1 : 0}`,
      `convReason=${conversation.reason}`,
      `convTurns=${conversation.turns}`,
      `reading=${isReadingCandidate ? 1 : 0}`,
    ].join(' ');
    if (isReadingCandidate) {
      ensureIds(headings, attempt.scope);
      // Expose metrics only for active article scopes used by field diagnostics.
      attempt.scope.dataset.wssStats = diagnostics;
    }
    return {
      scope: attempt.scope,
      headings,
      isReadingCandidate,
      isConversation: conversation.detected,
      conversationReason: conversation.reason,
      stats,
      diagnostics,
    };
  }

  return null;
}

/** Signature used to avoid rebuilding an unchanged heading tree. */
export function headingSignature(index: HeadingIndex): string {
  const parts = index.headings.map((node) => `${node.level}:${node.id}:${node.text}`);
  return [location.pathname, location.search, parts.join('|')].join('#');
}

/** Identical text can belong to replaced DOM nodes, so verify attachment. */
export function headingIndexStillAttached(index: HeadingIndex): boolean {
  if (!index.scope.isConnected) return false;
  return index.headings.every((node) => node.element.isConnected);
}
