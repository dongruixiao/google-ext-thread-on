export type PillPosition = 'top-center' | 'top-right';
export type ThemeMode = 'auto' | 'light' | 'dark';
/** 显示策略：smart 智能浮现 / always 常驻 */
export type DisplayPolicy = 'smart' | 'always';
/** 原站已有可见目录时的行为：adapt 退让为极简指示器 / full 保持完整功能 */
export type PageTocMode = 'adapt' | 'full';
export type SiteAccess = 'all' | 'blocklist' | 'allowlist';
export interface FloatingPosition {
  /** 可移动区域内相对横坐标，0..100 */
  x: number;
  /** 可移动区域内相对纵坐标，0..100 */
  y: number;
}

export interface WssSettings {
  version: number;
  /** 总开关：关闭后不再注入任何 UI */
  enabled: boolean;
  /** 胶囊悬浮位置 */
  position: PillPosition;
  /** 外观主题 */
  theme: ThemeMode;
  /** 垂直微调：在自动避让固定导航栏的基础上再下移若干像素 */
  offsetY: number;
  /** 面包屑中不显示文章大标题（h1 根级） */
  hideArticleTitle: boolean;
  /** 面包屑最多显示几级（超出部分折叠为 …） */
  maxCrumbs: number;
  /** 显示策略 */
  displayPolicy: DisplayPolicy;
  /** 原站目录适配策略 */
  pageTocMode: PageTocMode;
  /** 站点访问策略 */
  siteAccess: SiteAccess;
  /** 站点规则列表（黑名单 / 白名单） */
  sites: string[];
  /** 按站点保存的液态玻璃位置 */
  floatingPositions: Record<string, FloatingPosition>;
}

export const SETTINGS_VERSION = 5;
export const SETTINGS_KEY = 'wss:settings';

export const DEFAULT_SETTINGS: WssSettings = {
  version: SETTINGS_VERSION,
  enabled: true,
  position: 'top-center',
  theme: 'auto',
  offsetY: 0,
  hideArticleTitle: true,
  maxCrumbs: 3,
  displayPolicy: 'always',
  pageTocMode: 'adapt',
  siteAccess: 'all',
  sites: [],
  floatingPositions: {},
};

const POSITIONS: readonly PillPosition[] = ['top-center', 'top-right'];
const THEMES: readonly ThemeMode[] = ['auto', 'light', 'dark'];
const POLICIES: readonly DisplayPolicy[] = ['smart', 'always'];
const TOC_MODES: readonly PageTocMode[] = ['adapt', 'full'];
const SITE_ACCESS: readonly SiteAccess[] = ['all', 'blocklist', 'allowlist'];
const MIN_OFFSET = -20;
const MAX_OFFSET = 400;
const MIN_CRUMBS = 1;
const MAX_CRUMBS = 6;

const LS_KEY = 'wss:settings:fallback';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** 域名归一化：去掉协议/路径/端口与前置的 *. */
export function normalizeHost(input: string): string {
  let host = input.trim().toLowerCase();
  const schemeIndex = host.indexOf('://');
  if (schemeIndex >= 0) host = host.slice(schemeIndex + 3);
  const slashIndex = host.indexOf('/');
  if (slashIndex >= 0) host = host.slice(0, slashIndex);
  const colonIndex = host.lastIndexOf(':');
  if (colonIndex > 0 && host.indexOf(']') < colonIndex) host = host.slice(0, colonIndex);
  return host.replace(/^\*\./, '').replace(/\.$/, '');
}

function normalizeSites(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const result: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const host = normalizeHost(entry);
    // 允许 localhost 这类单标签主机（本地开发常用）
    if (!host || /\s/.test(host)) continue;
    if (!result.includes(host)) result.push(host);
  }
  return result.slice(0, 500);
}

function normalizeFloatingPositions(raw: unknown): Record<string, FloatingPosition> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: Record<string, FloatingPosition> = {};
  for (const [rawHost, rawPosition] of Object.entries(raw).slice(0, 100)) {
    const host = normalizeHost(rawHost);
    if (!host || /\s/.test(host)) continue;
    if (!rawPosition || typeof rawPosition !== 'object' || Array.isArray(rawPosition)) continue;
    const value = rawPosition as Partial<FloatingPosition>;
    if (
      typeof value.x !== 'number' ||
      typeof value.y !== 'number' ||
      !Number.isFinite(value.x) ||
      !Number.isFinite(value.y)
    ) {
      continue;
    }
    result[host] = {
      x: Math.round(clamp(value.x, 0, 100) * 10) / 10,
      y: Math.round(clamp(value.y, 0, 100) * 10) / 10,
    };
  }
  return result;
}

