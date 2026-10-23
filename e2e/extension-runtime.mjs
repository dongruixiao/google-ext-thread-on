/**
 * Resolve an extension ID and isolated execution context without relying on a
 * background service worker. Content scripts expose chrome.runtime.id.
 */
export async function findExtensionRuntime(page, expectedId = null) {
  const cdp = await page.context().newCDPSession(page);
  const contexts = new Map();
  cdp.on('Runtime.executionContextCreated', (event) => {
    contexts.set(event.context.id, event.context);
  });
  await cdp.send('Runtime.enable');

  for (const contextInfo of contexts.values()) {
    const probe = await cdp.send('Runtime.evaluate', {
      expression: `typeof chrome !== 'undefined' &&
        chrome.runtime?.id &&
        (${expectedId === null ? 'true' : `chrome.runtime.id === ${JSON.stringify(expectedId)}`})`,
      contextId: contextInfo.id,
      returnByValue: true,
    });
    if (probe.result.value !== true) continue;

    const id = await cdp.send('Runtime.evaluate', {
      expression: 'chrome.runtime.id',
      contextId: contextInfo.id,
      returnByValue: true,
    });
    return {
      cdp,
      contextId: contextInfo.id,
      extensionId: id.result.value,
    };
  }

  await cdp.detach();
  return null;
}
