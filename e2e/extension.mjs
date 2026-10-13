/**
 * 端到端验证：用真实浏览器加载打包后的 dist/，
 * 检查注入、吸顶条形态、层级、跳转、显示策略、原站目录适配与设置链路。
 *
 *   npm run build && npm run e2e
 *
 * 浏览器来源（按优先级）：
 *   1. 环境变量 WSS_CHROME_PATH 指定的可执行文件
 *   2. Playwright 自带 Chromium（npx playwright install chromium）
 * 注意：Chrome 137+ 正式版已移除 --load-extension，请使用 Chromium / Chrome for Testing。
 */
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = join(HERE, '..', 'dist');
const EXPECTED_HEADINGS = 7; // h1 + 3×h2 + 3×h3（侧边栏与页脚的标题必须被排除）
const TOPBAR_HEIGHT = 57; // fixture 顶栏 56px + 1px 边框
const BAR_DETECT_HEIGHT = 56; // 判定基准线用的固定条高
const READING_LINE = TOPBAR_HEIGHT + BAR_DETECT_HEIGHT + 2;

const failures = [];
const report = {};

function check(name, condition, detail) {
  report[name] = { pass: !!condition, detail };
  if (!condition) failures.push(`${name}: ${JSON.stringify(detail)}`);
}

