import {
  DEFAULT_SETTINGS,
  loadSettings,
  normalizeSettings,
  saveSettings,
  type DisplayPolicy,
  type WssSettings,
} from '../shared/settings';

function getElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`options 元素缺失: ${selector}`);
  return element;
}

const enabledInput = getElement<HTMLInputElement>('#enabled');
const policySelect = getElement<HTMLSelectElement>('#displayPolicy');
const resetButton = getElement<HTMLButtonElement>('#reset');
const versionLabel = getElement<HTMLElement>('#version');
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
  policySelect.value = settings.displayPolicy;
  policySelect.disabled = !settings.enabled;
}

function persist(): void {
  settings = normalizeSettings({
    ...settings,
    enabled: enabledInput.checked,
    displayPolicy: policySelect.value as DisplayPolicy,
  });
  render();
  void saveSettings(settings);
  notify('已保存');
}

async function main(): Promise<void> {
  versionLabel.textContent = `v${chrome.runtime.getManifest().version}`;
  settings = await loadSettings();
  render();

  enabledInput.addEventListener('change', persist);
  policySelect.addEventListener('change', persist);
  resetButton.addEventListener('click', () => {
    settings = normalizeSettings(DEFAULT_SETTINGS);
    render();
    void saveSettings(settings);
    notify('已恢复默认');
  });
}

void main();
