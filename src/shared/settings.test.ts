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

  it('只保留基础阅读设置并纠正非法值', () => {
    const result = normalizeSettings({
      enabled: 'yes',
      displayPolicy: 'chaos',
      disabledSites: ['Example.com', 'https://news.example.com/path', 42, 'localhost'],
      floatingPositions: {
        'https://Example.com/path': { x: 72.34, y: -4 },
        bad: { x: 'nope', y: 20 },
      },
    });
    expect(result.enabled).toBe(true);
    expect(result.displayPolicy).toBe(DEFAULT_SETTINGS.displayPolicy);
    expect(result.disabledSites).toEqual(['example.com', 'news.example.com', 'localhost']);
    expect(result.floatingPositions).toEqual({ 'example.com': { x: 72.3, y: 0 } });
  });

  it('旧配置可迁移，轻提示映射为智能，旧黑名单继续生效', () => {
    const legacy = {
      version: 5,
      enabled: true,
      displayPolicy: 'peek',
      pageTocMode: 'full',
      hideArticleTitle: false,
      maxCrumbs: 2,
      siteAccess: 'blocklist',
      sites: ['example.com'],
    };
    const result = normalizeSettings(legacy);
    expect(result.version).toBe(SETTINGS_VERSION);
    expect(result.displayPolicy).toBe('smart');
    expect(result.disabledSites).toEqual(['example.com']);
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

  it('只通过停用列表控制站点', () => {
    const blocked = normalizeSettings({ disabledSites: ['example.com'] });
    expect(isSiteEnabled(blocked, 'example.com')).toBe(false);
    expect(isSiteEnabled(blocked, 'other.com')).toBe(true);
  });

  it('总开关关闭时任何站点都不生效', () => {
    const settings = normalizeSettings({ enabled: false });
    expect(isSiteEnabled(settings, 'example.com')).toBe(false);
  });

  it('toggleSite 可停用并重新启用当前站点', () => {
    const once = toggleSite(DEFAULT_SETTINGS, 'example.com');
    expect(once.disabledSites).toEqual(['example.com']);

    const twice = toggleSite(once, 'blog.example.com');
    expect(twice.disabledSites).toEqual([]);
    expect(isSiteEnabled(twice, 'example.com')).toBe(true);
  });
});
