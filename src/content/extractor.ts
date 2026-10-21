import { HOST_ID } from '../shared/constants';
import { detectConversationSurface, type ConversationReason } from './conversation';

export interface HeadingNode {
  /** 原生 id 或自动生成的占位 id */
  id: string;
  element: HTMLElement;
  /** 1 代表 h1，2 代表 h2，以此类推 */
  level: number;
  text: string;
  /** 距离文档顶部的绝对偏移量（文档坐标系，单位 px） */
  top: number;
  /** 父级标题在数组中的下标，-1 表示顶层 */
  parentIndex: number;
}

export interface HeadingStats {
  headingCount: number;
  scopeText: number;
  bodyText: number;
  /** 选中容器正文占全页的比例（用于排除“列表中一张卡片”） */
  scopeShare: number;
  /** 选中容器的段落文字占全页段落文字的比例：比总字数更能识别“卡片” */
  paragraphShare: number;
  /** 选中容器的有效标题占全页有效标题的比例 */
  headingShare: number;
  /** 标题是否基本排在同一列（营销首页往往多栏/居中混排） */
  columnAligned: boolean;
  /** 标题几何是否足以让我们安全地执行吸顶（无法确认时宁可不显示） */
  geometryReliable: boolean;
  /** 最长小节的正文长度（用于排除列表页/搜索页） */
  longestSection: number;
  /** 是否存在层级嵌套（h1 > h2 > h3） */
  hasHierarchy: boolean;
  /** 正文里落在链接中的文字比例：导航/营销/搜索页会非常高 */
  linkRatio: number;
  /** 段落类文字占正文的比例：长文很高，导航/卡片式页面很低 */
  paragraphRatio: number;
}

export interface HeadingIndex {
  scope: HTMLElement;
  headings: HeadingNode[];
  /** 智能阅读模式判定：只有“像文章/文档”的页面才自动激活 */
  isArticle: boolean;
  /** 持续对话 / 代理工作区：即使有过长标题也不展示 */
  isConversation: boolean;
  conversationReason: ConversationReason;
  stats: HeadingStats;
  /** 稳定的本地诊断快照，不依赖页面后续是否保留 data 属性 */
  diagnostics: string;
}

/** 优先级 1：语义化正文容器 */
const SEMANTIC_SELECTOR = 'article, main, [role="main"]';

/** 优先级 2：常见正文类名（越靠前越具体） */
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

/** 站点框架与噪音区域：其中的标题不应进入面包屑 */
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
 * 标题后面至少要有这么多字符，才算“这个标题确实带着内容”。
 * 不能用更长的篇幅门槛筛标题：README、法律条文和结尾总结常有
 * 只有几个字但完全合法的独立小节。段落水位等页面级指标仍负责区分列表页。
 */
const MIN_SECTION_TEXT = 4;

/**
 * 计算正文长度时必须跳过的标签：
 * 很多现代站点把整页数据塞在内联 <script> 里（Next.js / React 等），
 * 直接用 textContent 会把它们当成正文，导致判定完全失真。
 */
const SKIP_TEXT_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'TEMPLATE',
  'NOSCRIPT',
  'IFRAME',
  'CANVAS',
  'SVG',
]);

/** 一次索引过程内共享的文本度量（带缓存，避免同一子树被反复遍历） */
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

/** 清理标题文本：去掉零宽字符、折叠空白、去掉 Markdown 锚点残留的 # */
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

/**
 * 正文容器启发式识别：
 * 收集候选容器并按“标题数 + 文本量”打分，再往里细化到最像正文的那一层。
 */
interface ScopeCandidate {
  element: HTMLElement;
  headings: number;
  text: number;
  /** 段落类文本：衡量“真正的正文”有多少 */
  paragraphText: number;
  /** 是否来自语义标签（article / main）而不是类名启发式 */
  semantic: boolean;
  score: number;
}

