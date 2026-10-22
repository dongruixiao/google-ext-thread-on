import {
  DEFAULT_SETTINGS,
  isSiteEnabled,
  loadSettings,
  saveSettings,
  toggleSite,
  type DisplayPolicy,
  type WssSettings,
} from '../shared/settings';

interface PageStatus {
  active: boolean;
  enabled: boolean;
  siteEnabled: boolean;
  host: string;
  headings: number;
  pageTocVisible: boolean;
  contentVersion?: string;
  currentSection: string | null;
  statusReason: string;
}

const POLICY_HINTS: Record<DisplayPolicy, string> = {
  smart: '向下滚动浮现，向上滚动让位',
  always: '始终显示，位置可自由拖动',
};

function getElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`popup 元素缺失: ${selector}`);
  return element;
}

const enabledInput = getElement<HTMLInputElement>('#enabled');
const policySelect = getElement<HTMLSelectElement>('#displayPolicy');
const policyHint = getElement<HTMLElement>('#policyHint');
const statusBox = getElement<HTMLDivElement>('#status');
const siteButton = getElement<HTMLButtonElement>('#site');
const optionsButton = getElement<HTMLButtonElement>('#options');
const versionLabel = getElement<HTMLElement>('#version');

let settings: WssSettings = { ...DEFAULT_SETTINGS };
let pageStatus: PageStatus | null = null;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function render(): void {
  enabledInput.checked = settings.enabled;
  policySelect.value = settings.displayPolicy;
  policyHint.textContent = POLICY_HINTS[settings.displayPolicy];
  policySelect.disabled = !settings.enabled;

  const host = pageStatus?.host;
  siteButton.disabled = !host;
  siteButton.textContent =
    host && !isSiteEnabled(settings, host) ? '在此站点启用' : '在此站点禁用';
}

function renderStatus(): void {
  const status = pageStatus;
  statusBox.dataset.stale = 'false';
  if (!status) {
    statusBox.textContent = '当前页面无法使用 TopClip。';
    return;
  }
  if (status.contentVersion !== chrome.runtime.getManifest().version) {
    statusBox.dataset.stale = 'true';
    statusBox.innerHTML = '<strong>刷新页面后生效</strong><br>TopClip 已更新。';
    return;
  }
  if (!status.enabled) {
    statusBox.textContent = 'TopClip 已关闭。';
    return;
  }
  if (!status.siteEnabled) {
    statusBox.innerHTML = `已在 <strong>${escapeHtml(status.host)}</strong> 上停用。`;
    return;
  }
  if (status.active) {
    const toc = status.pageTocVisible ? ' · 原站目录可见，已自动退让' : '';
    const current = status.currentSection
      ? `<br><span class="current">${escapeHtml(status.currentSection)}</span>`
      : '';
    statusBox.innerHTML = `正在提醒当前章节${toc}${current}`;
    return;
  }
  if (status.statusReason === 'conversation-surface') {
    statusBox.textContent = '当前是对话页面，TopClip 保持静默。';
    return;
  }
  if (status.headings > 0) {
    statusBox.textContent = '当前页面不是稳定的长文结构，TopClip 保持静默。';
    return;
  }
  statusBox.textContent = '当前页面没有可用章节标题。';
}

async function activeTabId(): Promise<number | null> {
  for (const query of [
    { active: true, lastFocusedWindow: true },
    { active: true, currentWindow: true },
    { active: true },
  ] satisfies chrome.tabs.QueryInfo[]) {
    try {
      const [tab] = await chrome.tabs.query(query);
      if (tab?.id != null) return tab.id;
    } catch {
      /* 尝试下一种窗口定位方式 */
    }
  }
  return null;
}

async function refreshStatus(): Promise<void> {
  const tabId = await activeTabId();
  if (tabId == null) {
    pageStatus = null;
  } else {
    try {
      pageStatus = (await chrome.tabs.sendMessage(tabId, { type: 'wss:status' })) as PageStatus;
    } catch {
      pageStatus = null;
    }
  }
  renderStatus();
  render();
}

function persist(): void {
  void saveSettings(settings);
}

async function main(): Promise<void> {
  versionLabel.textContent = `v${chrome.runtime.getManifest().version}`;
  settings = await loadSettings();
  render();
  await refreshStatus();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshStatus();
  });

  enabledInput.addEventListener('change', () => {
    settings = { ...settings, enabled: enabledInput.checked };
    render();
    persist();
  });

  policySelect.addEventListener('change', () => {
    settings = { ...settings, displayPolicy: policySelect.value as DisplayPolicy };
    render();
    persist();
  });

  siteButton.addEventListener('click', () => {
    const host = pageStatus?.host;
    if (!host) return;
    settings = toggleSite(settings, host);
    persist();
    void refreshStatus();
  });

  optionsButton.addEventListener('click', () => {
    void chrome.runtime.openOptionsPage();
    window.close();
  });
}

void main();
