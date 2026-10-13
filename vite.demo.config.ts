import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// 仅用于本地预览 / 自测：把 demo/index.html 当成普通网页构建，
// 页面里直接以 ES Module 方式加载 src/content/index.ts，便于在浏览器中验证交互。
export default defineConfig({
  root: fileURLToPath(new URL('./demo', import.meta.url)),
  base: './',
  build: {
    outDir: fileURLToPath(new URL('./demo-dist', import.meta.url)),
    emptyOutDir: true,
  },
});
