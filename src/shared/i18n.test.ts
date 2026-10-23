import { afterEach, describe, expect, it, vi } from 'vitest';
import { localizeDocument, t } from './i18n';
import enCatalog from '../../_locales/en/messages.json';
import zhCnCatalog from '../../_locales/zh_CN/messages.json';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('i18n', () => {
  it('keeps locale catalogs in sync', () => {
    expect(Object.keys(zhCnCatalog).sort()).toEqual(Object.keys(enCatalog).sort());
  });

  it('falls back to the English catalog', () => {
    expect(t('brandName')).toBe('Thread On');
    expect(t('enableLabel')).toBe('Enable Thread On');
    expect(t('policyAlways')).toBe('Always');
  });

  it('uses the Chinese catalog from the Chrome UI language', () => {
    vi.stubGlobal('chrome', {
      i18n: {
        getUILanguage: () => 'zh-CN',
        getMessage: () => '',
      },
    });

    expect(t('policyAlways')).toBe('常驻');
    expect(t('enableLabel')).toBe('启用 Thread On');
    expect(t('siteDisabled', ['example.com'])).toBe('已在 example.com 上停用。');
  });

  it('localizes text and accessibility labels', () => {
    document.body.innerHTML = `
      <span data-i18n="policySmart">Smart</span>
      <button data-i18n-aria-label="outlineToggleAria"></button>
    `;

    localizeDocument(document);

    expect(document.querySelector('[data-i18n]')?.textContent).toBe('Smart');
    expect(
      document.querySelector('[data-i18n-aria-label]')?.getAttribute('aria-label'),
    ).toBe('Open or pin the article outline');
  });
});
