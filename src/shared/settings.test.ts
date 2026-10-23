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
  it('falls back to defaults for empty input', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it('normalizes supported settings and clamps invalid values', () => {
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

  it('migrates legacy peek and blocklist settings', () => {
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

describe('site rules', () => {
  it('normalizeHost removes protocol, path, and port', () => {
    expect(normalizeHost('https://Example.com:8443/post')).toBe('example.com');
    expect(normalizeHost('*.sub.example.com')).toBe('sub.example.com');
  });

  it('matchSite matches subdomains', () => {
    const sites = ['example.com'];
    expect(matchSite(sites, 'example.com')).toBe('example.com');
    expect(matchSite(sites, 'blog.example.com')).toBe('example.com');
    expect(matchSite(sites, 'notexample.com')).toBeUndefined();
  });

  it('uses the disabled-site list as the only access rule', () => {
    const blocked = normalizeSettings({ disabledSites: ['example.com'] });
    expect(isSiteEnabled(blocked, 'example.com')).toBe(false);
    expect(isSiteEnabled(blocked, 'other.com')).toBe(true);
  });

  it('global disable overrides every host', () => {
    const settings = normalizeSettings({ enabled: false });
    expect(isSiteEnabled(settings, 'example.com')).toBe(false);
  });

  it('toggleSite disables and re-enables a host', () => {
    const once = toggleSite(DEFAULT_SETTINGS, 'example.com');
    expect(once.disabledSites).toEqual(['example.com']);

    const twice = toggleSite(once, 'blog.example.com');
    expect(twice.disabledSites).toEqual([]);
    expect(isSiteEnabled(twice, 'example.com')).toBe(true);
  });

  it('removes every overlapping parent and child rule when enabling a host', () => {
    const settings = normalizeSettings({
      disabledSites: ['example.com', 'sub.example.com'],
    });
    const enabled = toggleSite(settings, 'sub.example.com');

    expect(enabled.disabledSites).toEqual([]);
    expect(isSiteEnabled(enabled, 'sub.example.com')).toBe(true);
  });
});