/** 真正的正文块：用来判断“这个容器里是文章还是导航/表格/卡片” */
const CONTENT_BLOCK_SELECTOR = 'p, li, pre, blockquote';
/** 更宽的内容块：用来估算每个标题后面跟了多少东西 */
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
 * 选正文容器，然后往里细化：
 * 如果某个后代候选“几乎拿走了父容器的全部段落文字”，而且「每标题字数」明显更高
 * （说明父容器把导航/侧栏也算进来了），就换用这个后代。
 * 例：GitHub 仓库页的 main 里混了侧栏导航，真正的正文是里面的 .markdown-body。
 */
function pickScope(candidates: ScopeCandidate[]): ScopeCandidate | null {
  if (candidates.length === 0) return null;
  const best = candidates.reduce((top, item) => (item.score > top.score ? item : top));
  // 分数接近、且互相包含的候选里，先选最紧凑的一层（article 通常比 main 更贴近正文）
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
      // 段落覆盖度：父容器的“真正文”有多少落在这个后代里
      const coverage = chosen.paragraphText > 0 ? candidate.paragraphText / chosen.paragraphText : 0;
      if (coverage < 0.6) continue;
      // 每标题的正文量：父容器混进导航/文件列表时，这个值会明显偏低
      const density = candidate.paragraphText / Math.max(1, candidate.headings);
      const chosenDensity = chosen.paragraphText / Math.max(1, chosen.headings);
      if (density < chosenDensity * 1.4) continue;
      // 多个合格后代里取最紧凑的那一层
      if (!next || candidate.text < next.text) next = candidate;
    }
    if (!next) break;
    chosen = next;
  }
  return chosen;
}

/** 在指定作用域内抽取标题节点（过滤噪音区域、不可见节点与空标题） */
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
      top: 0,
      parentIndex: -1,
    });
  }
  return nodes;
}

/** 构建层级链：用栈把扁平的标题数组还原成树 */
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

/** 为缺少 id 的标题补上占位属性，便于调试与锚点定位 */
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

/**
 * 统计每个标题后面跟了多少正文（到下一个标题为止）。
 * 文本块归到它前面最近的一个标题，用于两件事：
 * 1. 判断这个标题是不是真的带内容（导航栏/侧栏/搜索结果标题往往只有几个字）；
 * 2. 计算“最长小节”，作为是否为长文的判据。
 */
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
 * 选出真正属于正文的标题。
 *
 * 普通小节仍需达到最小正文量；结尾小节允许更短，因为总结往往只有一两句话。
 * 一旦保留某个子标题，也要保留它在原始标题树里的祖先，否则层级会被压平，
 * 甚至让子标题错误地挂到别的小节下面。
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

/** 智能阅读模式：判断当前页面是否值得激活吸顶面包屑 */
function decideArticle(stats: HeadingStats, semanticScope: boolean): boolean {
  if (stats.headingCount < 2) return false;
  if (stats.scopeText < 400) return false;
  // 容器里的有效标题只占全页一小部分 → 很可能是列表页里的一张卡片。
  // 用标题占比而不是总字数：仓库页/文档站的侧栏、文件列表会把总字数撑得很大。
  if (stats.headingShare < 0.25 && stats.bodyText >= 800) return false;

  // 导航 / 营销首页 / 搜索结果：文字大多在链接里，段落很少
  if (stats.linkRatio > 0.55) return false;
  if (stats.paragraphRatio < 0.4) return false;

  // 兜底到 body 的页面（没有语义容器匹配）：要求标题基本排在同一列，排除多栏营销页
  if (!semanticScope && !stats.columnAligned) return false;

  // 存在超长小节 → 正文无疑
  if (stats.longestSection >= 500) return true;
  // 否则要求“有层级嵌套 + 小节水位够深”：用来排除搜索结果页 / 文章卡片列表
  return stats.hasHierarchy && stats.headingCount >= 3 && stats.longestSection >= 280;
}

