/** Build the store ZIP and run manifest sanity checks. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const RELEASE = join(ROOT, 'release');

if (!existsSync(join(DIST, 'manifest.json'))) {
  console.error('✗ dist/manifest.json 不存在，请先 npm run build');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'));
const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const problems = [];
const notes = [];

if (manifest.version !== packageJson.version) {
  problems.push(`manifest.version(${manifest.version}) 与 package.json(${packageJson.version}) 不一致`);
}

if (existsSync(join(DIST, 'service-worker-loader.js'))) {
  problems.push('stale CRXJS service-worker-loader.js is present');
}

for (const locale of ['en', 'zh_CN']) {
  const file = join(DIST, '_locales', locale, 'messages.json');
  if (!existsSync(file)) problems.push(`missing locale catalog: ${locale}`);
}

const referenced = [
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
  manifest.action?.default_popup,
  ...(manifest.content_scripts ?? []).flatMap((entry) => entry.js ?? []),
].filter((value) => typeof value === 'string');
for (const file of referenced) {
  if (!existsSync(join(DIST, file))) problems.push(`manifest 引用的文件不存在: ${file}`);
}

const bundled = execFileSync(
  'bash',
  ['-lc', `find ${DIST} -type f \\( -name '*.js' -o -name '*.html' -o -name '*.css' \\)`],
  { encoding: 'utf8' },
)
  .trim()
  .split('\n')
  .filter(Boolean);
const remoteHint = /https?:\/\/(?!localhost|127\.0\.0\.1|www\.w3\.org\/)/;
for (const file of bundled) {
  const content = readFileSync(file, 'utf8');
  if (/\beval\s*\(/.test(content)) problems.push(`${file} 里出现了 eval()`);
  if (remoteHint.test(content)) {
    notes.push(`${file.replace(ROOT + '/', '')} 含外部 URL（确认只是文案/链接，不是远程代码）`);
  }
}

if (problems.length > 0) {
  console.error('✗ 打包前自检未通过:\n- ' + problems.join('\n- '));
  process.exit(1);
}

mkdirSync(RELEASE, { recursive: true });
const zipPath = join(RELEASE, `web-sticky-scroll-${manifest.version}.zip`);
execFileSync('zip', ['-r', '-q', '-FS', zipPath, '.'], { cwd: DIST });

const size = (statSync(zipPath).size / 1024).toFixed(0);
console.log(`✓ 打包完成: ${zipPath} (${size} KB)`);
console.log(`  版本: ${manifest.version} · 打包文件数: ${bundled.length}`);
if (notes.length > 0) console.log('  提示:\n  - ' + notes.join('\n  - '));
console.log(`
接下来：Chrome 应用商店 → 开发者信息中心 → 新建项目 → 上传这个 zip
商店文案、截图、隐私说明都在 store/ 目录（见 store/listing.md）`);
