// 统一构建入口：依次编译 web / server / extension，
// 全部产物集中输出到 BUILD_OUT_DIR（默认 ../招聘agent-build）。
import { execSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { loadEnv, repoRoot, resolveOutDir } from './load-env.mjs'

loadEnv()

const outDir = resolveOutDir()

const run = (cmd) => {
  console.log(`\n\x1b[36m> ${cmd}\x1b[0m`)
  execSync(cmd, { cwd: repoRoot, stdio: 'inherit', env: process.env })
}

function printTree(dir, prefix = '') {
  if (!fs.existsSync(dir)) return
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  entries.forEach((e, i) => {
    const last = i === entries.length - 1
    const size = e.isFile() ? `  ${(fs.statSync(path.join(dir, e.name)).size / 1024).toFixed(1)} KB` : ''
    console.log(`${prefix}${last ? '└─ ' : '├─ '}${e.name}${size}`)
    if (e.isDirectory()) printTree(path.join(dir, e.name), `${prefix}${last ? '   ' : '│  '}`)
  })
}

try {
  run('npm -w @ria/web run build')
  run('npm -w @ria/server run build')
  run('npm -w @ria/extension run build')
  console.log(`\n\x1b[32m✓ 编译完成。产物目录：${outDir}\x1b[0m`)
  printTree(outDir)
  console.log(`\n\x1b[36m启动方式： npm run start   然后打开 http://localhost:${process.env.SERVER_PORT || 8787}/\x1b[0m`)
} catch {
  console.error('\n\x1b[31m✗ 构建失败\x1b[0m')
  process.exit(1)
}
