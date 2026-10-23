/**
 * End-to-end checks against the packaged extension:
 * injection, capsule interaction, hierarchy, navigation, visibility policy,
 * native contents handling, and popup settings.
 *
 * Use Chrome for Testing or Chromium because stable Chrome 137+ no longer
 * supports --load-extension.
 */
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { findExtensionRuntime } from './extension-runtime.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = join(HERE, '..', 'dist');
const EXPECTED_HEADINGS = 7; // h1 + 3 h2 + 3 h3; sidebar and footer headings are excluded.
const TOPBAR_HEIGHT = 57; // 56px fixture toolbar plus a 1px border.
const READING_LINE = TOPBAR_HEIGHT + 10;

const failures = [];
const report = {};

function check(name, condition, detail) {
  report[name] = { pass: !!condition, detail };
  if (!condition) failures.push(`${name}: ${JSON.stringify(detail)}`);
}

function startFixtureServer() {
  const html = readFileSync(join(HERE, 'fixture.html'), 'utf8');
  const chatHtml = readFileSync(join(HERE, 'chat-fixture.html'), 'utf8');
  const complexBackgroundHtml = readFileSync(
    join(HERE, 'complex-background-fixture.html'),
    'utf8',
  );
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    const target = request.url?.startsWith('/chat')
      ? chatHtml
      : request.url?.startsWith('/complex-background')
        ? complexBackgroundHtml
        : html;
    response.end(target);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/` });
    });
  });
}

const { server, url } = await startFixtureServer();
const userDataDir = mkdtempSync(join(tmpdir(), 'wss-e2e-'));
const executablePath = process.env.THREAD_ON_CHROME_PATH;

const context = await chromium.launchPersistentContext(userDataDir, {
  ...(executablePath ? { executablePath } : { channel: 'chromium' }),
  headless: false,
  args: [
    `--disable-extensions-except=${EXTENSION_DIR}`,
    `--load-extension=${EXTENSION_DIR}`,
    '--no-first-run',
  ],
});

const probe = (page) =>
  page.evaluate(() => {
    const host = document.getElementById('__web_sticky_scroll_host__');
    const shadow = host?.shadowRoot;
    const root = shadow?.querySelector('.wss-root');
    const active = shadow?.querySelector('.wss-pill');
    const chapterTitle = shadow?.querySelector('.wss-title');
    const drawer = shadow?.querySelector('.wss-drawer');
    const rootStyle = root ? getComputedStyle(root) : null;
    const drawerStyle = drawer ? getComputedStyle(drawer) : null;
    const pill = shadow?.querySelector('.wss-pill');
    const pillStyle = pill ? getComputedStyle(pill) : null;
    const progressBadge = shadow?.querySelector('.wss-icon-badge');
    const progressRing = shadow?.querySelector('.wss-progress-ring');
    return {
      host: !!host,
      attachedToHtml: host?.parentElement?.tagName === 'HTML',
      pill: !!active,
      position: root?.dataset.position ?? null,
      dragging: root?.dataset.dragging ?? null,
      floatingLeft: root
        ? Math.round(Number.parseFloat(root.style.getPropertyValue('--wss-x')) || 0)
        : null,
      floatingTop: root
        ? Math.round(Number.parseFloat(root.style.getPropertyValue('--wss-y')) || 0)
        : null,
      visible: root?.dataset.visible ?? null,
      opacity: rootStyle?.opacity ?? null,
      compact: root?.dataset.compact ?? null,
      top: Number.parseFloat(root?.style.getPropertyValue('--wss-top') ?? 'NaN'),
      drawerBackground: drawerStyle?.backgroundColor ?? null,
      drawerOpacity: drawerStyle?.opacity ?? null,
      drawerBackgroundImage: drawerStyle?.backgroundImage ?? null,
      drawerShadow: drawerStyle?.boxShadow ?? null,
      drawerScrollbar: drawerStyle?.scrollbarWidth ?? null,
      pillBackground: pillStyle?.backgroundImage ?? null,
      pillShadow: pillStyle?.boxShadow ?? null,
      progressValue: Number(progressBadge?.getAttribute('aria-valuenow') ?? 0),
      progressOffset: Number.parseFloat(progressRing?.style.strokeDashoffset ?? '88'),
      surfaceTop: active ? Math.round(active.getBoundingClientRect().top) : null,
      surfaceLeft: active ? Math.round(active.getBoundingClientRect().left) : null,
      surfaceWidth: active ? Math.round(active.getBoundingClientRect().width) : null,
      title: chapterTitle?.textContent?.trim() ?? null,
      titleAriaLabel: chapterTitle?.getAttribute('aria-label') ?? null,
      titleTooltip: chapterTitle?.getAttribute('title') ?? null,
      pillHeight: active ? Math.round(active.getBoundingClientRect().height) : null,
      drawerPath: [...(shadow?.querySelectorAll('.wss-drawer-path .wss-crumb') ?? [])].map(
        (node) => node.textContent,
      ),
      rows: shadow?.querySelectorAll('.wss-row').length ?? 0,
      drawerOpen: shadow?.querySelector('.wss-drawer')?.classList.contains('is-open') ?? null,
      drawerPlacement: shadow?.querySelector('.wss-below')?.dataset.placement ?? null,
      drawerRect: drawer
        ? {
            left: Math.round(drawer.getBoundingClientRect().left),
            right: Math.round(drawer.getBoundingClientRect().right),
            top: Math.round(drawer.getBoundingClientRect().top),
            bottom: Math.round(drawer.getBoundingClientRect().bottom),
          }
        : null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scrollY: Math.round(window.scrollY),
    };
  });

const pillPoint = (page) =>
  page.evaluate(() => {
    const rect = document
      .getElementById('__web_sticky_scroll_host__')
      ?.shadowRoot?.querySelector('.wss-pill')
      ?.getBoundingClientRect();
    return rect
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      : null;
  });

try {
  const runtimePage = await context.newPage();
  await runtimePage.goto(url, { waitUntil: 'load' });
  await runtimePage.waitForTimeout(1000);
  const runtime = await findExtensionRuntime(runtimePage);
  if (!runtime) throw new Error('Could not locate the extension content-script world.');
  const extensionId = runtime.extensionId;
  await runtime.cdp.detach();
  await runtimePage.close();

  // Start with a real legacy settings payload to verify upgrade migration.
  const setup = await context.newPage();
  await setup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await setup.evaluate(async () => {
    await chrome.storage.sync.set({
      'wss:settings': {
        version: 5,
        enabled: true,
        position: 'top-center',
        theme: 'auto',
        offsetY: 0,
        hideArticleTitle: true,
        maxCrumbs: 3,
        displayPolicy: 'always',
        pageTocMode: 'adapt',
        appearance: 'pill',
        barWidth: 'full',
        siteAccess: 'blocklist',
        sites: ['blocked.example'],
        floatingPositions: {},
      },
    });
  });
  await setup.close();

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.goto(url, { waitUntil: 'load' });
  await page.mouse.move(10, 600);
  await page.waitForTimeout(1000);

  // Chat pages can contain article-like headings and paragraphs, but the
  // composer and message turns must keep the extension silent.
  const chatPage = await context.newPage();
  await chatPage.goto(`${url}chat`, { waitUntil: 'load' });
  await chatPage.waitForTimeout(1200);
  const chatSurface = await chatPage.evaluate(() => ({
    headings: document.querySelectorAll('h2, h3').length,
    turns: document.querySelectorAll('[data-message-author-role]').length,
    composer: !!document.querySelector('form textarea'),
    host: !!document.getElementById('__web_sticky_scroll_host__'),
  }));
  await chatPage.close();
  check(
    '持续对话页面不会把回复标题当成文章',
    chatSurface.headings >= 4 &&
      chatSurface.turns >= 4 &&
      chatSurface.composer &&
      !chatSurface.host,
    chatSurface,
  );

  const complexBackgroundPage = await context.newPage();
  await complexBackgroundPage.goto(`${url}complex-background`, { waitUntil: 'load' });
  await complexBackgroundPage.waitForTimeout(1200);
  const complexBackground = await complexBackgroundPage.evaluate(() => ({
    headings: document.querySelectorAll('h1, h2').length,
    host: !!document.getElementById('__web_sticky_scroll_host__'),
  }));
  check(
    '渐变和图片背景页面可使用拟物胶囊',
    complexBackground.headings >= 3 && complexBackground.host,
    complexBackground,
  );
  await complexBackgroundPage.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  await complexBackgroundPage.waitForTimeout(1200);
  const complexBackgroundState = await complexBackgroundPage.evaluate(() => {
    const shadow = document.getElementById('__web_sticky_scroll_host__')?.shadowRoot;
    const pill = shadow?.querySelector('.wss-pill');
    return {
      pill: !!pill,
      title: shadow?.querySelector('.wss-title')?.textContent?.trim() ?? null,
      progressValue: Number(
        shadow?.querySelector('.wss-icon-badge')?.getAttribute('aria-valuenow') ?? 0,
      ),
    };
  });
  await complexBackgroundPage.close();
  check(
    '复杂背景可使用拟物胶囊',
    complexBackgroundState.pill &&
      !!complexBackgroundState.title &&
      complexBackgroundState.progressValue === 100,
    complexBackgroundState,
  );

  const atTop = await probe(page);
  check('injects into the page', atTop.host && atTop.attachedToHtml, atTop);
  if (!atTop.host) {
    console.log(JSON.stringify(report, null, 2));
    console.error('Content script did not inject; remaining assertions cannot run.');
    process.exit(1);
  }
  check('uses the capsule surface', atTop.pill === true, atTop.pill);
  check('stays hidden at the top of the page', atTop.visible === 'false', atTop);

  // Scrolling reveals the capsule; the article-level h1 stays hidden.
  await page.mouse.wheel(0, 1400);
  await page.waitForTimeout(400);
  const scrolled = await probe(page);
  check('appears after scrolling down', scrolled.visible === 'true', scrolled);
  check('clears the fixed toolbar', Math.abs(scrolled.top - (TOPBAR_HEIGHT + 10)) <= 1, scrolled.top);
  check(
    '拟物胶囊保持紧凑单行',
    !!scrolled.title && scrolled.pillHeight === 40,
    scrolled,
  );
  check(
    '章节标题具备完整的无障碍名称和提示',
    !!scrolled.title &&
      scrolled.titleAriaLabel?.includes(scrolled.title) &&
      scrolled.titleTooltip === scrolled.title,
    {
      title: scrolled.title,
      ariaLabel: scrolled.titleAriaLabel,
      tooltip: scrolled.titleTooltip,
    },
  );
  check(
    '胶囊里只显示当前小节标题',
    !!scrolled.title && !scrolled.title.includes('端到端验证用文章'),
    scrolled.title,
  );
  check('outline contains every article heading', scrolled.rows === EXPECTED_HEADINGS, scrolled.rows);
  const stickyState = await page.evaluate(() => {
    const sticky = document.querySelector('.sticky-toolbar');
    const rail = document.querySelector('.left-rail');
    return {
      stickyTop: sticky ? Math.round(sticky.getBoundingClientRect().top) : null,
      railWidth: rail ? Math.round(rail.getBoundingClientRect().width) : null,
    };
  });
  check(
    '正文粘性元素与固定侧栏不会把胶囊带偏',
    stickyState.stickyTop === 0 && scrolled.top === TOPBAR_HEIGHT + 10,
    { ...stickyState, pillTop: scrolled.top },
  );

  // A displayed heading must already have crossed the docking line.
  const timingScan = await page.evaluate(async () => {
    const shadow = document.getElementById('__web_sticky_scroll_host__').shadowRoot;
    // Measure against the docking line, not the entrance animation.
    const dockTop = () => Math.round(shadow.querySelector('.wss-root').style.getPropertyValue('--wss-top').replace('px', '')) || 0;
    const visible = () => shadow.querySelector('.wss-root').dataset.visible === 'true';
    const cloneText = () =>
      shadow.querySelector('.wss-title')?.textContent?.trim() ?? null;
    const source = (text) =>
      [...document.querySelectorAll('h1,h2,h3,h4')].find((node) => node.textContent.trim() === text);
    const frame = () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );

    const samples = [];
    const violations = [];
    const pillLefts = [];
    const pillHeights = [];
    const inspect = () => {
      if (!visible()) return;
      const text = cloneText();
      const node = text ? source(text) : null;
      if (!node) return;
      const delta = Math.round(node.getBoundingClientRect().top - dockTop());
      samples.push(delta);
      const pillRect = shadow.querySelector('.wss-pill').getBoundingClientRect();
      pillLefts.push(Math.round(pillRect.left));
      pillHeights.push(Math.round(pillRect.height));
      // Positive delta means the heading is still visible below the capsule.
      if (delta > 8) {
        violations.push({
          text: text.slice(0, 10),
          tag: node.tagName,
          delta,
          top: Math.round(node.getBoundingClientRect().top),
          dockTop: Math.round(dockTop()),
          pillHeight: Math.round(shadow.querySelector('.wss-pill').getBoundingClientRect().height),
          y: Math.round(window.scrollY),
        });
      }
    };

    for (let y = 300; y <= 1400; y += 6) {
      window.scrollTo(0, y);
      await frame();
      inspect();
    }
    for (let y = 1400; y >= 300; y -= 6) {
      window.scrollTo(0, y);
      await frame();
      inspect();
    }
    return {
      samples: samples.length,
      minDelta: Math.min(...samples),
      maxDelta: Math.max(...samples),
      minPillLeft: Math.min(...pillLefts),
      maxPillLeft: Math.max(...pillLefts),
      minPillHeight: Math.min(...pillHeights),
      maxPillHeight: Math.max(...pillHeights),
      violations,
    };
  });
  check(
    '胶囊只显示已经滑过停靠线的标题（向下不提前 / 回滚不赖着下级）',
    timingScan.samples > 50 &&
      timingScan.violations.length === 0 &&
      timingScan.maxPillLeft - timingScan.minPillLeft <= 1 &&
      timingScan.maxPillHeight - timingScan.minPillHeight <= 1,
    timingScan,
  );

  // The left edge is anchored: longer titles may only grow to the right.
  const titleGrowth = await page.evaluate(async () => {
    const shadow = document.getElementById('__web_sticky_scroll_host__').shadowRoot;
    const pill = shadow.querySelector('.wss-pill');
    const title = shadow.querySelector('.wss-title');
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const original = title.textContent;
    const before = {
      left: Math.round(pill.getBoundingClientRect().left),
      width: Math.round(pill.getBoundingClientRect().width),
      height: Math.round(pill.getBoundingClientRect().height),
    };
    title.textContent = '这是一个用于验证胶囊右侧自然增长而左侧绝不移动的超长章节标题';
    await frame();
    await frame();
    const after = {
      left: Math.round(pill.getBoundingClientRect().left),
      width: Math.round(pill.getBoundingClientRect().width),
      height: Math.round(pill.getBoundingClientRect().height),
    };
    title.textContent = original;
    await frame();
    return { before, after };
  });
  check(
    '标题变长只向右扩展，左边缘和高度保持稳定',
    titleGrowth.after.left === titleGrowth.before.left &&
      titleGrowth.after.width > titleGrowth.before.width &&
      titleGrowth.after.height === titleGrowth.before.height,
    titleGrowth,
  );

  // Do not promote still-visible headings before the true document bottom.
  const bottomTiming = await page.evaluate(async () => {
    const shadow = document.getElementById('__web_sticky_scroll_host__').shadowRoot;
    const root = shadow.querySelector('.wss-root');
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const dockTop = Number.parseFloat(
      root.style.getPropertyValue('--wss-top').replace('px', ''),
    ) || 0;
    const headings = [...document.querySelectorAll('article h1, article h2, article h3')];
    const finalHeading = headings.at(-1)?.textContent?.trim() ?? null;

    const inspect = () => {
      const title = shadow.querySelector('.wss-title');
      const text = title?.textContent?.trim() ?? null;
      const source = text ? headings.find((node) => node.textContent.trim() === text) : null;
      return {
        visible: root.dataset.visible === 'true',
        text,
        sourceTop: source ? Math.round(source.getBoundingClientRect().top) : null,
        scrollY: Math.round(window.scrollY),
        atBottom:
          Math.abs(window.scrollY + window.innerHeight - document.documentElement.scrollHeight) <= 4,
      };
    };

    window.scrollTo(
      0,
      document.documentElement.scrollHeight - window.innerHeight - 120,
    );
    await frame();
    await frame();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const nearBottom = inspect();

    window.scrollTo(0, document.documentElement.scrollHeight);
    await frame();
    await frame();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const atBottom = inspect();

    return {
      nearBottom,
      atBottom,
      finalHeading,
      dockTop,
      activeLine: dockTop + 6,
    };
  });
  check(
    '文章结尾不提前跳级，但真正到底时能显示最后小节',
    !bottomTiming.nearBottom.atBottom &&
      bottomTiming.nearBottom.text !== bottomTiming.finalHeading &&
      bottomTiming.nearBottom.visible &&
      bottomTiming.nearBottom.sourceTop !== null &&
      bottomTiming.nearBottom.sourceTop <= bottomTiming.activeLine &&
      bottomTiming.atBottom.atBottom &&
      bottomTiming.atBottom.visible &&
      bottomTiming.atBottom.text === bottomTiming.finalHeading,
    bottomTiming,
  );

  // Article progress grows monotonically and approaches 100% at the end.
  const readProgress = () =>
    page.evaluate(() => {
      const shadow = document.getElementById('__web_sticky_scroll_host__').shadowRoot;
      return Number(
        shadow.querySelector('.wss-icon-badge')?.getAttribute('aria-valuenow') ?? 0,
      );
    });
  await page.evaluate(() => window.scrollTo(0, 400));
  await page.waitForTimeout(500);
  const progressEarly = await readProgress();
  await page.evaluate(() => window.scrollTo(0, 1000));
  await page.waitForTimeout(500);
  const progressMid = await readProgress();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(600);
  const progressEnd = await readProgress();
  check(
    '进度按整篇文章计算且单调递增',
    progressEarly < progressMid && progressMid < progressEnd && progressEnd > 98,
    { progressEarly, progressMid, progressEnd },
  );
  const progressRing = await page.evaluate(() => {
    const shadow = document.getElementById('__web_sticky_scroll_host__').shadowRoot;
    const badge = shadow.querySelector('.wss-icon-badge');
    const ring = shadow.querySelector('.wss-progress-ring');
    const badgeRect = badge?.getBoundingClientRect();
    const pillRect = shadow.querySelector('.wss-pill')?.getBoundingClientRect();
    return {
      role: badge?.getAttribute('role') ?? null,
      value: Number(badge?.getAttribute('aria-valuenow') ?? -1),
      stroke: ring ? getComputedStyle(ring).stroke : null,
      dashArray: ring ? getComputedStyle(ring).strokeDasharray : null,
      dashOffset: Number.parseFloat(ring?.style.strokeDashoffset ?? '88'),
      badge: badgeRect
        ? {
            left: Math.round(badgeRect.left),
            top: Math.round(badgeRect.top),
            right: Math.round(badgeRect.right),
            bottom: Math.round(badgeRect.bottom),
          }
        : null,
      pill: pillRect
        ? {
            left: Math.round(pillRect.left),
            top: Math.round(pillRect.top),
            right: Math.round(pillRect.right),
            bottom: Math.round(pillRect.bottom),
          }
        : null,
    };
  });
  check(
    '阅读进度以拟物徽标圆环显示',
    progressRing.role === 'progressbar' &&
      progressRing.value === 100 &&
      progressRing.dashOffset <= 0.1 &&
      progressRing.dashArray === '88px' &&
      progressRing.stroke === 'rgb(108, 77, 246)' &&
      progressRing.badge !== null &&
      progressRing.pill !== null &&
      progressRing.badge.left >= progressRing.pill.left &&
      progressRing.badge.right <= progressRing.pill.right &&
      progressRing.badge.top >= progressRing.pill.top &&
      progressRing.badge.bottom <= progressRing.pill.bottom,
    progressRing,
  );

  // Native contents take precedence; compact mode disables the custom drawer.
  const barPoint = await pillPoint(page);
  await page.mouse.move(barPoint.x, barPoint.y);
  await page.waitForTimeout(400);
  const withToc = await probe(page);
  check('yields to native contents', withToc.compact === 'true', withToc);
  check('compact mode suppresses the custom outline', withToc.drawerOpen === false, withToc.drawerOpen);

  // Outline structure and click-to-pin behavior.
  const outlinePanel = await page.evaluate(() => {
    const shadow = document.getElementById('__web_sticky_scroll_host__').shadowRoot;
    return {
      nestedLevels: shadow.querySelectorAll('.wss-outline-level[data-depth]').length,
      rows: shadow.querySelectorAll('.wss-row').length,
    };
  });
  check(
    '大纲面板只保留层级内容，不显示标题和百分比',
    outlinePanel.nestedLevels >= 1 &&
      outlinePanel.rows === EXPECTED_HEADINGS &&
      (await page.evaluate(
        () =>
          !document
            .getElementById('__web_sticky_scroll_host__')
            .shadowRoot.querySelector('.wss-drawer-title, .wss-drawer-progress'),
      )) &&
      withToc.drawerShadow !== 'none' &&
      withToc.drawerScrollbar === 'none' &&
      !!withToc.drawerBackgroundImage?.includes('linear-gradient') &&
      !!withToc.drawerBackgroundImage?.includes('repeating-linear-gradient') &&
      !!withToc.pillBackground?.includes('linear-gradient') &&
      withToc.drawerBackground !== null,
    outlinePanel,
  );

  // Hide native contents, then restore full functionality deep in an h3.
  await page.mouse.move(10, 600);
  await page.evaluate(() => {
    document.getElementById('site-toc').hidden = true;
  });
  await page.waitForTimeout(2200);
  await page.evaluate(() => {
    const heading = document.getElementById('s2-1');
    window.scrollTo(0, heading.getBoundingClientRect().top + window.scrollY - 1);
  });
  await page.waitForTimeout(600);
  await page.mouse.move(barPoint.x, barPoint.y);
  await page.waitForTimeout(400);
  const restored = await probe(page);
  check(
    '原站目录消失后恢复完整功能',
    restored.compact === 'false' &&
      restored.drawerOpen === true &&
      restored.drawerPath.length >= 1 &&
      restored.opacity === '1' &&
      restored.drawerOpacity === '1',
    restored,
  );

  // Clicking the title pins the outline; clicking outside releases it.
  await page.evaluate(() => {
    document
      .getElementById('__web_sticky_scroll_host__')
      .shadowRoot.querySelector('.wss-title')
      .click();
  });
  await page.mouse.move(10, 600);
  await page.waitForTimeout(600);
  const pinnedState = await page.evaluate(() => {
    const shadow = document.getElementById('__web_sticky_scroll_host__').shadowRoot;
    return {
      open: shadow.querySelector('.wss-drawer').classList.contains('is-open'),
      pinned: shadow.querySelector('.wss-root').dataset.pinned,
    };
  });
  check('clicking the title pins the outline', pinnedState.open === true && pinnedState.pinned === 'true', pinnedState);

  await page.mouse.click(30, 650);
  await page.waitForTimeout(400);
  const unpinnedState = await page.evaluate(() => {
    const shadow = document.getElementById('__web_sticky_scroll_host__').shadowRoot;
    return {
      open: shadow.querySelector('.wss-drawer').classList.contains('is-open'),
      pinned: shadow.querySelector('.wss-root').dataset.pinned,
    };
  });
  check(
    '点击界面之外取消钉住',
    unpinnedState.open === false && unpinnedState.pinned === 'false',
    unpinnedState,
  );

  // Reopen and click an ancestor; the target lands below the capsule.
  await page.mouse.move(barPoint.x, barPoint.y);
  await page.waitForTimeout(400);
  const reopened = await probe(page);
  check('hover reopens the outline after leaving', reopened.drawerOpen === true, reopened.drawerOpen);
  const clickedText = reopened.drawerPath[0];
  await page.evaluate(() => {
    const shadow = document.getElementById('__web_sticky_scroll_host__').shadowRoot;
    shadow.querySelector('.wss-drawer-path .wss-crumb').click();
  });
  // The extension writes the expected scroll offset through scroll-margin-top.
  const expectedLanding = await page.evaluate((text) => {
    const heading = [...document.querySelectorAll('h1,h2,h3,h4')].find(
      (node) => node.textContent.trim() === text,
    );
    return heading ? Math.round(Number.parseFloat(heading.style.scrollMarginTop)) : null;
  }, clickedText);
  await page.waitForTimeout(1500);
  const landed = await page.evaluate((text) => {
    const shadow = document.getElementById('__web_sticky_scroll_host__').shadowRoot;
    const heading = [...document.querySelectorAll('h1,h2,h3,h4')].find(
      (node) => node.textContent.trim() === text,
    );
    const title = shadow.querySelector('.wss-title');
    return {
      clicked: text,
      top: Math.round(heading?.getBoundingClientRect().top ?? -1),
      shown: title?.textContent?.trim() ?? null,
    };
  }, clickedText);
  check(
    '点击回溯落点准确',
    expectedLanding !== null && Math.abs(landed.top - expectedLanding) <= 6,
    { ...landed, expectedLanding, readingLine: READING_LINE },
  );
  check('jump keeps the target heading active', landed.shown === landed.clicked, landed);
  const afterJump = await probe(page);
  check('capsule remains visible after a jump', afterJump.visible === 'true', afterJump);

  // Find-in-page must own the top edge while active.
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
  });
  await page.waitForTimeout(400);
  const findModeOn = await probe(page);
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await page.waitForTimeout(400);
  const findModeOff = await probe(page);
  check(
    '页面查找时自动收起，Esc 后恢复',
    findModeOn.visible === 'false' && findModeOff.visible === 'true',
    { duringFind: findModeOn.visible, afterEsc: findModeOff.visible },
  );

  // Site search panels and dialogs take precedence over the extension.
  await page.evaluate(() => {
    const dialog = document.createElement('div');
    dialog.id = 'e2e-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.style.cssText =
      'position:fixed;top:0;left:0;width:520px;height:400px;background:#fff;z-index:999999';
    document.body.appendChild(dialog);
  });
  await page.waitForTimeout(1400);
  const dialogOpen = await probe(page);
  await page.evaluate(() => document.getElementById('e2e-dialog')?.remove());
  await page.waitForTimeout(1400);
  const dialogClosed = await probe(page);
  check(
    '站点弹层盖住顶部时让位，关闭后恢复',
    dialogOpen.visible === 'false' && dialogClosed.visible === 'true',
    { dialogOpen: dialogOpen.visible, dialogClosed: dialogClosed.visible },
  );

  // Keep the capsule below foreign UI that already owns a higher layer.
  await page.evaluate(() => {
    const layer = document.createElement('div');
    layer.id = 'e2e-foreign-layer';
    layer.textContent = '外部浮层';
    layer.style.cssText =
      'position:fixed;top:4px;right:16px;width:220px;height:44px;background:#fff;border:1px solid #999;z-index:2147483647';
    document.body.appendChild(layer);
  });
  await page.waitForTimeout(1400);
  const foreignLayer = await page.evaluate(() => {
    const root = document
      .getElementById('__web_sticky_scroll_host__')
      ?.shadowRoot?.querySelector('.wss-root');
    return {
      ours: root?.style.getPropertyValue('--wss-z-index') ?? null,
      topmost: document.elementFromPoint(window.innerWidth - 100, 20)?.id ?? null,
    };
  });
  await page.evaluate(() => document.getElementById('e2e-foreign-layer')?.remove());
  await page.waitForTimeout(1400);
  const foreignLayerGone = await page.evaluate(
    () =>
      document
        .getElementById('__web_sticky_scroll_host__')
        ?.shadowRoot?.querySelector('.wss-root')
        ?.style.getPropertyValue('--wss-z-index') ?? null,
  );
  check(
    '不覆盖更高层的外来 UI，且它消失后恢复层级',
    foreignLayer.ours === '2147483646' &&
      foreignLayer.topmost === 'e2e-foreign-layer' &&
      foreignLayerGone === '2147483600',
    { ...foreignLayer, restored: foreignLayerGone },
  );

  // The capsule surface must remain readable on any page background.
  await page.evaluate(() => {
    document.querySelector('article').style.backgroundImage =
      'linear-gradient(135deg, #ff006e, #3a86ff)';
  });
  await page.waitForTimeout(1400);
  const dynamicUnsafe = await probe(page);
  await page.evaluate(() => {
    document.querySelector('article').style.removeProperty('background-image');
  });
  await page.waitForTimeout(1400);
  const dynamicSafe = await probe(page);
  check(
    '网页背景变化不影响拟物胶囊',
    dynamicUnsafe.visible === 'true' && dynamicSafe.visible === 'true',
    { changed: dynamicUnsafe.visible, restored: dynamicSafe.visible },
  );

  // Three repeated layout failures must remove all extension artifacts.
  const faultPage = await context.newPage();
  const faultPageErrors = [];
  faultPage.on('pageerror', (error) => faultPageErrors.push(String(error)));
  await faultPage.goto(url, { waitUntil: 'load' });
  await faultPage.waitForTimeout(1000);

  // Content scripts run in an isolated world. Use CDP to force a layout API
  // failure in that world rather than modifying the page's prototypes.
  const faultRuntime = await findExtensionRuntime(faultPage, extensionId);
  const cdp = faultRuntime?.cdp ?? (await context.newCDPSession(faultPage));
  const extensionContextId = faultRuntime?.contextId ?? null;
  check('finds the content-script isolated world', extensionContextId !== null, extensionContextId);

  const faultHadHost = await faultPage.evaluate(
    () => !!document.getElementById('__web_sticky_scroll_host__'),
  );
  let faultResult = {
    hadHost: faultHadHost,
    hostExists: true,
    markers: -1,
    persistentMarker: false,
  };
  if (extensionContextId !== null) {
    await cdp.send('Runtime.evaluate', {
      contextId: extensionContextId,
      expression: `(() => {
        const original = Element.prototype.getBoundingClientRect;
        window.__wssE2eOriginalRect = original;
        Element.prototype.getBoundingClientRect = function () {
          if (this instanceof HTMLElement && this.matches('h2, h3')) {
            throw new Error('forced layout failure');
          }
          return original.call(this);
        };
        return true;
      })()`,
      returnByValue: true,
    });
    await faultPage.evaluate(async () => {
      const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
      for (const y of [500, 900, 1300, 1700]) {
        window.scrollTo(0, y);
        await nextFrame();
        await nextFrame();
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    await cdp.send('Runtime.evaluate', {
      contextId: extensionContextId,
      expression: `(() => {
        if (window.__wssE2eOriginalRect) {
          Element.prototype.getBoundingClientRect = window.__wssE2eOriginalRect;
        }
        return true;
      })()`,
      returnByValue: true,
    });
    faultResult = await faultPage.evaluate(() => ({
      hostExists: !!document.getElementById('__web_sticky_scroll_host__'),
      markers: document.querySelectorAll('[data-wss-id], [data-wss-scope], [data-wss-stats]').length,
      persistentMarker: Array.from(
        { length: sessionStorage.length },
        (_, index) => sessionStorage.key(index) ?? '',
      ).some((key) => key.startsWith('wss:failsafe:')),
    }));
    faultResult.hadHost = faultHadHost;
  }
  await cdp.detach();
  await faultPage.reload({ waitUntil: 'load' });
  await faultPage.waitForTimeout(1000);
  const recoveredAfterReload = await faultPage.evaluate(
    () => !!document.getElementById('__web_sticky_scroll_host__'),
  );
  await faultPage.close();
  check(
    '连续异常后静默退出且刷新后可以恢复',
    faultResult.hadHost &&
      !faultResult.hostExists &&
      faultResult.markers === 0 &&
      !faultResult.persistentMarker &&
      recoveredAfterReload &&
      faultPageErrors.length === 0,
    { ...faultResult, recoveredAfterReload, pageErrors: faultPageErrors },
  );

  // All settings live in the popup; there is no secondary options page.
  const control = await context.newPage();
  await control.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await control.waitForTimeout(500);
  const controlState = await control.evaluate(() => ({
    policy:
      document.querySelector('input[name="displayPolicy"]:checked')?.value ?? '',
    hasOptionsPage: !!chrome.runtime.getManifest().options_ui,
    hasCommands: !!chrome.runtime.getManifest().commands,
    hasOptionsButton: !!document.querySelector('#options'),
    hasCoreControls:
      !!document.querySelector('#enabled') &&
      document.querySelectorAll('input[name="displayPolicy"]').length === 2 &&
      !!document.querySelector('#site'),
  }));
  check(
    '设置已合并进弹窗，且没有遗留快捷键',
    controlState.policy === 'always' &&
      !controlState.hasOptionsPage &&
      !controlState.hasCommands &&
      !controlState.hasOptionsButton &&
      controlState.hasCoreControls,
    controlState,
  );

  await control.locator('input[name="displayPolicy"][value="smart"]').check();
  await page.bringToFront();
  await page.waitForTimeout(700);
  const switched = await probe(page);
  check(
    '智能策略下拟物胶囊保持稳定',
    switched.pill &&
      Math.abs(switched.top - (TOPBAR_HEIGHT + 10)) <= 1 &&
      !!switched.title &&
      !!switched.pillBackground?.includes('linear-gradient') &&
      switched.pillShadow !== 'none',
    switched,
  );

  await page.evaluate(() => window.scrollTo(0, 2200));
  await page.waitForTimeout(500);
  await page.mouse.move(10, 600);
  await page.mouse.wheel(0, -320);
  await page.waitForTimeout(450);
  const scrolledUp = await probe(page);
  check(
    '智能策略向上滚动收起胶囊',
    scrolledUp.visible === 'false',
    scrolledUp,
  );
  await page.mouse.wheel(0, 320);
  await page.waitForTimeout(450);

  const pillBeforeDrag = await pillPoint(page);
  await page.mouse.move(pillBeforeDrag.x, pillBeforeDrag.y);
  await page.mouse.down();
  await page.mouse.move(240, 520, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  await page.mouse.move(240, 520);
  await page.waitForTimeout(350);
  const dragged = await probe(page);
  check(
    '拟物胶囊可自由拖动并记住位置',
    dragged.position === 'custom' &&
      dragged.floatingLeft >= 8 &&
      dragged.floatingTop > 400 &&
      dragged.drawerRect !== null &&
      Math.abs(dragged.drawerRect.left - dragged.surfaceLeft) <= 1 &&
      Math.abs(dragged.drawerRect.right - dragged.drawerRect.left - 304) <= 1,
    dragged,
  );
  check(
    '拖到页面下半部时目录向上展开并留在视口内',
    dragged.drawerPlacement === 'above' &&
      dragged.drawerRect !== null &&
      dragged.drawerRect.top >= 0 &&
      dragged.drawerRect.bottom <= dragged.surfaceTop + 6 &&
      dragged.drawerRect.left >= 0 &&
      dragged.drawerRect.right <= dragged.viewport.width,
    dragged,
  );

  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);
  const draggedPersisted = await probe(page);
  check(
    '刷新页面后按站点恢复拖动位置',
    draggedPersisted.position === 'custom' &&
      Math.abs(draggedPersisted.floatingLeft - dragged.floatingLeft) <= 2 &&
      Math.abs(draggedPersisted.floatingTop - dragged.floatingTop) <= 2,
    { dragged, persisted: draggedPersisted },
  );

  await page.setViewportSize({ width: 860, height: 560 });
  await page.waitForTimeout(500);
  const resized = await page.evaluate(() => {
    const shadow = document.getElementById('__web_sticky_scroll_host__')?.shadowRoot;
    const pill = shadow?.querySelector('.wss-pill')?.getBoundingClientRect();
    return {
      left: pill ? Math.round(pill.left) : null,
      top: pill ? Math.round(pill.top) : null,
      right: pill ? Math.round(pill.right) : null,
      bottom: pill ? Math.round(pill.bottom) : null,
      width: window.innerWidth,
      height: window.innerHeight,
    };
  });
  check(
    '缩小窗口后胶囊自动夹在可视区域内',
    resized.left !== null &&
      resized.top !== null &&
      resized.right !== null &&
      resized.bottom !== null &&
      resized.left >= 8 &&
      resized.top >= 8 &&
      resized.right <= resized.width - 8 &&
      resized.bottom <= resized.height - 8,
    resized,
  );

  await page.setViewportSize({ width: 1280, height: 720 });
  // Legacy x=100 positioning can place the capsule outside the viewport after
  // the coordinate model changed. Clamp it so upgrades remain visible.
  await control.evaluate(async () => {
    await chrome.storage.sync.set({
      'wss:settings': {
        version: 5,
        enabled: true,
        displayPolicy: 'always',
        siteAccess: 'blocklist',
        sites: [],
        floatingPositions: { '127.0.0.1': { x: 100, y: 20 } },
      },
    });
  });
  await page.waitForTimeout(700);
  const legacyPosition = await probe(page);
  check(
    '升级后旧版右侧位置会被完整夹回视口',
    legacyPosition.position === 'custom' &&
      legacyPosition.surfaceLeft !== null &&
      legacyPosition.surfaceWidth !== null &&
      legacyPosition.surfaceLeft >= 8 &&
      legacyPosition.surfaceLeft + legacyPosition.surfaceWidth <=
        legacyPosition.viewport.width - 8,
    legacyPosition,
  );

  await page.evaluate(() => window.scrollTo(0, 1000));
  await page.waitForTimeout(500);
  await page.evaluate(() => window.scrollTo(0, 1400));
  await page.waitForTimeout(500);
  const beforeReset = await probe(page);
  check('capsule is visible before reset', beforeReset.visible === 'true', beforeReset);
  const resetPoint = await pillPoint(page);
  await page.mouse.dblclick(resetPoint.x, resetPoint.y);
  await page.waitForTimeout(500);
  const reset = await probe(page);
  check(
    '双击胶囊恢复默认顶部位置',
    reset.position === 'top-center' &&
      Math.abs(reset.surfaceTop - (TOPBAR_HEIGHT + 10)) <= 1,
    reset,
  );

  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(900);
  const resetPersisted = await probe(page);
  check(
    '恢复默认位置后刷新仍保持默认',
    resetPersisted.position === 'top-center',
    resetPersisted,
  );

  check('no page errors occur during the run', pageErrors.length === 0, pageErrors);

  // Popup status and per-site disable action.
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await page.bringToFront();
  // Reload the background popup after making the fixture the active tab.
  await popup.reload();
  await popup.waitForTimeout(700);
  const popupState = await popup.evaluate(() => ({
    title: document.querySelector('h1')?.textContent ?? '',
    policy:
      document.querySelector('input[name="displayPolicy"]:checked')?.value ?? '',
    siteButtonDisabled: document.querySelector('#site')?.disabled ?? true,
    hasOptions: !!document.querySelector('#options'),
    hasRemovedDiagnostics: !!document.querySelector('#copy, #rescan'),
    hasMergedControls:
      !!document.querySelector('#enabled') &&
      document.querySelectorAll('input[name="displayPolicy"]').length === 2,
  }));
  check('popup renders', popupState.title.includes('Thread On'), popupState);
  check('popup reads the active host', popupState.siteButtonDisabled === false, popupState);
  check(
    'popup 只保留高频操作',
    !popupState.hasOptions &&
      !popupState.hasRemovedDiagnostics &&
      popupState.hasMergedControls,
    popupState,
  );

  const popupStatusBeforeToggle = await popup.locator('#statusText').innerText();
  await popup.locator('.switch-track').click();
  await popup.waitForTimeout(300);
  const popupToggleState = await popup.evaluate(async () => {
    const stored = await chrome.storage.sync.get('wss:settings');
    return {
      enabled: document.querySelector('#enabled')?.checked ?? true,
      status: document.querySelector('#statusText')?.textContent ?? '',
      stored: stored['wss:settings']?.enabled ?? null,
    };
  });
  check(
    '关闭总开关后状态立即更新',
    popupToggleState.enabled === false &&
      popupToggleState.stored === false &&
      popupToggleState.status !== popupStatusBeforeToggle,
    { before: popupStatusBeforeToggle, after: popupToggleState },
  );
  await popup.locator('.switch-track').click();
  await popup.waitForTimeout(300);

  await popup.evaluate(() => document.querySelector('#site').click());
  await popup.waitForTimeout(900);
  const disabled = await page.evaluate(() => ({
    hostExists: !!document.getElementById('__web_sticky_scroll_host__'),
  }));
  check('per-site disable removes the UI immediately', disabled.hostExists === false, disabled);
} catch (error) {
  failures.push(`运行异常: ${error}`);
} finally {
  await context.close();
  server.close();
}

console.log(JSON.stringify(report, null, 2));
if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} 项失败:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('\n✓ 全部通过');
