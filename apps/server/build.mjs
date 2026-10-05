// 后端构建：esbuild 打包成单文件 ESM，输出到 BUILD_OUT_DIR/server/
import esbuild from 'esbuild'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')
const outDir = path.resolve(repoRoot, process.env.BUILD_OUT_DIR || '../招聘agent-build', 'server')

fs.mkdirSync(outDir, { recursive: true })

await esbuild.build({
  entryPoints: [path.join(__dirname, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: path.join(outDir, 'index.js'),
  sourcemap: true,
  // 依赖一并打进产物：产物自包含，部署时无需再 npm install
  packages: 'bundle',
  banner: {
    js: [
      "import { createRequire as __cr } from 'node:module';",
      "const require = __cr(import.meta.url);",
    ].join('\n'),
  },
})

console.log(`server  ->  ${path.join(outDir, 'index.js')}`)
