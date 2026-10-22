import {
  DEFAULT_SETTINGS,
  isSiteEnabled,
  loadSettings,
  matchSite,
  saveSettings,
  toggleSite,
  type DisplayPolicy,
  type Appearance,
  type WssSettings,
} from '../shared/settings';

interface PageStatus {
  active: boolean;
  enabled: boolean;
  siteEnabled: boolean;
  host: string;
  url: string;
  title: string;
  viewport: string;
  headings: number;
  scope: string | null;
  stats: string | null;
  statusReason: string;
  isArticle: boolean;
  geometryReliable: boolean;
  visualSafe: boolean;
  visualReason: string;
  pageTocVisible: boolean;
  dockTop: number;
  layerZIndex: number;
  contentVersion?: string;
  displayPolicy: DisplayPolicy;
  currentSection: string | null;
}

const POLICY_HINTS: Record<DisplayPolicy, string> = {
  smart: '向下滚动浮现，向上滚动让位',
  always: '始终停在页面顶部',
  peek: '仅在滚动时短暂出现',
};

const APPEARANCE_HINTS: Record<Appearance, string> = {
  bar: '无痕阅读：全宽页面渐隐，最自然',
  pill: '液态玻璃：紧凑胶囊，独立显示',
};

function getElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`popup 元素缺失: ${selector}`);
  return element;
}

const enabledInput = getElement<HTMLInputElement>('#enabled');
const appearanceSelect = getElement<HTMLSelectElement>('#appearance');
const appearanceHint = getElement<HTMLElement>('#appearanceHint');
const policySelect = getElement<HTMLSelectElement>('#displayPolicy');
const policyHint = getElement<HTMLElement>('#policyHint');
const statusBox = getElement<HTMLDivElement>('#status');
const siteButton = getElement<HTMLButtonElement>('#site');
const rescanButton = getElement<HTMLButtonElement>('#rescan');
const copyButton = getElement<HTMLButtonElement>('#copy');
const optionsButton = getElement<HTMLButtonElement>('#options');

let settings: WssSettings = { ...DEFAULT_SETTINGS };
let pageStatus: PageStatus | null = null;

