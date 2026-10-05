// 扩展构建：background / content / popup 各自打成 IIFE，静态资源直接拷贝
// 输出到 BUILD_OUT_DIR/extension/，该目录即为「加载已解压的扩展程序」的目标
import esbuild from 'esbuild'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')
const outDir = path.resolve(repoRoot, process.env.BUILD_OUT_DIR || '../招聘agent-build', 'extension')

fs.mkdirSync(outDir, { recursive: true })

const common = {
  bundle: true,
  platform: 'browser',
  target: 'chrome120',
  format: 'iife',
  sourcemap: true,
  logLevel: 'info',
  // 后端地址在构建期注入（来自 .env 的 VITE_API_BASE），部署时改这里即可
  define: {
    __API_BASE__: JSON.stringify(process.env.VITE_API_BASE || 'http://localhost:8787'),
  },
}

// 三个入口脚本
for (const entry of ['background', 'content', 'popup']) {
  await esbuild.build({
    ...common,
    entryPoints: [path.join(__dirname, `src/${entry}.ts`)],
    outfile: path.join(outDir, `${entry}.js`),
  })
}

// 静态文件：manifest / popup.html / 图标
for (const f of ['manifest.json', 'popup.html']) {
  fs.copyFileSync(path.join(__dirname, f), path.join(outDir, f))
}

const iconSrc = path.join(__dirname, 'icons')
const iconDst = path.join(outDir, 'icons')
if (fs.existsSync(iconSrc)) {
  fs.mkdirSync(iconDst, { recursive: true })
  for (const f of fs.readdirSync(iconSrc)) {
    fs.copyFileSync(path.join(iconSrc, f), path.join(iconDst, f))
  }
} else {
  console.warn('⚠ 未找到 icons/ 目录，请先运行：node apps/extension/tools/make-icons.mjs')
}

console.log(`extension  ->  ${outDir}`)
