/**
 * 实地检查：拿打包好的扩展去跑真实网站，看看它在"不是我们写的页面"上表现如何。
 *
 *   npm run build
 *   WSS_CHROME_PATH=... npm run field-check              # 跑内置站点列表
 *   WSS_CHROME_PATH=... npm run field-check https://...  # 只跑指定页面
 *
 * 输出每个站点的：是否注入、识别到的正文容器、标题数量、吸顶条位置、
 * 是否与原站目录共存、以及页面报错。
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = join(HERE, '..', 'dist');

/** 应该激活：长文 / 文档 / 百科 / README */
const DEFAULT_TARGETS = [
  { name: 'MDN 文档', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_expressions', expect: 'active' },
  { name: 'Python 文档', url: 'https://docs.python.org/3/tutorial/controlflow.html', expect: 'active' },
  { name: 'React 文档', url: 'https://react.dev/learn/thinking-in-react', expect: 'active' },
  { name: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Web_browser', expect: 'active' },
  { name: 'GitHub README', url: 'https://github.com/vitejs/vite', expect: 'active' },
  { name: 'Vite 官网文档', url: 'https://vite.dev/guide/', expect: 'active' },
  // 不该激活：列表页、搜索结果、营销首页
  { name: 'HN 列表', url: 'https://news.ycombinator.com/', expect: 'silent' },
  { name: 'MDN 目录页', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide', expect: 'silent' },
  { name: '搜索结果页', url: 'https://html.duckduckgo.com/html/?q=web+browser', expect: 'silent' },
  // 这一页是一篇很长的营销长文（6.7k 字、单栏、段落为主、章节 1.5k 字），
  // 结构上和长文一致，因此判定为激活——属于可接受的边界情况。
  { name: 'Tailwind 首页', url: 'https://tailwindcss.com/', expect: 'active', note: '长营销页，边界情况' },
  { name: 'Apple 首页', url: 'https://www.apple.com/', expect: 'silent' },
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

/** 在页面里读取插件的实际状态 */
const inspect = (page) =>
  page.evaluate(() => {
    const host = document.getElementById('__web_sticky_scroll_host__');
    const shadow = host?.shadowRoot;
    const root = shadow?.querySelector('.wss-root');
    const clone = shadow?.querySelector('[data-wss-clone="true"]');
    const scope = document.querySelector('[data-wss-scope]');
    const dockTop = Number.parseFloat(root?.style.getPropertyValue('--wss-top') ?? 'NaN');

    // 站点自己的固定顶栏高度（用来对比我们的吸附位置）
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

    const shownHeading = clone?.textContent?.trim() ?? null;
    const source = shownHeading
      ? [...document.querySelectorAll('h1,h2,h3,h4')].find((node) => node.textContent.trim() === shownHeading)
      : null;

    // 结构指标：用来区分「长文」和「导航/营销/搜索页」
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
      hasIndex: !!scope,
      scope: scope ? `${scope.tagName.toLowerCase()}${scope.className ? '.' + String(scope.className).split(' ')[0] : ''}` : null,
      stats: scope?.dataset.wssStats ?? null,
      headings: document.querySelectorAll('[data-wss-id]').length,
      visible: root?.dataset.visible ?? null,
      compact: root?.dataset.compact ?? null,
      appearance: root?.dataset.appearance ?? null,
      dockTop: Number.isFinite(dockTop) ? Math.round(dockTop) : null,
      siteHeader,
      shownHeading: shownHeading ? shownHeading.slice(0, 24) : null,
      shownHeadingOffset: source ? Math.round(source.getBoundingClientRect().top - (Number.isFinite(dockTop) ? dockTop : 0)) : null,
      scrollY: Math.round(window.scrollY),
      docHeight: Math.round(document.documentElement.scrollHeight),
      metrics,
    };
  });

/**
 * 把页面往下滚一段。
 * 注意：直接在页面左侧滚轮经常滚到的是侧边栏，所以这里用 window 或最大的滚动容器。
 */
const scrollPage = (page, delta) =>
  page.evaluate((amount) => {
    const before = window.scrollY;
    window.scrollBy(0, amount);
    if (window.scrollY !== before) return;
    // 页面自身不滚（内容在容器里滚动）：找最大的可滚动容器
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

const results = [];
let mismatches = 0;
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
    await scrollPage(page, 900);
    await page.waitForTimeout(700);
    entry.scrolled = await inspect(page);
    await scrollPage(page, 900);
    await page.waitForTimeout(700);
    entry.deeper = await inspect(page);
    entry.errors = errors;
    // 以插件自己的判定为准（页面正文可能在首屏之外，用“条是否可见”会误判）
    const statsText = entry.deeper.stats ?? entry.scrolled.stats ?? '';
    const activated = /(^|\s)art=1(\s|$)/.test(statsText);
    entry.barVisible = entry.deeper.visible === 'true' || entry.scrolled.visible === 'true';
    entry.activated = activated;
    entry.pass = target.expect === 'active' ? activated : !activated;
  } catch (error) {
    entry.failed = String(error).slice(0, 160);
    entry.pass = false;
  }
  if (entry.pass === false) mismatches += 1;
  results.push(entry);
  await page.close();
  console.log(
    [
      entry.pass ? '✓' : '✗',
      (target.expect === 'active' ? '[应激活]' : '[应静默]').padEnd(9),
      entry.name.padEnd(15),
      `scope=${entry.scrolled?.scope ?? '-'}`,
      `headings=${entry.scrolled?.headings ?? 0}`,
      `activated=${entry.activated ?? '-'}`,
      entry.failed ? `FAILED ${entry.failed}` : '',
    ].join(' '),
  );
}

const reportPath = join(HERE, '..', 'field-report.json');
writeFileSync(reportPath, JSON.stringify(results, null, 2));
await context.close();
console.log(`\n完整报告: ${reportPath}`);
console.log(mismatches === 0 ? '✓ 激活范围全部符合预期' : `✗ ${mismatches} 个站点与预期不符`);
