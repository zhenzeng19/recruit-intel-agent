// 启动编译产物（一条命令跑起整个应用：API + 前端看板）
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { loadEnv, resolveOutDir } from './load-env.mjs'

// 必须先读 .env —— 否则改了 BUILD_OUT_DIR / SERVER_PORT 这个脚本视而不见
loadEnv()

const outDir = resolveOutDir()
const entry = path.join(outDir, 'server', 'index.js')

if (!fs.existsSync(entry)) {
  console.error(`\n✗ 未找到产物：${entry}`)
  console.error('  请先执行： npm run build\n')
  process.exit(1)
}

const port = process.env.SERVER_PORT || '8787'
console.log(`启动产物：${entry}`)
console.log(`监听端口：${port}`)
if (!fs.existsSync(path.join(outDir, 'web', 'index.html'))) {
  console.warn('⚠ 未找到前端产物，本次只提供 API。请执行 npm run build 后重试。')
}

const child = spawn(process.execPath, [entry], {
  stdio: 'inherit',
  // 服务端读的是 SERVER_PORT（不是 PORT）—— 早先这里传的是 PORT，等于没传
  env: { ...process.env, SERVER_PORT: port },
})

child.on('exit', (code) => process.exit(code ?? 0))
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig))
}