function startFixtureServer() {
  const html = readFileSync(join(HERE, 'fixture.html'), 'utf8');
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/` });
    });
  });
}

const { server, url } = await startFixtureServer();
const userDataDir = mkdtempSync(join(tmpdir(), 'wss-e2e-'));
const executablePath = process.env.WSS_CHROME_PATH;

const context = await chromium.launchPersistentContext(userDataDir, {
  ...(executablePath ? { executablePath } : { channel: 'chromium' }),
  headless: true,
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
    const surface = root?.dataset.appearance === 'bar' ? '.wss-bar-inner' : '.wss-pill';
    const active = shadow?.querySelector(surface);
    const crumbs = [...(active?.querySelectorAll('.wss-crumb') ?? [])].map((node) => node.textContent);
    const clone = shadow?.querySelector('[data-wss-clone="true"]');
    const article = document.querySelector('article');
    const anchor = root?.dataset.appearance === 'bar' ? clone : active?.querySelector('.wss-crumb');
    return {
      host: !!host,
      attachedToHtml: host?.parentElement?.tagName === 'HTML',
      appearance: root?.dataset.appearance ?? null,
      visible: root?.dataset.visible ?? null,
      compact: root?.dataset.compact ?? null,
      top: Number.parseFloat(root?.style.getPropertyValue('--wss-top') ?? 'NaN'),
      sheetBackground: shadow
        ? getComputedStyle(shadow.querySelector('.wss-bar-sheet')).backgroundColor
        : null,
      surfaceTop: active ? Math.round(active.getBoundingClientRect().top) : null,
      barHeight: Math.round(shadow?.querySelector('.wss-bar')?.getBoundingClientRect().height ?? 0),
      cloneText: clone?.textContent?.trim() ?? null,
      cloneHeight: Math.round(clone?.getBoundingClientRect().height ?? 0),
      crumbLeft: anchor ? Math.round(anchor.getBoundingClientRect().left) : null,
      articleLeft: article ? Math.round(article.getBoundingClientRect().left) : null,
      crumbs,
      drawerPath: [...(shadow?.querySelectorAll('.wss-drawer-path .wss-crumb') ?? [])].map(
        (node) => node.textContent,
      ),
      rows: shadow?.querySelectorAll('.wss-row').length ?? 0,
      drawerOpen: shadow?.querySelector('.wss-drawer')?.classList.contains('is-open') ?? null,
      scrollY: Math.round(window.scrollY),
    };
  });

try {
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.goto(url, { waitUntil: 'load' });
  await page.mouse.move(10, 600);
  await page.waitForTimeout(1000);

  const atTop = await probe(page);
  check('注入到页面', atTop.host && atTop.attachedToHtml, atTop);
  if (!atTop.host) {
    console.log(JSON.stringify(report, null, 2));
    console.error('内容脚本没有注入，后续断言无法进行');
    process.exit(1);
  }
  check('默认是吸顶条形态', atTop.appearance === 'bar', atTop.appearance);
  check('页面顶部保持静默', atTop.visible === 'false', atTop);

  // 向下滚动：吸顶条浮现，且默认不显示文章大标题
  await page.mouse.wheel(0, 1400);
  await page.waitForTimeout(400);
  const scrolled = await probe(page);
  check('向下滚动后浮现', scrolled.visible === 'true', scrolled);
  check('吸顶条贴在固定顶栏下方', Math.abs(scrolled.top - TOPBAR_HEIGHT) <= 1, scrolled.top);
  check(
    '吸顶条实心、取自页面底色',
    !!scrolled.sheetBackground && scrolled.sheetBackground.startsWith('rgb('),
    scrolled.sheetBackground,
  );
  check(
    '条里只显示当前小节标题',
    !!scrolled.cloneText &&
      !scrolled.cloneText.includes('端到端验证用文章') &&
      scrolled.crumbs.length === 0,
    { cloneText: scrolled.cloneText, crumbs: scrolled.crumbs },
  );
  check(
    '吸顶条高度跟随标题自然高度',
    Math.abs(scrolled.barHeight - (scrolled.cloneHeight + 16)) <= 2,
    { barHeight: scrolled.barHeight, cloneHeight: scrolled.cloneHeight },
  );
  check('大纲包含全部正文标题', scrolled.rows === EXPECTED_HEADINGS, scrolled.rows);
  const stickyState = await page.evaluate(() => {
    const sticky = document.querySelector('.sticky-toolbar');
    const rail = document.querySelector('.left-rail');
    return {
      stickyTop: sticky ? Math.round(sticky.getBoundingClientRect().top) : null,
      railWidth: rail ? Math.round(rail.getBoundingClientRect().width) : null,
    };
  });
  check(
    '正文粘性元素与固定侧栏不会把吸顶条带偏',
    stickyState.stickyTop === 0 && scrolled.top === TOPBAR_HEIGHT,
    { ...stickyState, barTop: scrolled.top },
  );
  check(
    '吸顶条文字与正文列对齐',
    scrolled.crumbLeft !== null &&
      scrolled.articleLeft !== null &&
      Math.abs(scrolled.crumbLeft - scrolled.articleLeft) <= 2,
    { crumbLeft: scrolled.crumbLeft, articleLeft: scrolled.articleLeft },
  );

  // 克隆出来的标题必须和页面里那个标题渲染得一模一样
  const fidelity = await page.evaluate(() => {
    const shadow = document.getElementById('__web_sticky_scroll_host__').shadowRoot;
    const clone = shadow.querySelector('[data-wss-clone="true"]');
    const source = [...document.querySelectorAll('h1,h2,h3,h4')].find(
      (node) => node.textContent.trim() === clone?.textContent?.trim(),
    );
    const snapshot = (element) => {
      const style = getComputedStyle(element);
      return [style.fontSize, style.fontWeight, style.lineHeight, style.color, style.fontFamily].join(' | ');
    };
    return { clone: snapshot(clone), source: snapshot(source), match: snapshot(clone) === snapshot(source) };
  });
  check('吸顶条标题与页面同款样式', fidelity.match, fidelity);

  // 吸顶时机不变式：条里显示的标题，必须已经滑到条的后面
  // （向下滚不会提前显示还露在下面的标题；回滚时上级标题一露头就会交接）
  const timingScan = await page.evaluate(async () => {
    const shadow = document.getElementById('__web_sticky_scroll_host__').shadowRoot;
    // 用吸顶区顶部（站点顶栏下方）而不是入场动画途中的实际位置
    const barTop = () => Math.round(shadow.querySelector('.wss-root').style.getPropertyValue('--wss-top').replace('px', '')) || 0;
    const visible = () => shadow.querySelector('.wss-root').dataset.visible === 'true';
    const cloneText = () =>
      shadow.querySelector('[data-wss-clone="true"]')?.textContent?.trim() ?? null;
    const source = (text) =>
      [...document.querySelectorAll('h1,h2,h3,h4')].find((node) => node.textContent.trim() === text);
    const frame = () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );

    const samples = [];
    const violations = [];
    const inspect = () => {
      if (!visible()) return;
      const text = cloneText();
      const node = text ? source(text) : null;
      if (!node) return;
      const delta = Math.round(node.getBoundingClientRect().top - barTop());
      samples.push(delta);
      // delta > 0 表示这个标题还露在条下面 —— 不该已经显示在条里
      if (delta > 24) {
        violations.push({
          text: text.slice(0, 10),
          tag: node.tagName,
          delta,
          top: Math.round(node.getBoundingClientRect().top),
          barTop: Math.round(barTop()),
          barHeight: Math.round(shadow.querySelector('.wss-bar').getBoundingClientRect().height),
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
      violations,
    };
  });
  check(
    '条里只显示已经滑到条后面的标题（向下不提前 / 回滚不赖着下级）',
    timingScan.samples > 50 && timingScan.violations.length === 0,
    timingScan,
  );

  // 整篇阅读进度：随滚动单调增长，读到文末接近 100%
  const readProgress = () =>
    page.evaluate(() => {
      const shadow = document.getElementById('__web_sticky_scroll_host__').shadowRoot;
      const fill = shadow.querySelector('.wss-progress > i');
      return Number.parseFloat(fill?.style.width ?? '0');
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
  const progressTrack = await page.evaluate(() => {
    const shadow = document.getElementById('__web_sticky_scroll_host__').shadowRoot;
    const bar = shadow.querySelector('.wss-bar').getBoundingClientRect();
    const track = shadow.querySelector('.wss-progress').getBoundingClientRect();
    return { bar: [Math.round(bar.left), Math.round(bar.right)], track: [Math.round(track.left), Math.round(track.right)] };
  });
  check(
    '进度条通栏贴在条底部，不像标题下划线',
    progressTrack.bar[0] === progressTrack.track[0] && progressTrack.bar[1] === progressTrack.track[1],
    progressTrack,
  );

  // 原站目录可见时退让：只显示当前小节，且悬停不弹抽屉
  const barPoint = await page.evaluate(() => {
    const rect = document
      .getElementById('__web_sticky_scroll_host__')
      .shadowRoot.querySelector('.wss-bar-inner')
      .getBoundingClientRect();
    return { x: rect.left + 240, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(barPoint.x, barPoint.y);
  await page.waitForTimeout(400);
  const withToc = await probe(page);
  check('识别到原站目录后退让', withToc.compact === 'true', withToc);
  check('退让模式不弹重复目录', withToc.drawerOpen === false, withToc.drawerOpen);

  // 大纲面板结构（产品化）与「点击钉住」
  const outlinePanel = await page.evaluate(() => {
    const shadow = document.getElementById('__web_sticky_scroll_host__').shadowRoot;
    return {
      title: shadow.querySelector('.wss-drawer-title')?.textContent ?? '',
      progress: shadow.querySelector('.wss-drawer-progress')?.textContent ?? '',
      nestedLevels: shadow.querySelectorAll('.wss-outline-level[data-depth]').length,
      rows: shadow.querySelectorAll('.wss-row').length,
    };
  });
  check(
    '大纲面板结构完整（标题 / 进度 / 层级）',
    outlinePanel.title === '文章目录' &&
      outlinePanel.nestedLevels >= 1 &&
      outlinePanel.rows === EXPECTED_HEADINGS &&
      /%$/.test(outlinePanel.progress),
    outlinePanel,
  );

  // 关掉原站目录 → 恢复完整功能，并停在三级标题深处
  await page.mouse.move(10, 600);
  await page.evaluate(() => {
    document.getElementById('site-toc').hidden = true;
  });
  await page.waitForTimeout(2200);
  await page.evaluate(() => {
    const heading = document.getElementById('s2-1');
    window.scrollTo(0, heading.getBoundingClientRect().top + window.scrollY - 60);
  });
  await page.waitForTimeout(600);
  await page.mouse.move(barPoint.x, barPoint.y);
  await page.waitForTimeout(400);
  const restored = await probe(page);
  check(
    '原站目录消失后恢复完整功能',
    restored.compact === 'false' && restored.drawerOpen === true && restored.drawerPath.length >= 1,
    restored,
  );

  // 点击标题 → 钉住目录；点击界面之外 → 取消钉住
  await page.evaluate(() => {
    document
      .getElementById('__web_sticky_scroll_host__')
      .shadowRoot.querySelector('.wss-bar-heading')
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
  check('点击标题可以钉住目录', pinnedState.open === true && pinnedState.pinned === 'true', pinnedState);

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

  // 重新悬停打开，点击第一级（祖先小节）：落点停在吸顶条下方
  await page.mouse.move(barPoint.x, barPoint.y);
  await page.waitForTimeout(400);
  const reopened = await probe(page);
  check('移开后再悬停可重新打开目录', reopened.drawerOpen === true, reopened.drawerOpen);
  const clickedText = reopened.drawerPath[0];
  await page.evaluate(() => {
    const shadow = document.getElementById('__web_sticky_scroll_host__').shadowRoot;
    shadow.querySelector('.wss-drawer-path .wss-crumb').click();
  });
  // 落点期望值由插件自己写在 scroll-margin-top 上（按目标标题的停靠位置算）
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
    const clone = shadow.querySelector('[data-wss-clone="true"]');
    return {
      clicked: text,
      top: Math.round(heading?.getBoundingClientRect().top ?? -1),
      shown: clone?.textContent?.trim() ?? null,
    };
  }, clickedText);
  check(
    '点击回溯落点准确',
    expectedLanding !== null && Math.abs(landed.top - expectedLanding) <= 6,
    { ...landed, expectedLanding, readingLine: READING_LINE },
  );
  check('跳转后吸顶标题跟随目标小节', landed.shown === landed.clicked, landed);
  const afterJump = await probe(page);
  check('跳转后吸顶条保持可见', afterJump.visible === 'true', afterJump);

  // options：切显示策略为智能、形态切回胶囊 → 页面实时响应
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await options.waitForTimeout(500);
  await page.bringToFront();
  const optionsState = await options.evaluate(() => ({
    sections: document.querySelectorAll('section h2').length,
    appearance: document.querySelector('#appearance')?.value,
    hideTitle: document.querySelector('#hideArticleTitle')?.checked,
  }));
  check('options 正常渲染', optionsState.sections >= 4 && optionsState.appearance === 'bar', optionsState);

  await options.selectOption('#appearance', 'pill');
  await options.selectOption('#displayPolicy', 'smart');
  await options.waitForTimeout(700);
  const switched = await probe(page);
  check(
    '切换形态实时生效',
    switched.appearance === 'pill' &&
      Math.abs(switched.top - (TOPBAR_HEIGHT + 10)) <= 1 &&
      switched.crumbs.length >= 1,
    switched,
  );

  // 智能策略：向上滚动让位
  await page.mouse.move(10, 600);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(400);
  const scrolledUp = await probe(page);
  check('智能策略向上滚动收起', scrolledUp.visible === 'false', scrolledUp);

  // 吸顶条可以切成与正文列同宽
  await options.selectOption('#appearance', 'bar');
  await options.selectOption('#barWidth', 'column');
  await page.mouse.wheel(0, 700);
  await options.waitForTimeout(700);
  const columnBar = await page.evaluate(() => {
    const shadow = document.getElementById('__web_sticky_scroll_host__').shadowRoot;
    const bar = shadow.querySelector('.wss-bar').getBoundingClientRect();
    const article = document.querySelector('article').getBoundingClientRect();
    return {
      visible: shadow.querySelector('.wss-root').dataset.visible,
      bar: [Math.round(bar.left), Math.round(bar.right)],
      article: [Math.round(article.left), Math.round(article.right)],
    };
  });
  check(
    '吸顶条可切成与正文列同宽',
    columnBar.visible === 'true' &&
      Math.abs(columnBar.bar[0] - columnBar.article[0]) <= 2 &&
      Math.abs(columnBar.bar[1] - columnBar.article[1]) <= 2,
    columnBar,
  );

  check('运行期间没有页面报错', pageErrors.length === 0, pageErrors);

  // popup：状态 + 一键在站点禁用
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await page.bringToFront();
  // 重新加载后台标签里的弹窗：此时活动标签页已是被测页面
  await popup.reload();
  await popup.waitForTimeout(700);
  const popupState = await popup.evaluate(() => ({
    title: document.querySelector('h1')?.textContent ?? '',
    policy: document.querySelector('#displayPolicy')?.value ?? '',
    appearance: document.querySelector('#appearance')?.value ?? '',
    siteButtonDisabled: document.querySelector('#site')?.disabled ?? true,
  }));
  check('popup 正常渲染', popupState.title.includes('顶阅'), popupState);
  check('popup 能读到当前站点', popupState.siteButtonDisabled === false, popupState);

  await popup.evaluate(() => document.querySelector('#site').click());
  await popup.waitForTimeout(900);
  const disabled = await page.evaluate(() => ({
    hostExists: !!document.getElementById('__web_sticky_scroll_host__'),
  }));
  check('在站点上禁用后立即退出', disabled.hostExists === false, disabled);
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
