/** Smart mode yields on scroll-back; always mode remains visible. */
export type DisplayPolicy = 'smart' | 'always';

export interface FloatingPosition {
  /** Horizontal position in the movable viewport area, 0..100. */
  x: number;
  /** Vertical position in the movable viewport area, 0..100. */
  y: number;
}

export interface ThreadOnSettings {
  version: number;
  /** Global switch. No UI is mounted while disabled. */
  enabled: boolean;
  displayPolicy: DisplayPolicy;
  /** Hosts where the user explicitly disabled the extension. */
  disabledSites: string[];
  /** Per-host floating capsule positions. */
  floatingPositions: Record<string, FloatingPosition>;
}

export const SETTINGS_VERSION = 6;
export const SETTINGS_KEY = 'wss:settings';

export const DEFAULT_SETTINGS: ThreadOnSettings = {
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

/** Normalize a URL, hostname, or wildcard rule to a bare hostname. */
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

/** Migrate supported legacy fields and validate all persisted values. */
export function normalizeSettings(raw: unknown): ThreadOnSettings {
  const input = (raw ?? {}) as Record<string, unknown>;
  const displayPolicy =
    input.displayPolicy === 'peek'
      ? 'smart'
      : pick(input.displayPolicy, POLICIES, DEFAULT_SETTINGS.displayPolicy);

  // Allowlists are intentionally not inverted: doing so would silently disable
  // the extension on every unrelated host after an upgrade.
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

/** Rules match the exact host and its subdomains. */
export function matchSite(sites: string[], hostname: string): string | undefined {
  const host = normalizeHost(hostname);
  if (!host) return undefined;
  return sites.find((entry) => host === entry || host.endsWith(`.${entry}`));
}

export function isSiteEnabled(settings: ThreadOnSettings, hostname: string): boolean {
  if (!settings.enabled) return false;
  return matchSite(settings.disabledSites, hostname) === undefined;
}

export function toggleSite(
  settings: ThreadOnSettings,
  hostname: string,
): ThreadOnSettings {
  const host = normalizeHost(hostname);
  if (!host) return settings;
  const matched = matchSite(settings.disabledSites, host);
  const disabledSites = matched
    ? settings.disabledSites.filter(
        (entry) => host !== entry && !host.endsWith(`.${entry}`),
      )
    : [...settings.disabledSites, host];
  return { ...settings, disabledSites };
}

function hasChromeStorage(): boolean {
  return typeof chrome !== 'undefined' && !!chrome?.storage?.sync;
}

export async function loadSettings(): Promise<ThreadOnSettings> {
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

export async function saveSettings(next: ThreadOnSettings): Promise<void> {
  const normalized = normalizeSettings(next);
  if (!hasChromeStorage()) {
    try {
      window.localStorage.setItem(LS_KEY, JSON.stringify(normalized));
    } catch {
      /* Private-mode storage may be unavailable. */
    }
    return;
  }
  try {
    await chrome.storage.sync.set({ [SETTINGS_KEY]: normalized });
  } catch {
    /* Settings failures must not break page rendering. */
  }
}

export function subscribeSettings(
  callback: (settings: ThreadOnSettings) => void,
): () => void {
  if (!hasChromeStorage()) {
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== LS_KEY) return;
      try {
        callback(normalizeSettings(event.newValue ? JSON.parse(event.newValue) : undefined));
      } catch {
        /* Ignore malformed fallback storage. */
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
