import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  loadSettings,
  normalizeSettings,
  saveSettings,
  toggleSite,
  type WssSettings,
} from '../shared/settings';
import { MESSAGE } from '../shared/protocol';

/** Seed default settings only on the first install. */
chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.sync.get(SETTINGS_KEY).then((stored) => {
    if (stored?.[SETTINGS_KEY] !== undefined) return;
    return chrome.storage.sync.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  });
});

/** Keep already-open content scripts in sync with settings changes. */
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return;
  const change = changes[SETTINGS_KEY];
  if (!change) return;
  void broadcast(normalizeSettings(change.newValue));
});

async function broadcast(settings: WssSettings): Promise<void> {
  let tabs: chrome.tabs.Tab[] = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id == null) return;
      try {
        await chrome.tabs.sendMessage(tab.id, { type: MESSAGE.settings, settings });
      } catch {
        // Built-in pages and tabs without a content script reject this message.
      }
    }),
  );
}

chrome.commands?.onCommand.addListener((command) => {
  void handleCommand(command);
});

async function handleCommand(command: string): Promise<void> {
  const settings = await loadSettings();
  if (command === 'toggle-global') {
    await saveSettings({ ...settings, enabled: !settings.enabled });
    return;
  }
  if (command === 'toggle-site') {
    const host = await activeTabHost();
    if (!host) return;
    await saveSettings(toggleSite(settings, host));
  }
}

/** Read the host through the content script to avoid requesting tabs permission. */
async function activeTabHost(): Promise<string | null> {
  let tabId: number | undefined;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tabId = tab?.id;
  } catch {
    return null;
  }
  if (tabId == null) return null;
  try {
    const status = (await chrome.tabs.sendMessage(tabId, { type: MESSAGE.status })) as
      | { host?: string }
      | null;
    return status?.host ?? null;
  } catch {
    return null;
  }
}
