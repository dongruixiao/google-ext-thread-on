/** 显示策略：smart 智能浮现 / always 常驻 */
export type DisplayPolicy = 'smart' | 'always';

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
  /** 显示策略 */
  displayPolicy: DisplayPolicy;
  /** 用户主动停用 TopClip 的站点 */
  disabledSites: string[];
  /** 按站点保存的拟物胶囊位置 */
  floatingPositions: Record<string, FloatingPosition>;
}

export const SETTINGS_VERSION = 6;
export const SETTINGS_KEY = 'wss:settings';

export const DEFAULT_SETTINGS: WssSettings = {
  version: SETTINGS_VERSION,
  enabled: true,
  displayPolicy: 'always',
  disabledSites: [],
  floatingPositions: {},
};

const POLICIES: readonly DisplayPolicy[] = ['smart', 'always'];
const LS_KEY = 'wss:settings:fallback';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** 域名归一化：去掉协议、路径、端口与前置的 *. */
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

/** 兼容旧版本并做全量校验。 */
export function normalizeSettings(raw: unknown): WssSettings {
  const input = (raw ?? {}) as Record<string, unknown>;
  const displayPolicy =
    input.displayPolicy === 'peek'
      ? 'smart'
      : pick(input.displayPolicy, POLICIES, DEFAULT_SETTINGS.displayPolicy);

  // v5 只支持黑名单式站点禁用；旧的白名单不做反向迁移，避免升级后整网失效。
  const disabledSites =
    input.disabledSites !== undefined
      ? normalizeSites(input.disabledSites)
      : input.siteAccess === 'blocklist'
        ? normalizeSites(input.sites)
        : [];

  return {
    version: SETTINGS_VERSION,
    enabled: typeof input.enabled === 'boolean' ? input.enabled : DEFAULT_SETTINGS.enabled,
    displayPolicy,
    disabledSites,
    floatingPositions: normalizeFloatingPositions(input.floatingPositions),
  };
}

/** 命中站点规则（支持 example.com 覆盖其子域），未命中返回 undefined */
export function matchSite(sites: string[], hostname: string): string | undefined {
  const host = normalizeHost(hostname);
  if (!host) return undefined;
  return sites.find((entry) => host === entry || host.endsWith(`.${entry}`));
}

export function isSiteEnabled(settings: WssSettings, hostname: string): boolean {
  if (!settings.enabled) return false;
  return matchSite(settings.disabledSites, hostname) === undefined;
}

/** 在当前站点上切换启用状态。 */
export function toggleSite(settings: WssSettings, hostname: string): WssSettings {
  const host = normalizeHost(hostname);
  if (!host) return settings;
  const matched = matchSite(settings.disabledSites, host);
  const disabledSites = matched
    ? settings.disabledSites.filter((entry) => entry !== matched)
    : [...settings.disabledSites, host];
  return { ...settings, disabledSites };
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