function render(): void {
  enabledInput.checked = settings.enabled;
  appearanceSelect.value = settings.appearance;
  appearanceHint.textContent = APPEARANCE_HINTS[settings.appearance];
  policySelect.value = settings.displayPolicy;
  policyHint.textContent = POLICY_HINTS[settings.displayPolicy];
  policySelect.disabled = !settings.enabled;
  appearanceSelect.disabled = !settings.enabled;

  const host = pageStatus?.host;
  siteButton.disabled = !host;
  if (!host) {
    siteButton.textContent = '在此站点禁用';
  } else {
    siteButton.textContent = isSiteEnabled(settings, host) ? '在此站点禁用' : '在此站点启用';
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderStatus(): void {
  const status = pageStatus;
  statusBox.dataset.stale = 'false';
  if (!status) {
    statusBox.textContent = '当前页面无法注入内容脚本（如 Chrome 内置页、应用商店）。';
    return;
  }
  const currentVersion = chrome.runtime.getManifest().version;
  const staleContentScript = status.contentVersion !== currentVersion;
  statusBox.dataset.stale = String(staleContentScript);
  if (staleContentScript) {
    statusBox.innerHTML =
      `<strong>页面脚本需要刷新</strong><br>当前：v${escapeHtml(status.contentVersion ?? '未知')}，` +
      `扩展：v${escapeHtml(currentVersion)}。刷新网页后再测试。`;
    return;
  }
  if (!status.enabled) {
    statusBox.textContent = 'TopClip 已全局关闭。';
    return;
  }
  if (!status.siteEnabled) {
    statusBox.innerHTML = `已在 <strong>${escapeHtml(status.host)}</strong> 上禁用。`;
    return;
  }
  if (status.active) {
    const toc = status.pageTocVisible ? ' · 已识别原站目录，自动退让' : '';
    const current = status.currentSection
      ? `<br><span class="current">当前：${escapeHtml(status.currentSection)}</span>`
      : '';
    statusBox.innerHTML = `已激活 · 识别到 <strong>${status.headings}</strong> 个章节标题${toc}${current}`;
    return;
  }
  if (status.headings > 0) {
    const reason =
      status.statusReason === 'conversation-surface'
        ? '检测到持续对话与输入区，保持静默。'
        : status.statusReason === 'visual-unreliable'
          ? '页面背景或标题视觉无法安全融合，保持静默。'
        : status.statusReason === 'heading-geometry-unreliable'
          ? '标题布局无法可靠确认，保持静默。'
          : '未判定为可安全阅读的文章页（保持静默）。';
    statusBox.innerHTML = `识别到 <strong>${status.headings}</strong> 个标题，但${reason}`;
    return;
  }
  statusBox.textContent = '当前页面未发现可用标题，插件保持静默。';
}

async function activeTabId(): Promise<number | null> {
  // 弹窗环境下 currentWindow 不一定指向用户正在浏览的窗口，按可靠性依次尝试
  const queries: chrome.tabs.QueryInfo[] = [
    { active: true, lastFocusedWindow: true },
    { active: true, currentWindow: true },
    { active: true },
  ];
  for (const query of queries) {
    try {
      const [tab] = await chrome.tabs.query(query);
      if (tab?.id != null) return tab.id;
    } catch {
      /* 换下一个查询条件 */
    }
  }
  return null;
}

async function sendToActiveTab(message: unknown): Promise<PageStatus | null> {
  const tabId = await activeTabId();
  if (tabId == null) return null;
  try {
    return (await chrome.tabs.sendMessage(tabId, message)) as PageStatus | null;
  } catch {
    return null;
  }
}

async function refreshStatus(): Promise<void> {
  pageStatus = await sendToActiveTab({ type: 'wss:status' });
  renderStatus();
  render();
}

function persist(): void {
  void saveSettings(settings);
}

function diagnosticText(): string {
  const status = pageStatus;
  const manifest = chrome.runtime.getManifest();
  const lines = [
    `TopClip ${manifest.version}`,
    `generated=${new Date().toISOString()}`,
    status
      ? [
          `url=${status.url}`,
          `title=${status.title}`,
          `host=${status.host}`,
          `viewport=${status.viewport}`,
          `active=${status.active}`,
          `status=${status.statusReason}`,
          `headings=${status.headings}`,
          `scope=${status.scope ?? '-'}`,
          `isArticle=${status.isArticle}`,
          `geometryReliable=${status.geometryReliable}`,
          `visualSafe=${status.visualSafe}`,
          `visualReason=${status.visualReason}`,
          `pageTocVisible=${status.pageTocVisible}`,
          `dockTop=${status.dockTop}`,
          `layerZIndex=${status.layerZIndex}`,
          `contentVersion=${status.contentVersion ?? 'unknown'}`,
          `currentSection=${status.currentSection ?? '-'}`,
          `stats=${status.stats ?? '-'}`,
        ].join('\n')
      : 'contentScript=unavailable',
    `userAgent=${navigator.userAgent}`,
  ];
  return lines.join('\n');
}

async function copyDiagnostics(): Promise<void> {
  const text = diagnosticText();
  let copied = false;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    copied = document.execCommand('copy');
    area.remove();
  }
  copyButton.textContent = copied ? '已复制' : '复制失败';
  window.setTimeout(() => {
    copyButton.textContent = '复制诊断';
  }, 1400);
}

async function main(): Promise<void> {
  settings = await loadSettings();
  render();
  await refreshStatus();

  // 弹窗在后台被打开 / 重新获得焦点时补一次状态查询，避免读到空结果
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

  appearanceSelect.addEventListener('change', () => {
    settings = { ...settings, appearance: appearanceSelect.value as Appearance };
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

  rescanButton.addEventListener('click', () => {
    void refreshStatus().then(() => sendToActiveTab({ type: 'wss:rescan' }));
  });

  copyButton.addEventListener('click', () => {
    void copyDiagnostics();
  });

  optionsButton.addEventListener('click', () => {
    void chrome.runtime.openOptionsPage();
    window.close();
  });

  // 站点规则里如果命中了当前站点，界面上同步提示
  const matched = pageStatus?.host ? matchSite(settings.sites, pageStatus.host) : undefined;
  if (matched) siteButton.title = `规则：${matched}`;
}

void main();
