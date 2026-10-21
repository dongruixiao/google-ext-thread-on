import { isPositionedWithin } from './chrome-detect';

export type ConversationReason =
  | 'none'
  | 'explicit-message-roles'
  | 'semantic-turn-elements'
  | 'aria-transcript'
  | 'repeated-turn-containers';

export interface ConversationSurface {
  detected: boolean;
  reason: ConversationReason;
  composer: boolean;
  turns: number;
}

const COMPOSER_SELECTOR = [
  'textarea',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '[role="textbox"]',
].join(',');

const EXPLICIT_TURN_SELECTOR = [
  '[data-message-author-role]',
  '[data-role="user"]',
  '[data-role="assistant"]',
  '[data-role="model"]',
].join(',');

const SEMANTIC_TRANSCRIPT_SELECTOR = '[role="log"], [role="feed"]';

/**
 * 通用的对话/代理组件命名。按元素语义判断，不按站点域名判断。
 * 这些标签名描述的是“消息轮次”，而不是某个具体产品。
 */
const SEMANTIC_TURN_SELECTOR = [
  'user-query',
  'model-response',
  'prompt-response',
  'chat-turn',
  'message-turn',
  'conversation-turn',
].join(',');

const REPEATED_TURN_SELECTOR = 'article, [role="article"]';
const MIN_TURN_TEXT = 40;

function visible(element: HTMLElement): boolean {
  try {
    if (element.getClientRects().length === 0) return false;
    const style = getComputedStyle(element);
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      (style.opacity === '' || Number(style.opacity) > 0.05)
    );
  } catch {
    return false;
  }
}

function textLength(element: Element): number {
  return (element.textContent ?? '').replace(/\s+/g, '').length;
}

function hasConversationComposer(root: ParentNode): boolean {
  const viewportWidth = window.innerWidth || 1;
  const viewportHeight = window.innerHeight || 1;
  const minWidth = Math.min(280, viewportWidth * 0.45);

  for (const element of root.querySelectorAll<HTMLElement>(COMPOSER_SELECTOR)) {
    if (!visible(element)) continue;
    if (element.getAttribute('aria-disabled') === 'true') continue;
    if (element.closest('[role="dialog"], [role="search"], [role="searchbox"], form[role="search"]')) {
      continue;
    }
    if (
      element instanceof HTMLTextAreaElement &&
      (element.disabled || element.readOnly)
    ) {
      continue;
    }

    const rect = element.getBoundingClientRect();
    if (
      !Number.isFinite(rect.width) ||
      !Number.isFinite(rect.height) ||
      rect.width < minWidth ||
      rect.height < 20
    ) {
      continue;
    }
    const positioned = isPositionedWithin(element, 8);
    const nearBottom = rect.top + rect.height >= viewportHeight * 0.65;
    if (positioned || nearBottom) return true;
  }
  return false;
}

function explicitTurnCount(root: ParentNode): { count: number; distinctRoles: number } {
  let count = 0;
  const roles = new Set<string>();
  for (const element of root.querySelectorAll<HTMLElement>(EXPLICIT_TURN_SELECTOR)) {
    if (!visible(element)) continue;
    count += 1;
    const role =
      element.dataset.messageAuthorRole ??
      element.getAttribute('data-role') ??
      '';
    if (role) roles.add(role);
  }
  return { count, distinctRoles: roles.size };
}

function semanticTurnCount(root: ParentNode): number {
  let count = 0;
  for (const element of root.querySelectorAll<HTMLElement>(SEMANTIC_TURN_SELECTOR)) {
    if (visible(element) && textLength(element) >= 12) count += 1;
  }
  return count;
}

function ariaTranscriptCount(root: ParentNode): number {
  for (const transcript of root.querySelectorAll<HTMLElement>(SEMANTIC_TRANSCRIPT_SELECTOR)) {
    if (!visible(transcript) || textLength(transcript) < MIN_TURN_TEXT) continue;
    const turns = transcript.querySelectorAll(REPEATED_TURN_SELECTOR).length;
    if (turns >= 2 || transcript.children.length >= 2) return turns || transcript.children.length;
  }
  return 0;
}

/** 同一父级下至少两段有实质文字的消息容器，避免把单篇文章误认为对话 */
function repeatedTurnCount(root: ParentNode): number {
  const groups = new Map<Element, Element[]>();
  for (const element of root.querySelectorAll<HTMLElement>(REPEATED_TURN_SELECTOR)) {
    if (!visible(element) || textLength(element) < MIN_TURN_TEXT) continue;
    const parent = element.parentElement;
    if (!parent) continue;
    const group = groups.get(parent) ?? [];
    group.push(element);
    groups.set(parent, group);
  }
  for (const group of groups.values()) {
    if (group.length >= 2) return group.length;
  }
  return 0;
}

/**
 * 判断当前页面是否是一个持续对话 / 代理工作区。
 *
 * 必须同时看到底部或固定输入区，以及明确的多轮消息结构。
 * 普通文章底部的评论框、固定搜索框、单条 AI 摘要卡片都不会满足这个组合。
 */
export function detectConversationSurface(root: ParentNode = document): ConversationSurface {
  if (!hasConversationComposer(root)) {
    return { detected: false, reason: 'none', composer: false, turns: 0 };
  }

  const explicit = explicitTurnCount(root);
  if (explicit.count >= 2 && explicit.distinctRoles >= 2) {
    return {
      detected: true,
      reason: 'explicit-message-roles',
      composer: true,
      turns: explicit.count,
    };
  }

  const semanticTurns = semanticTurnCount(root);
  if (semanticTurns >= 2) {
    return {
      detected: true,
      reason: 'semantic-turn-elements',
      composer: true,
      turns: semanticTurns,
    };
  }

  const ariaTurns = ariaTranscriptCount(root);
  if (ariaTurns >= 2) {
    return {
      detected: true,
      reason: 'aria-transcript',
      composer: true,
      turns: ariaTurns,
    };
  }

  const repeatedTurns = repeatedTurnCount(root);
  if (repeatedTurns >= 2) {
    return {
      detected: true,
      reason: 'repeated-turn-containers',
      composer: true,
      turns: repeatedTurns,
    };
  }

  return { detected: false, reason: 'none', composer: true, turns: 0 };
}
