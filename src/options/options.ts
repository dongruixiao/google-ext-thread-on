import {
  DEFAULT_SETTINGS,
  loadSettings,
  normalizeHost,
  normalizeSettings,
  saveSettings,
  type Appearance,
  type BarWidth,
  type DisplayPolicy,
  type PageTocMode,
  type PathMode,
  type PillPosition,
  type SiteAccess,
  type ThemeMode,
  type WssSettings,
} from '../shared/settings';

function getElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`options 元素缺失: ${selector}`);
  return element;
}

const enabledInput = getElement<HTMLInputElement>('#enabled');
const appearanceSelect = getElement<HTMLSelectElement>('#appearance');
const barWidthSelect = getElement<HTMLSelectElement>('#barWidth');
const positionSelect = getElement<HTMLSelectElement>('#position');
const themeSelect = getElement<HTMLSelectElement>('#theme');
const offsetInput = getElement<HTMLInputElement>('#offsetY');
const policySelect = getElement<HTMLSelectElement>('#displayPolicy');
const hideTitleInput = getElement<HTMLInputElement>('#hideArticleTitle');
const maxCrumbsSelect = getElement<HTMLSelectElement>('#maxCrumbs');
const tocModeSelect = getElement<HTMLSelectElement>('#pageTocMode');
const pathModeSelect = getElement<HTMLSelectElement>('#pathMode');
const siteAccessSelect = getElement<HTMLSelectElement>('#siteAccess');
const sitesTextarea = getElement<HTMLTextAreaElement>('#sites');
const siteInput = getElement<HTMLInputElement>('#siteInput');
const addSiteButton = getElement<HTMLButtonElement>('#addSite');
const addCurrentSiteButton = getElement<HTMLButtonElement>('#addCurrentSite');
const dataTextarea = getElement<HTMLTextAreaElement>('#data');
const exportButton = getElement<HTMLButtonElement>('#exportData');
const importButton = getElement<HTMLButtonElement>('#importData');
const resetButton = getElement<HTMLButtonElement>('#reset');
const toast = getElement<HTMLDivElement>('#toast');

let settings: WssSettings = { ...DEFAULT_SETTINGS };
let toastTimer = 0;

function notify(message: string): void {
  toast.textContent = message;
  toast.classList.add('show');
  if (toastTimer !== 0) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastTimer = 0;
    toast.classList.remove('show');
  }, 1400);
}

function render(): void {
  enabledInput.checked = settings.enabled;
  appearanceSelect.value = settings.appearance;
  barWidthSelect.value = settings.barWidth;
  positionSelect.value = settings.position;
  themeSelect.value = settings.theme;
  offsetInput.value = String(settings.offsetY);
  policySelect.value = settings.displayPolicy;
  hideTitleInput.checked = settings.hideArticleTitle;
  maxCrumbsSelect.value = String(settings.maxCrumbs);
  tocModeSelect.value = settings.pageTocMode;
  pathModeSelect.value = settings.pathMode;
  siteAccessSelect.value = settings.siteAccess;
  sitesTextarea.value = settings.sites.join('\n');
}

function collect(): WssSettings {
  const sites = sitesTextarea.value
    .split('\n')
    .map((line) => normalizeHost(line))
    .filter(Boolean);
  return normalizeSettings({
    ...settings,
    enabled: enabledInput.checked,
    appearance: appearanceSelect.value as Appearance,
    barWidth: barWidthSelect.value as BarWidth,
    position: positionSelect.value as PillPosition,
    theme: themeSelect.value as ThemeMode,
    offsetY: Number.parseInt(offsetInput.value, 10),
    displayPolicy: policySelect.value as DisplayPolicy,
    hideArticleTitle: hideTitleInput.checked,
    maxCrumbs: Number.parseInt(maxCrumbsSelect.value, 10),
    pageTocMode: tocModeSelect.value as PageTocMode,
    pathMode: pathModeSelect.value as PathMode,
    siteAccess: siteAccessSelect.value as SiteAccess,
    sites,
  });
}

function commit(message = '已保存'): void {
  settings = collect();
  render();
  void saveSettings(settings);
  notify(message);
}

async function activeTabHost(): Promise<string | null> {
  const queries: chrome.tabs.QueryInfo[] = [
    { active: true, lastFocusedWindow: true },
    { active: true, currentWindow: true },
  ];
  for (const query of queries) {
    try {
      const [tab] = await chrome.tabs.query(query);
      if (tab?.id == null) continue;
      const status = (await chrome.tabs.sendMessage(tab.id, { type: 'wss:status' })) as
        | { host?: string }
        | null;
      if (status?.host) return status.host;
    } catch {
      /* 换下一个查询条件 */
    }
  }
  return null;
}

function addSite(host: string): void {
  const normalized = normalizeHost(host);
  if (!normalized) return;
  const lines = new Set(
    sitesTextarea.value
      .split('\n')
      .map((line) => normalizeHost(line))
      .filter(Boolean),
  );
  lines.add(normalized);
  sitesTextarea.value = [...lines].join('\n');
  commit(`已添加 ${normalized}`);
}

async function main(): Promise<void> {
  settings = await loadSettings();
  render();

  for (const element of [
    enabledInput,
    appearanceSelect,
    barWidthSelect,
    positionSelect,
    themeSelect,
    policySelect,
    hideTitleInput,
    maxCrumbsSelect,
    tocModeSelect,
    pathModeSelect,
    siteAccessSelect,
  ]) {
    element.addEventListener('change', () => commit());
  }
  offsetInput.addEventListener('change', () => commit());
  sitesTextarea.addEventListener('change', () => commit());

  addSiteButton.addEventListener('click', () => {
    addSite(siteInput.value);
    siteInput.value = '';
  });

  addCurrentSiteButton.addEventListener('click', async () => {
    const host = await activeTabHost();
    if (!host) {
      notify('当前标签页无法读取域名');
      return;
    }
    addSite(host);
  });

  exportButton.addEventListener('click', () => {
    dataTextarea.value = JSON.stringify(collect(), null, 2);
    settings = collect();
    void saveSettings(settings);
    notify('已导出到文本框');
  });

  importButton.addEventListener('click', () => {
    try {
      const parsed = JSON.parse(dataTextarea.value) as unknown;
      settings = normalizeSettings(parsed);
      render();
      void saveSettings(settings);
      notify('已导入设置');
    } catch {
      notify('JSON 解析失败');
    }
  });

  resetButton.addEventListener('click', () => {
    settings = normalizeSettings(DEFAULT_SETTINGS);
    render();
    void saveSettings(settings);
    notify('已恢复默认');
  });
}

void main();
