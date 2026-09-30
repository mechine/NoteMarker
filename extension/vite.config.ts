import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import manifest from './src/manifest'

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    // 关闭 Vite 的 modulepreload polyfill：扩展的隔离世界会对其报
    // "cross-world extension resource mismatch" 警告（纯噪音，本地加载也无预加载收益）
    modulePreload: false,
    rollupOptions: {
      // 按需注入的 content script（content.js / highlighter.js）不走 vite/rollup：
      // 多入口会把共享模块拆成 ES chunk，而 executeScript 需要自包含经典脚本（IIFE）。
      // 它们由 package.json 的 build 脚本经 esbuild 单独产出到 dist/（各自全量内联）。
    },
  },
})
