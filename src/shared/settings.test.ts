import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  isSiteEnabled,
  matchSite,
  normalizeHost,
  normalizeSettings,
  toggleSite,
} from './settings';

describe('normalizeSettings', () => {
  it('空值回落到默认配置', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it('非法枚举与越界数值会被纠正', () => {
    const result = normalizeSettings({
      enabled: 'yes',
      position: 'bottom-left',
      theme: 'sepia',
      displayPolicy: 'chaos',
      appearance: 'floating',
      barWidth: 'huge',
      offsetY: 9999,
      maxCrumbs: 42,
      siteAccess: 'nope',
      sites: ['Example.com', 'https://news.example.com/path', 42, 'localhost'],
      floatingPositions: {
        'https://Example.com/path': { x: 72.34, y: -4 },
        bad: { x: 'nope', y: 20 },
      },
    });
    expect(result.position).toBe(DEFAULT_SETTINGS.position);
    expect(result.theme).toBe(DEFAULT_SETTINGS.theme);
    expect(result.displayPolicy).toBe(DEFAULT_SETTINGS.displayPolicy);
    expect(result.appearance).toBe('bar');
    expect(result.barWidth).toBe('full');
    expect(result.enabled).toBe(true);
    expect(result.offsetY).toBe(400);
    expect(result.maxCrumbs).toBe(6);
    expect(result.siteAccess).toBe('all');
    expect(result.sites).toEqual(['example.com', 'news.example.com', 'localhost']);
    expect(result.floatingPositions).toEqual({ 'example.com': { x: 72.3, y: 0 } });
  });

  it('v1 配置可以无损升级到 v2', () => {
    const legacy = { enabled: false, position: 'top-right', theme: 'dark', offsetY: 12 };
    const result = normalizeSettings(legacy);
    expect(result.version).toBe(SETTINGS_VERSION);
    expect(result.enabled).toBe(false);
    expect(result.position).toBe('top-right');
    expect(result.theme).toBe('dark');
    expect(result.offsetY).toBe(12);
    expect(result.hideArticleTitle).toBe(true);
    expect(result.maxCrumbs).toBe(3);
    expect(result.pageTocMode).toBe('adapt');
    expect(result.appearance).toBe('bar');
    expect(result.barWidth).toBe('full');
  });

  it('v2 配置升级到 v3 时保留用户已有选择', () => {
    const legacy = {
      version: 2,
      enabled: true,
      position: 'top-center',
      theme: 'auto',
      offsetY: 0,
      hideArticleTitle: false,
      maxCrumbs: 2,
      displayPolicy: 'peek',
      pageTocMode: 'full',
      siteAccess: 'blocklist',
      sites: ['example.com'],
    };
    const result = normalizeSettings(legacy);
    expect(result.version).toBe(SETTINGS_VERSION);
    expect(result.displayPolicy).toBe('peek');
    expect(result.pageTocMode).toBe('full');
    expect(result.hideArticleTitle).toBe(false);
    expect(result.maxCrumbs).toBe(2);
    expect(result.sites).toEqual(['example.com']);
    expect(result.appearance).toBe('bar');
  });
});

describe('站点规则', () => {
  it('normalizeHost 去掉协议、路径与端口', () => {
    expect(normalizeHost('https://Example.com:8443/post')).toBe('example.com');
    expect(normalizeHost('*.sub.example.com')).toBe('sub.example.com');
  });

  it('matchSite 支持子域名匹配', () => {
    const sites = ['example.com'];
    expect(matchSite(sites, 'example.com')).toBe('example.com');
    expect(matchSite(sites, 'blog.example.com')).toBe('example.com');
    expect(matchSite(sites, 'notexample.com')).toBeUndefined();
  });

  it('黑名单与白名单语义相反', () => {
    const blocked = normalizeSettings({ siteAccess: 'blocklist', sites: ['example.com'] });
    expect(isSiteEnabled(blocked, 'example.com')).toBe(false);
    expect(isSiteEnabled(blocked, 'other.com')).toBe(true);

    const allowList = normalizeSettings({ siteAccess: 'allowlist', sites: ['example.com'] });
    expect(isSiteEnabled(allowList, 'blog.example.com')).toBe(true);
    expect(isSiteEnabled(allowList, 'other.com')).toBe(false);
  });

  it('总开关关闭时任何站点都不生效', () => {
    const settings = normalizeSettings({ enabled: false });
    expect(isSiteEnabled(settings, 'example.com')).toBe(false);
  });

  it('toggleSite 在默认状态下首次禁用会切到黑名单', () => {
    const once = toggleSite(DEFAULT_SETTINGS, 'example.com');
    expect(once.siteAccess).toBe('blocklist');
    expect(once.sites).toEqual(['example.com']);

    const twice = toggleSite(once, 'blog.example.com');
    expect(twice.sites).toEqual([]);
    expect(isSiteEnabled(twice, 'example.com')).toBe(true);
  });
});
