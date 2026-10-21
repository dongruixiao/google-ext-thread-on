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
  { name: 'web.dev 长文', url: 'https://web.dev/articles/rendering-performance', expect: 'active' },
  { name: 'TypeScript 手册', url: 'https://www.typescriptlang.org/docs/handbook/2/everyday-types.html', expect: 'active' },
  { name: 'Rust Book', url: 'https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html', expect: 'active' },
  { name: 'WHATWG HTML', url: 'https://html.spec.whatwg.org/multipage/dom.html', expect: 'active' },
  { name: 'W3C WCAG', url: 'https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html', expect: 'active' },
  { name: 'Martin Fowler', url: 'https://martinfowler.com/articles/microservices.html', expect: 'active' },
  // 长文但没有章节标题：没有可吸顶的对象，按产品边界保持静默
  { name: 'Paul Graham 长文', url: 'https://paulgraham.com/lisp.html', expect: 'silent', note: '无小节标题' },
  { name: 'ar5iv 论文', url: 'https://ar5iv.labs.arxiv.org/html/1706.03762', expect: 'active' },
  { name: 'Cornell 法律条目', url: 'https://www.law.cornell.edu/wex/contract', expect: 'active' },
  // 整宽 main 里塞了左侧目录的文档站：吸顶标题必须对齐正文列，而不是贴视口左边
  { name: 'pi.dev 文档', url: 'https://pi.dev/docs/latest', expect: 'active' },
  // 不该激活：列表页、搜索结果、营销首页
  { name: 'HN 列表', url: 'https://news.ycombinator.com/', expect: 'silent' },
  { name: 'MDN 目录页', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide', expect: 'silent' },
  { name: '搜索结果页', url: 'https://html.duckduckgo.com/html/?q=web+browser', expect: 'silent' },
  { name: 'GitHub 趋势页', url: 'https://github.com/trending', expect: 'silent' },
  { name: 'npm 搜索', url: 'https://www.npmjs.com/search?q=web', expect: 'silent' },
  { name: 'Wikipedia 分类', url: 'https://en.wikipedia.org/wiki/Category:Web_browsers', expect: 'silent' },
  { name: 'YouTube 首页', url: 'https://www.youtube.com/', expect: 'silent' },
  // 持续对话 / 代理工作区：即使回答里有长标题，也不能当成独立文章
  { name: 'ChatGPT 对话', url: 'https://chatgpt.com/', expect: 'silent' },
  { name: 'Gemini 对话', url: 'https://gemini.google.com/app', expect: 'silent' },
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
    const scope = document.querySelector('[data-wss-scope], [data-wss-stats]');
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

    // 参考列：用网页自己的段落算出正文文字列（与插件实现无关）
    const columnRef = (() => {
      let best = [];
      for (const scope of document.querySelectorAll('main, article, [role="main"]')) {
        const paragraphs = [...scope.querySelectorAll('p')].filter((paragraph) => {
          if (
            paragraph.closest(
              'nav, aside, footer, header, [role="navigation"], [role="complementary"], #__web_sticky_scroll_host__',
            )
          ) {
            return false;
          }
          const rect = paragraph.getBoundingClientRect();
          return rect.width >= 160 && rect.height > 0;
        });
        if (paragraphs.length > best.length) best = paragraphs;
      }
      if (best.length === 0) return null;
      const lefts = best.map((p) => Math.round(p.getBoundingClientRect().left)).sort((a, b) => a - b);
      const rights = best.map((p) => Math.round(p.getBoundingClientRect().right)).sort((a, b) => a - b);
      const mid = Math.floor(lefts.length / 2);
      return { left: lefts[mid], right: rights[mid], count: best.length };
    })();
    const cloneLeft = clone ? Math.round(clone.getBoundingClientRect().left) : null;

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
      hasIndex: root?.dataset.wssActive === 'true',
      scope: root?.dataset.wssScope ?? null,
      stats: root?.dataset.wssStats ?? scope?.dataset.wssStats ?? null,
      headings: shadow?.querySelectorAll('.wss-row').length ?? 0,
      visible: root?.dataset.visible ?? null,
      compact: root?.dataset.compact ?? null,
      appearance: root?.dataset.appearance ?? null,
      dockTop: Number.isFinite(dockTop) ? Math.round(dockTop) : null,
      siteHeader,
      shownHeading: shownHeading ? shownHeading.slice(0, 24) : null,
      columnRef,
      cloneLeft,
      // 吸顶标题与正文文字列的偏差（越接近 0 越好）
      alignmentDelta: cloneLeft !== null && columnRef ? cloneLeft - columnRef.left : null,
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
      /* 浏览器不支持 longtask 时保留为 0 */
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
    // 以插件自己的判定为准（页面正文可能在首屏之外，用“条是否可见”会误判）
    const statsText = entry.deeper.stats ?? entry.scrolled.stats ?? '';
    const activated = /(^|\s)art=1(\s|$)/.test(statsText);
    const alignment = entry.deeper.alignmentDelta ?? entry.scrolled.alignmentDelta ?? null;
    const barVisible = entry.deeper.visible === 'true' || entry.scrolled.visible === 'true';
    entry.alignmentDelta = alignment;
    // 只在“真的显示了”的页面上校验对齐：与正文文字列偏差 ≤ 2px
    entry.aligned = !barVisible || alignment === null ? null : Math.abs(alignment) <= 2;
    if (entry.aligned === false) mismatches += 1;
    // 真实站点自身的长任务无法可靠归因给扩展，因此作为观测值记录；
    // 只有明确由插件宿主造成的布局位移才判失败。
    entry.performancePass =
      !entry.performance || entry.performance.pluginLayoutShifts === 0;
    if (entry.performancePass === false) mismatches += 1;
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
      `alignΔ=${entry.alignmentDelta ?? '-'}`,
      entry.aligned === false ? '✗错位' : entry.aligned ? '✓对齐' : '',
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
console.log(mismatches === 0 ? '✓ 激活范围全部符合预期' : `✗ ${mismatches} 个站点与预期不符`);
