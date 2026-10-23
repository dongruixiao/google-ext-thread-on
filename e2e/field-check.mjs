/**
 * Field check against real websites using the packaged extension.
 *
 *   npm run build
 *   WSS_CHROME_PATH=... npm run field-check
 *   WSS_CHROME_PATH=... npm run field-check https://...
 *
 * Reports injection, article scope, heading count, capsule state, native
 * contents coexistence, performance observations, and page errors.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = join(HERE, '..', 'dist');

/** Expected to activate: articles, documentation, encyclopedias, and READMEs. */
const DEFAULT_TARGETS = [
  { name: 'MDN docs', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_expressions', expect: 'active' },
  { name: 'Python docs', url: 'https://docs.python.org/3/tutorial/controlflow.html', expect: 'active' },
  { name: 'React docs', url: 'https://react.dev/learn/thinking-in-react', expect: 'active' },
  { name: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Web_browser', expect: 'active' },
  { name: 'GitHub README', url: 'https://github.com/vitejs/vite', expect: 'active' },
  { name: 'Vite docs', url: 'https://vite.dev/guide/', expect: 'active' },
  { name: 'web.dev article', url: 'https://web.dev/articles/rendering-performance', expect: 'active' },
  { name: 'TypeScript handbook', url: 'https://www.typescriptlang.org/docs/handbook/2/everyday-types.html', expect: 'active' },
  { name: 'Rust Book', url: 'https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html', expect: 'active' },
  { name: 'WHATWG HTML', url: 'https://html.spec.whatwg.org/multipage/dom.html', expect: 'active' },
  { name: 'W3C WCAG', url: 'https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html', expect: 'active' },
  { name: 'Martin Fowler', url: 'https://martinfowler.com/articles/microservices.html', expect: 'active' },
  // Long prose without headings has nothing to anchor.
  { name: 'Paul Graham essay', url: 'https://paulgraham.com/lisp.html', expect: 'silent', note: 'No section headings' },
  { name: 'ar5iv paper', url: 'https://ar5iv.labs.arxiv.org/html/1706.03762', expect: 'active' },
  { name: 'Cornell Law entry', url: 'https://www.law.cornell.edu/wex/contract', expect: 'active' },
  // A docs page with a native contents sidebar should support compact mode.
  { name: 'pi.dev docs', url: 'https://pi.dev/docs/latest', expect: 'active' },
  // Expected silent: lists, search results, and marketing pages.
  { name: 'HN list', url: 'https://news.ycombinator.com/', expect: 'silent' },
  { name: 'MDN index', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide', expect: 'silent' },
  { name: 'Search results', url: 'https://html.duckduckgo.com/html/?q=web+browser', expect: 'silent' },
  { name: 'GitHub trending', url: 'https://github.com/trending', expect: 'silent' },
  { name: 'npm search', url: 'https://www.npmjs.com/search?q=web', expect: 'silent' },
  { name: 'Wikipedia category', url: 'https://en.wikipedia.org/wiki/Category:Web_browsers', expect: 'silent' },
  { name: 'YouTube home', url: 'https://www.youtube.com/', expect: 'silent' },
  // Chat and agent workspaces must not treat individual replies as articles.
  { name: 'ChatGPT conversation', url: 'https://chatgpt.com/', expect: 'silent' },
  { name: 'Gemini conversation', url: 'https://gemini.google.com/app', expect: 'silent' },
  // Article-like marketing content is an accepted boundary case.
  { name: 'Tailwind home', url: 'https://tailwindcss.com/', expect: 'active', note: 'Long marketing article' },
  { name: 'Apple home', url: 'https://www.apple.com/', expect: 'silent' },
];

const targets = process.argv.slice(2).length
  ? process.argv.slice(2).map((url) => ({ name: url, url, expect: 'active' }))
  : DEFAULT_TARGETS;

const executablePath = process.env.WSS_CHROME_PATH;
const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'wss-field-')), {
  ...(executablePath ? { executablePath } : { channel: 'chromium' }),
  headless: true,
  viewport: { width: 1280, height: 800 },
  args: [
    `--disable-extensions-except=${EXTENSION_DIR}`,
    `--load-extension=${EXTENSION_DIR}`,
    '--no-first-run',
  ],
});