/** 兼容旧版本（v1 没有 version / 层级 / 站点字段）并做全量校验 */
export function normalizeSettings(raw: unknown): WssSettings {
  const input = (raw ?? {}) as Partial<Record<keyof WssSettings, unknown>>;
  const offsetY =
    typeof input.offsetY === 'number' && Number.isFinite(input.offsetY)
      ? clamp(input.offsetY, MIN_OFFSET, MAX_OFFSET)
      : DEFAULT_SETTINGS.offsetY;
  const maxCrumbs =
    typeof input.maxCrumbs === 'number' && Number.isFinite(input.maxCrumbs)
      ? clamp(Math.round(input.maxCrumbs), MIN_CRUMBS, MAX_CRUMBS)
      : DEFAULT_SETTINGS.maxCrumbs;

  const displayPolicy =
    input.displayPolicy === 'peek'
      ? 'smart'
      : pick(input.displayPolicy, POLICIES, DEFAULT_SETTINGS.displayPolicy);
  return {
    version: SETTINGS_VERSION,
    enabled: typeof input.enabled === 'boolean' ? input.enabled : DEFAULT_SETTINGS.enabled,
    position: pick(input.position, POSITIONS, DEFAULT_SETTINGS.position),
    theme: pick(input.theme, THEMES, DEFAULT_SETTINGS.theme),
    offsetY,
    hideArticleTitle:
      typeof input.hideArticleTitle === 'boolean'
        ? input.hideArticleTitle
        : DEFAULT_SETTINGS.hideArticleTitle,
    maxCrumbs,
    displayPolicy,
    pageTocMode: pick(input.pageTocMode, TOC_MODES, DEFAULT_SETTINGS.pageTocMode),
    siteAccess: pick(input.siteAccess, SITE_ACCESS, DEFAULT_SETTINGS.siteAccess),
    sites: normalizeSites(input.sites),
    floatingPositions: normalizeFloatingPositions(input.floatingPositions),
  };
}

// ── 站点规则 ──────────────────────────────────────────

/** 命中的站点规则（支持 example.com 覆盖其子域），未命中返回 undefined */
export function matchSite(sites: string[], hostname: string): string | undefined {
  const host = normalizeHost(hostname);
  if (!host) return undefined;
  return sites.find((entry) => host === entry || host.endsWith(`.${entry}`));
}

export function isSiteEnabled(settings: WssSettings, hostname: string): boolean {
  if (!settings.enabled) return false;
  const matched = matchSite(settings.sites, hostname);
  if (settings.siteAccess === 'blocklist') return matched === undefined;
  if (settings.siteAccess === 'allowlist') return matched !== undefined;
  return true;
}

/**
 * 在当前站点上切换启用状态：
 * 默认（全部站点）状态下第一次禁用会切换到黑名单模式。
 */
export function toggleSite(settings: WssSettings, hostname: string): WssSettings {
  const host = normalizeHost(hostname);
  if (!host) return settings;
  const sites = settings.sites;
  const access = settings.siteAccess;

  if (access === 'all') {
    return { ...settings, siteAccess: 'blocklist', sites: [...sites, host] };
  }
  const matched = matchSite(sites, host);
  if (access === 'blocklist') {
    const next = matched ? sites.filter((entry) => entry !== matched) : [...sites, host];
    return { ...settings, sites: next };
  }
  const next = matched ? sites.filter((entry) => entry !== matched) : [...sites, host];
  return { ...settings, sites: next };
}

// ── 读写 ─────────────────────────────────────────────

function hasChromeStorage(): boolean {
  return typeof chrome !== 'undefined' && !!chrome?.storage?.sync;
}

export async function loadSettings(): Promise<WssSettings> {
  if (!hasChromeStorage()) {
    try {
      const raw = window.localStorage.getItem(LS_KEY);
      return normalizeSettings(raw ? JSON.parse(raw) : undefined);
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }
  try {
    const stored = await chrome.storage.sync.get(SETTINGS_KEY);
    return normalizeSettings(stored?.[SETTINGS_KEY]);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(next: WssSettings): Promise<void> {
  const normalized = normalizeSettings(next);
  if (!hasChromeStorage()) {
    try {
      window.localStorage.setItem(LS_KEY, JSON.stringify(normalized));
    } catch {
      /* 忽略隐私模式下的写入失败 */
    }
    return;
  }
  try {
    await chrome.storage.sync.set({ [SETTINGS_KEY]: normalized });
  } catch {
    /* 忽略写入失败，使用默认值继续运行 */
  }
}

/**
 * 订阅设置变化。
 * - 扩展环境：chrome.storage.onChanged（popup / options / 其它标签页的改动都会触发）
 * - demo 环境：window storage 事件
 */
export function subscribeSettings(callback: (settings: WssSettings) => void): () => void {
  if (!hasChromeStorage()) {
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== LS_KEY) return;
      try {
        callback(normalizeSettings(event.newValue ? JSON.parse(event.newValue) : undefined));
      } catch {
        /* 忽略非法 JSON */
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }

  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== 'sync') return;
    const change = changes[SETTINGS_KEY];
    if (!change) return;
    callback(normalizeSettings(change.newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
