/** Generate 1280x800 Chrome Web Store screenshots from the packaged build. */
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const EXTENSION_DIR = join(ROOT, 'dist');
const OUT_DIR = join(ROOT, 'store', 'screenshots');
const PAGE = readFileSync(join(ROOT, 'store', 'demo-page.html'), 'utf8');

const server = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(PAGE);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'wss-shot-')), {
  ...(process.env.WSS_CHROME_PATH ? { executablePath: process.env.WSS_CHROME_PATH } : { channel: 'chromium' }),
  headless: true,
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
});

let worker = context.serviceWorkers()[0];
if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
const extensionId = new URL(worker.url()).host;

/** Write settings through an extension page, matching the popup flow. */
const applySettings = async (patch) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await page.evaluate(async (next) => {
    const current = (await chrome.storage.sync.get('wss:settings'))['wss:settings'] ?? {};
    await chrome.storage.sync.set({ 'wss:settings': { ...current, ...next } });
  }, patch);
  await page.close();
};

const shoot = async (page, file, scrollY, options = {}) => {
  await page.evaluate((y) => window.scrollTo(0, y), scrollY);
  await page.waitForTimeout(600);
  if (options.hover) {
    const point = await page.evaluate(() => {
      const rect = document
        .getElementById('__web_sticky_scroll_host__')
        .shadowRoot.querySelector('.wss-pill')
        .getBoundingClientRect();
      return { x: rect.left + Math.min(220, rect.width / 2), y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(point.x, point.y);
    await page.waitForTimeout(500);
  }
  await page.screenshot({ path: join(OUT_DIR, file) });
  console.log('✓', file);
};

mkdirSync(OUT_DIR, { recursive: true });

// Light theme: default capsule over article content.
await applySettings({
  displayPolicy: 'always',
  enabled: true,
  floatingPositions: {},
});
const light = await context.newPage();
await light.goto(url, { waitUntil: 'load' });
await light.mouse.move(640, 400);
await light.waitForTimeout(1200);
await shoot(light, '01-current-section.png', 1000);

// Light theme: expanded outline.
await shoot(light, '02-outline.png', 1500, { hover: true });
await light.close();

// Dark site: the capsule follows the system color scheme.
const dark = await context.newPage();
await dark.emulateMedia({ colorScheme: 'dark' });
await dark.goto(`${url}?dark=1`, { waitUntil: 'load' });
await dark.mouse.move(640, 400);
await dark.waitForTimeout(1200);
await shoot(dark, '03-dark-site.png', 1000);
await dark.close();

// Dragged capsule near the lower-right edge; the outline opens upward.
await applySettings({ floatingPositions: {} });
const capsule = await context.newPage();
await capsule.goto(url, { waitUntil: 'load' });
await capsule.mouse.move(640, 400);
await capsule.waitForTimeout(1200);
await capsule.evaluate(() => window.scrollTo(0, 1100));
await capsule.waitForTimeout(500);
const start = await capsule.evaluate(() => {
  const rect = document
    .getElementById('__web_sticky_scroll_host__')
    .shadowRoot.querySelector('.wss-pill')
    .getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
});
await capsule.mouse.move(start.x, start.y);
await capsule.mouse.down();
await capsule.mouse.move(960, 680, { steps: 12 });
await capsule.mouse.up();
await capsule.waitForTimeout(500);
const end = await capsule.evaluate(() => {
  const rect = document
    .getElementById('__web_sticky_scroll_host__')
    .shadowRoot.querySelector('.wss-pill')
    .getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
});
await capsule.mouse.move(20, 450);
await capsule.waitForTimeout(150);
await capsule.mouse.move(end.x, end.y);
await capsule.waitForTimeout(500);
await capsule.screenshot({ path: join(OUT_DIR, '04-draggable-capsule.png') });
console.log('✓', '04-draggable-capsule.png');
await capsule.close();

// Restore the default position.
await applySettings({ floatingPositions: {} });

await context.close();
server.close();
console.log(`\n截图已输出到 ${OUT_DIR}`);