/** Read the extension's observable state from the host page. */
const inspect = (page) =>
  page.evaluate(() => {
    const host = document.getElementById('__web_sticky_scroll_host__');
    const shadow = host?.shadowRoot;
    const root = shadow?.querySelector('.wss-root');
    const pill = shadow?.querySelector('.wss-pill');
    const pillRect = pill?.getBoundingClientRect();
    const progressBadge = shadow?.querySelector('.wss-icon-badge');
    const progressRing = shadow?.querySelector('.wss-progress-ring');
    const scope = document.querySelector('[data-wss-scope], [data-wss-stats]');
    const dockTop = Number.parseFloat(root?.style.getPropertyValue('--wss-top') ?? 'NaN');

    // Native fixed-header height, used to verify the dock offset.
    let siteHeader = 0;
    for (const ratio of [0.5, 0.08, 0.92]) {
      const x = Math.round(window.innerWidth * ratio);
      for (const element of document.elementsFromPoint(x, 4)) {
        if (!(element instanceof HTMLElement)) continue;
        if (element.id === '__web_sticky_scroll_host__') continue;
        const style = getComputedStyle(element);
        if (style.position !== 'fixed' && style.position !== 'sticky') continue;
        const rect = element.getBoundingClientRect();
        if (rect.height > 0 && rect.width > window.innerWidth * 0.6 && rect.top <= 6) {
          siteHeader = Math.max(siteHeader, Math.round(rect.bottom));
        }
      }
    }

    const shownHeading = shadow?.querySelector('.wss-title')?.textContent?.trim() ?? null;
    const source = shownHeading
      ? [...document.querySelectorAll('h1,h2,h3,h4')].find((node) => node.textContent.trim() === shownHeading)
      : null;

    // Structural metrics distinguish long-form content from page chrome.
    const metrics = (() => {
      if (!scope) return null;
      const text = (element) => (element.textContent ?? '').replace(/\s+/g, '').length;
      const total = Math.max(1, text(scope));
      let linkText = 0;
      for (const anchor of scope.querySelectorAll('a')) linkText += text(anchor);
      let paragraphText = 0;
      let paragraphCount = 0;
      let longestParagraph = 0;
      for (const block of scope.querySelectorAll('p, pre, blockquote, td')) {
        const length = text(block);
        paragraphText += length;
        paragraphCount += 1;
        longestParagraph = Math.max(longestParagraph, length);
      }
      let headingText = 0;
      for (const heading of scope.querySelectorAll('h1,h2,h3,h4')) headingText += text(heading);
      const media = scope.querySelectorAll('img, video, picture, svg, canvas, iframe').length;
      const buttons = scope.querySelectorAll('button, [role="button"], [role="tab"]').length;
      return {
        text: total,
        media,
        mediaPer1000: Number(((media / Math.max(1, total)) * 1000).toFixed(2)),
        buttons,
        linkRatio: Number((linkText / total).toFixed(3)),
        paragraphRatio: Number((paragraphText / total).toFixed(3)),
        paragraphCount,
        avgParagraph: paragraphCount ? Math.round(paragraphText / paragraphCount) : 0,
        longestParagraph,
        headingRatio: Number((headingText / total).toFixed(3)),
      };
    })();

    return {
      url: location.href,
      injected: !!host,
      hasIndex: root?.dataset.wssActive === 'true',
      scope: root?.dataset.wssScope ?? null,
      stats: root?.dataset.wssStats ?? scope?.dataset.wssStats ?? null,
      headings: shadow?.querySelectorAll('.wss-row').length ?? 0,
      visible: root?.dataset.visible ?? null,
      compact: root?.dataset.compact ?? null,
      dockTop: Number.isFinite(dockTop) ? Math.round(dockTop) : null,
      siteHeader,
      shownHeading: shownHeading ? shownHeading.slice(0, 24) : null,
      pill: !!pill,
      pillRect: pillRect
        ? {
            left: Math.round(pillRect.left),
            top: Math.round(pillRect.top),
            right: Math.round(pillRect.right),
            bottom: Math.round(pillRect.bottom),
            height: Math.round(pillRect.height),
          }
        : null,
      progressValue: Number(progressBadge?.getAttribute('aria-valuenow') ?? -1),
      progressOffset: Number.parseFloat(progressRing?.style.strokeDashoffset ?? '88'),
      shownHeadingOffset: source ? Math.round(source.getBoundingClientRect().top - (Number.isFinite(dockTop) ? dockTop : 0)) : null,
      scrollY: Math.round(window.scrollY),
      docHeight: Math.round(document.documentElement.scrollHeight),
      metrics,
    };
  });

/** Scroll through the window or the largest nested scroll container. */
const scrollPage = (page, delta) =>
  page.evaluate((amount) => {
    const before = window.scrollY;
    window.scrollBy(0, amount);
    if (window.scrollY !== before) return;
    // Some sites scroll inside a container instead of the window.
    let best = null;
    for (const element of document.querySelectorAll('*')) {
      if (!(element instanceof HTMLElement)) continue;
      if (element.scrollHeight - element.clientHeight < 200) continue;
      const style = getComputedStyle(element);
      if (style.overflowY !== 'auto' && style.overflowY !== 'scroll') continue;
      if (!best || element.clientHeight > best.clientHeight) best = element;
    }
    if (best) best.scrollTop += amount;
  }, delta);

