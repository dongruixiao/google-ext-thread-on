/**
 * 生成商店截图（1280×800，符合 Chrome 应用商店要求）：
 *   npm run screenshots
 *
 * 用 store/demo-page.html 这个中性文章页，配真正的打包产物（dist/）截图，
 * 保证截图里看到的就是用户装上后得到的东西。
 */
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

/** 通过设置页写 storage，等价于用户在设置里改 */
const applySettings = async (patch) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
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

// 1) 浅色：默认拟物胶囊 + 正文
await applySettings({
  theme: 'auto',
  displayPolicy: 'always',
  position: 'top-center',
  enabled: true,
  floatingPositions: {},
});
const light = await context.newPage();
await light.goto(url, { waitUntil: 'load' });
await light.mouse.move(640, 400);
await light.waitForTimeout(1200);
await shoot(light, '01-sticky-heading.png', 1000);

// 2) 浅色：悬停展开目录
await shoot(light, '02-outline.png', 1500, { hover: true });
await light.close();

// 3) 深色站点：界面自动跟随页面配色
const dark = await context.newPage();
await dark.goto(`${url}?dark=1`, { waitUntil: 'load' });
await dark.mouse.move(640, 400);
await dark.waitForTimeout(1200);
  await shoot(dark, '03-dark-site.png', 1000);
await dark.close();

// 4) 自由拖动到文章右下角，目录自动向上展开
const pill = await context.newPage();
await pill.goto(url, { waitUntil: 'load' });
await pill.mouse.move(640, 400);
await pill.waitForTimeout(1200);
await pill.evaluate(() => window.scrollTo(0, 1100));
await pill.waitForTimeout(500);
const start = await pill.evaluate(() => {
  const rect = document
    .getElementById('__web_sticky_scroll_host__')
    .shadowRoot.querySelector('.wss-pill')
    .getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
});
await pill.mouse.move(start.x, start.y);
await pill.mouse.down();
await pill.mouse.move(960, 680, { steps: 12 });
await pill.mouse.up();
await pill.waitForTimeout(500);
await pill.mouse.move(960, 680);
await pill.waitForTimeout(500);
await pill.screenshot({ path: join(OUT_DIR, '04-draggable-pill.png') });
console.log('✓', '04-draggable-pill.png');
await pill.close();

// 恢复默认
await applySettings({ position: 'top-center', floatingPositions: {} });

await context.close();
server.close();
console.log(`\n截图已输出到 ${OUT_DIR}`);
