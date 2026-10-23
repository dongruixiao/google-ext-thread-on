import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
} from '../shared/settings';

/** Seed default settings only on the first install. */
chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.sync.get(SETTINGS_KEY).then((stored) => {
    if (stored?.[SETTINGS_KEY] !== undefined) return;
    return chrome.storage.sync.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  });
});
