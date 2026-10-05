import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 仓库根 = apps/web/../..
const repoRoot = path.resolve(__dirname, '../..')
// 编译产物：仓库同级目录（可被 .env 的 BUILD_OUT_DIR 覆盖）
const outDir = path.resolve(repoRoot, process.env.BUILD_OUT_DIR || '../招聘agent-build', 'web')

export default defineConfig({
  plugins: [react()],
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: Number(process.env.WEB_PORT) || 5173,
    // 开发期把 /api 转发到本地后端，避免跨域
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.SERVER_PORT || 8787}`,
        changeOrigin: true,
      },
    },
  },
  // 让 @ria/shared 这类 workspace 源码包直接参与编译
  optimizeDeps: {
    exclude: ['@ria/shared'],
  },
})
