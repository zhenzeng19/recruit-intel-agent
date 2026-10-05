// 把渲染冒烟测试打成一个可在 Node 里跑的 ESM 文件
import esbuild from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

await esbuild.build({
  entryPoints: [path.join(__dirname, 'render.tsx')],
  outfile: path.join(__dirname, 'out.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  jsx: 'automatic',
  absWorkingDir: root,
  alias: { '@ria/shared': path.join(root, 'packages/shared/src/index.ts') },
  loader: { '.css': 'empty' },
  logLevel: 'warning',
  // react-dom/server 是 CJS，内部 require('stream')；打成 ESM 后需要这个 shim
  banner: {
    js: [
      "import { createRequire as __cr } from 'node:module';",
      'const require = __cr(import.meta.url);',
    ].join('\n'),
  },
})
console.log('smoke bundle ->', path.join(__dirname, 'out.mjs'))
