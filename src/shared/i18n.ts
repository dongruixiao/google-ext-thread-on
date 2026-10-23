import enCatalog from '../../_locales/en/messages.json';
import zhCnCatalog from '../../_locales/zh_CN/messages.json';

type Catalog = Record<string, { message: string }>;
type Messages = Record<keyof typeof enCatalog, string>;

function flatten(catalog: Catalog): Messages {
  return Object.fromEntries(
    Object.entries(catalog).map(([key, value]) => [key, value.message]),
  ) as Messages;
}

const EN_MESSAGES = flatten(enCatalog);
const ZH_CN_MESSAGES = flatten(zhCnCatalog);

export type MessageKey = keyof typeof enCatalog;

function resolveLocale(): 'en' | 'zh_CN' {
  const language =
    typeof chrome !== 'undefined' && chrome.i18n?.getUILanguage
      ? chrome.i18n.getUILanguage()
      : navigator.language;
  return language.toLowerCase().startsWith('zh') ? 'zh_CN' : 'en';
}

export function t(key: MessageKey, substitutions: string[] = []): string {
  if (typeof chrome !== 'undefined' && chrome.i18n?.getMessage) {
    const localized = chrome.i18n.getMessage(key, substitutions);
    if (localized) return localized;
  }

  const locale = resolveLocale();
  const messages = locale === 'zh_CN' ? ZH_CN_MESSAGES : EN_MESSAGES;
  const values = [...substitutions];
  return messages[key].replace(/\$[A-Z0-9_]+\$/g, () => values.shift() ?? '');
}

export function localizeDocument(root: ParentNode = document): void {
  const locale = resolveLocale();
  document.documentElement.lang = locale === 'zh_CN' ? 'zh-CN' : 'en';

  for (const element of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = element.dataset.i18n as MessageKey | undefined;
    if (key) element.textContent = t(key);
  }
  for (const element of root.querySelectorAll<HTMLElement>('[data-i18n-aria-label]')) {
    const key = element.dataset.i18nAriaLabel as MessageKey | undefined;
    if (key) element.setAttribute('aria-label', t(key));
  }
}