const startInstrumentation = (page) =>
  page.evaluate(() => {
    const state = {
      longTasks: 0,
      pluginLayoutShifts: 0,
      layoutShiftSources: [],
    };
    window.__wssFieldPerformance = state;
    try {
      new PerformanceObserver((list) => {
        state.longTasks += list.getEntries().filter((entry) => entry.duration > 50).length;
      }).observe({ type: 'longtask', buffered: false });
    } catch {
      /* Keep zero when longtask observation is unsupported. */
    }
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          for (const source of entry.sources ?? []) {
            const node = source.node;
            if (!(node instanceof Element)) continue;
            const touchesPlugin =
              node.id === '__web_sticky_scroll_host__' ||
              node.closest?.('#__web_sticky_scroll_host__') !== null;
            if (!touchesPlugin) continue;
            state.pluginLayoutShifts += 1;
            state.layoutShiftSources.push(node.id || node.className || node.tagName);
          }
        }
      }).observe({ type: 'layout-shift', buffered: false });
    } catch {
      /* ignore */
    }
  });

const results = [];
let mismatches = 0;
let inconclusive = 0;
for (const target of targets) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error).slice(0, 120)));
  const entry = { name: target.name, url: target.url, expect: target.expect };
  try {
    await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.mouse.move(640, 400);
    await page.waitForTimeout(2500);
    entry.atTop = await inspect(page);
    await startInstrumentation(page);
    await scrollPage(page, 900);
    await page.waitForTimeout(700);
    entry.scrolled = await inspect(page);
    await scrollPage(page, 900);
    await page.waitForTimeout(700);
    entry.deeper = await inspect(page);
    entry.performance = await page.evaluate(() => window.__wssFieldPerformance);
    entry.errors = errors;
    // Trust the detector; the capsule may be off-screen on the first pass.
    const statsText = entry.deeper.stats ?? entry.scrolled.stats ?? '';
    const activated = /(^|\s)reading=1(\s|$)/.test(statsText);
    const pillVisible = entry.deeper.visible === 'true' || entry.scrolled.visible === 'true';
    const surface = entry.deeper.pillRect ?? entry.scrolled.pillRect;
    entry.pillVisible = pillVisible;
    entry.pillInViewport =
      !pillVisible ||
      (surface !== null &&
        surface.left >= 0 &&
        surface.top >= 0 &&
        surface.right <= 1280 &&
        surface.bottom <= 800);
    if (entry.pillInViewport === false) mismatches += 1;
    const progressValue = entry.deeper.progressValue ?? entry.scrolled.progressValue;
    const progressOffset = entry.deeper.progressOffset ?? entry.scrolled.progressOffset;
    entry.progressPass =
      !pillVisible ||
      (progressValue >= 0 && progressValue <= 100 && progressOffset >= 0 && progressOffset <= 88);
    if (entry.progressPass === false) mismatches += 1;
    // Site long tasks cannot be attributed to the extension. Only layout
    // shifts caused by the extension host count as failures.
    entry.performancePass =
      !entry.performance || entry.performance.pluginLayoutShifts === 0;
    if (entry.performancePass === false) mismatches += 1;
    entry.activated = activated;
    entry.pass = target.expect === 'active' ? activated : !activated;
  } catch (error) {
    entry.failed = String(error).slice(0, 160);
    entry.inconclusive = /net::ERR_|Timeout .*goto|page\.goto/i.test(entry.failed);
    entry.pass = entry.inconclusive ? null : false;
  }
  if (entry.pass === null) inconclusive += 1;
  if (entry.pass === false) mismatches += 1;
  results.push(entry);
  await page.close();
  console.log(
    [
      entry.pass ? '✓' : entry.pass === null ? '?' : '✗',
      (target.expect === 'active' ? '[应激活]' : '[应静默]').padEnd(9),
      entry.name.padEnd(15),
      `scope=${entry.scrolled?.scope ?? '-'}`,
      `headings=${entry.scrolled?.headings ?? 0}`,
      `activated=${entry.activated ?? '-'}`,
      `pill=${entry.pillVisible ? '✓' : '-'}`,
      entry.pillInViewport === false
        ? '✗越界'
        : entry.progressPass === false
          ? '✗进度线异常'
          : '',
      entry.performancePass === false
        ? `✗插件布局位移=${entry.performance?.pluginLayoutShifts}`
        : entry.performance?.longTasks
          ? `ℹlong=${entry.performance.longTasks}`
          : '',
      entry.failed ? `FAILED ${entry.failed}` : '',
    ].join(' '),
  );
}

const reportPath = join(HERE, '..', 'field-report.json');
writeFileSync(reportPath, JSON.stringify(results, null, 2));
await context.close();
console.log(`\n完整报告: ${reportPath}`);
console.log(
  mismatches === 0
    ? `✓ 激活范围全部符合预期${inconclusive ? `（${inconclusive} 个站点因网络不可达未判定）` : ''}`
    : `✗ ${mismatches} 个站点与预期不符${inconclusive ? `，${inconclusive} 个未判定` : ''}`,
);
