import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  loadSettings,
  normalizeSettings,
  saveSettings,
  toggleSite,
  type WssSettings,
} from '../shared/settings';

/** 首次安装时写入默认设置 */
chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.sync.get(SETTINGS_KEY).then((stored) => {
    if (stored?.[SETTINGS_KEY] !== undefined) return;
    return chrome.storage.sync.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  });
});

/** 跨标签页状态管理：设置变化时广播给所有已注入内容脚本的标签页 */
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
        await chrome.tabs.sendMessage(tab.id, { type: 'wss:settings', settings });
      } catch {
        // 该标签页没有内容脚本（内置页 / 未注入），忽略
      }
    }),
  );
}

/** 快捷键：在没有界面的情况下也能快速开关 */
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

/** 通过内容脚本获取当前标签页域名（无需额外申请 tabs 权限） */
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
    const status = (await chrome.tabs.sendMessage(tabId, { type: 'wss:status' })) as
      | { host?: string }
      | null;
    return status?.host ?? null;
  } catch {
    return null;
  }
}
