import {
  DEFAULT_SETTINGS,
  isSiteEnabled,
  loadSettings,
  saveSettings,
  toggleSite,
  type DisplayPolicy,
  type WssSettings,
} from '../shared/settings';
import { localizeDocument, t, type MessageKey } from '../shared/i18n';
import { MESSAGE, type ContentStatus } from '../shared/protocol';

const POLICY_HINTS: Record<DisplayPolicy, MessageKey> = {
  smart: 'policySmartHint',
  always: 'policyAlwaysHint',
};

function getElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing popup element: ${selector}`);
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
let pageStatus: ContentStatus | null = null;

function renderStatusMessage(message: string, currentSection?: string | null): void {
  statusText.textContent = message;
  if (!currentSection) return;
  const current = document.createElement('span');
  current.className = 'current';
  current.textContent = currentSection;
  statusText.append(current);
}

function render(): void {
  enabledInput.checked = settings.enabled;
  for (const input of policyInputs) {
    input.checked = input.value === settings.displayPolicy;
    input.disabled = !settings.enabled;
  }
  policyHint.textContent = t(POLICY_HINTS[settings.displayPolicy]);

  const host = pageStatus?.host;
  siteButton.disabled = !host;
  siteButton.textContent =
    host && !isSiteEnabled(settings, host) ? t('enableSite') : t('disableSite');
}

function renderStatus(): void {
  const status = pageStatus;
  statusBox.dataset.stale = 'false';
  statusBox.dataset.state = 'neutral';
  if (!status) {
    statusBox.dataset.state = 'attention';
    renderStatusMessage(t('pageUnavailable'));
    return;
  }
  if (status.contentVersion !== chrome.runtime.getManifest().version) {
    statusBox.dataset.stale = 'true';
    statusBox.dataset.state = 'attention';
    renderStatusMessage(`${t('refreshToApply')} ${t('extensionUpdated')}`);
    return;
  }
  if (!status.enabled) {
    renderStatusMessage(t('disabledGlobally'));
    return;
  }
  if (!status.siteEnabled) {
    renderStatusMessage(t('siteDisabled', [status.host]));
    return;
  }
  if (status.active) {
    statusBox.dataset.state = 'active';
    const toc = status.pageTocVisible ? ` · ${t('originalTocVisible')}` : '';
    renderStatusMessage(`${t('remindingChapter')}${toc}`, status.currentSection);
    return;
  }
  if (status.statusReason === 'conversation-surface') {
    renderStatusMessage(t('conversationPage'));
    return;
  }
  if (status.headings > 0) {
    renderStatusMessage(t('unsupportedStructure'));
    return;
  }
  renderStatusMessage(t('noHeadings'));
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
      /* Try the next window query. */
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
      pageStatus = (await chrome.tabs.sendMessage(tabId, {
        type: MESSAGE.status,
      })) as ContentStatus;
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
  localizeDocument(document);
  document.title = t('popupTitle');
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
