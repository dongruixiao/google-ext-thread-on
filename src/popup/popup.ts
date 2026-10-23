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
  smart: '阅读时浮现，回看让位',
  always: '始终显示，可自由拖动',
};

function getElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`popup 元素缺失: ${selector}`);
  return element;
}

const enabledInput = getElement<HTMLInputElement>('#enabled');
const policyHint = getElement<HTMLElement>('#policyHint');
const statusBox = getElement<HTMLDivElement>('#status');
const statusText = getElement<HTMLElement>('#statusText');
const siteButton = getElement<HTMLButtonElement>('#site');
const versionLabel = getElement<HTMLElement>('#version');
const policyInputs = [
  ...document.querySelectorAll<HTMLInputElement>('input[name="displayPolicy"]'),
];

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
  for (const input of policyInputs) {
    input.checked = input.value === settings.displayPolicy;
    input.disabled = !settings.enabled;
  }
  policyHint.textContent = POLICY_HINTS[settings.displayPolicy];

  const host = pageStatus?.host;
  siteButton.disabled = !host;
  siteButton.textContent =
    host && !isSiteEnabled(settings, host) ? '在此站点启用' : '在此站点禁用';
}

function renderStatus(): void {
  const status = pageStatus;
  statusBox.dataset.stale = 'false';
  statusBox.dataset.state = 'neutral';
  if (!status) {
    statusBox.dataset.state = 'attention';
    statusText.textContent = '当前页面无法使用 TopClip。';
    return;
  }
  if (status.contentVersion !== chrome.runtime.getManifest().version) {
    statusBox.dataset.stale = 'true';
    statusBox.dataset.state = 'attention';
    statusText.innerHTML = '<strong>刷新页面后生效</strong><br>TopClip 已更新。';
    return;
  }
  if (!status.enabled) {
    statusText.textContent = 'TopClip 已关闭。';
    return;
  }
  if (!status.siteEnabled) {
    statusText.innerHTML = `已在 <strong>${escapeHtml(status.host)}</strong> 上停用。`;
    return;
  }
  if (status.active) {
    statusBox.dataset.state = 'active';
    const toc = status.pageTocVisible ? ' · 原站目录可见，已自动退让' : '';
    const current = status.currentSection
      ? `<br><span class="current">${escapeHtml(status.currentSection)}</span>`
      : '';
    statusText.innerHTML = `正在提醒当前章节${toc}${current}`;
    return;
  }
  if (status.statusReason === 'conversation-surface') {
    statusText.textContent = '当前是对话页面，TopClip 保持静默。';
    return;
  }
  if (status.headings > 0) {
    statusText.textContent = '当前页面不是稳定的长文结构，TopClip 保持静默。';
    return;
  }
  statusText.textContent = '当前页面没有可用章节标题。';
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

  for (const input of policyInputs) {
    input.addEventListener('change', () => {
      if (!input.checked) return;
      settings = { ...settings, displayPolicy: input.value as DisplayPolicy };
      render();
      persist();
    });
  }

  siteButton.addEventListener('click', () => {
    const host = pageStatus?.host;
    if (!host) return;
    settings = toggleSite(settings, host);
    persist();
    void refreshStatus();
  });
}

void main();