/** 结构指标：链接文字占比与段落文字占比 */
function computeRatios(scope: HTMLElement, measure: Measure): {
  linkRatio: number;
  paragraphRatio: number;
  paragraphText: number;
} {
  const total = Math.max(1, measure(scope));
  let linkText = 0;
  for (const anchor of scope.querySelectorAll('a')) linkText += measure(anchor);
  let paragraphText = 0;
  for (const block of scope.querySelectorAll(CONTENT_BLOCK_SELECTOR)) paragraphText += measure(block);
  return {
    linkRatio: Math.min(1, linkText / total),
    paragraphRatio: Math.min(1, paragraphText / total),
    paragraphText,
  };
}

/**
 * 标题是否基本排在同一列。
 * 长文/文档的标题都在正文那一栏；营销首页的多栏网格、居中大标题会让它们散开。
 */
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
 * 标题几何可信度门禁。
 *
 * 只要无法确认“这些是正文里彼此独立、排在同一列的可读标题”，就不激活。
 * 个别标题落在屏幕横向之外、尺寸为零、或大量互相叠置时，通常意味着
 * 页面用了虚拟列表、隐藏副本、绝对定位装饰或多栏布局；这种页面宁可漏掉。
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
      /* 单个标题量不到就不把它算作可信证据 */
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

/** 扫描文档并构建标题层级索引；没有可用标题时返回 null */
export function buildHeadingIndex(): HeadingIndex | null {
  const body = document.body;
  if (!body) return null;

  const conversation = detectConversationSurface(document);
  const measure = createMeasure();
  const bodyText = measure(body);
  const bodyParagraphText = computeRatios(body, measure).paragraphText;

  // 全页“有效标题”数量：过滤掉侧栏/导航那种没有正文的标题之后再数
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

    // 丢掉“标题后面几乎没有正文”的项：侧栏导航、搜索结果标题、卡片列表标题都会长这样。
    // 文末短总结与必要父级是例外，见 selectSectionHeadings。
    const sectionLengths = sectionTexts(attempt.scope, rawHeadings, measure);
    const headings = selectSectionHeadings(rawHeadings, sectionLengths);
    const selectedSet = new Set(headings);
    const kept = rawHeadings
      .map((node, index) => ({ node, text: sectionLengths[index] ?? 0 }))
      .filter((item) => selectedSet.has(item.node));
    if (headings.length < 2) continue;

    // selectSectionHeadings 已经为原始树连过父级；过滤后的树需要重新计算相对索引。
    linkParents(headings);
    measureHeadings(headings);
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
    const isArticle =
      !conversation.detected && geometry.reliable && decideArticle(stats, attempt.semantic);
    if (isArticle) ensureIds(headings, attempt.scope);
    // 判定依据挂在 DOM 上，便于排查“为什么这个页面激活/没激活”
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
      `art=${isArticle ? 1 : 0}`,
    ].join(' ');
    attempt.scope.dataset.wssStats = diagnostics;
    return {
      scope: attempt.scope,
      headings,
      isArticle,
      isConversation: conversation.detected,
      conversationReason: conversation.reason,
      stats,
      diagnostics,
    };
  }

  return null;
}

/** 批量测量标题的绝对偏移量（文档坐标系） */
export function measureHeadings(headings: HeadingNode[]): void {
  const scrollY = window.scrollY || document.documentElement.scrollTop || 0;
  for (const heading of headings) {
    heading.top = heading.element.getBoundingClientRect().top + scrollY;
  }
}

/** 索引指纹：用于 MutationObserver 触发后判断结构是否真的变化 */
export function headingSignature(index: HeadingIndex): string {
  const parts = index.headings.map((node) => `${node.level}:${node.id}:${node.text}`);
  return [location.pathname, location.search, parts.join('|')].join('#');
}

/**
 * 结构指纹相同并不代表节点还有效：React/Vue 等站点可能用完全相同的标题
 * 重建 DOM。此时旧索引里的 element 已脱离文档，必须重新建立索引。
 */
export function headingIndexStillAttached(index: HeadingIndex): boolean {
  if (!index.scope.isConnected) return false;
  return index.headings.every((node) => node.element.isConnected);
}
