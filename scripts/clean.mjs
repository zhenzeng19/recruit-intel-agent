// 清空编译产物目录
import fs from 'node:fs'
import { loadEnv, resolveOutDir } from './load-env.mjs'

// 必须先读 .env —— 否则改了 BUILD_OUT_DIR 后这里清的是另一个目录
loadEnv()

const outDir = resolveOutDir()

if (fs.existsSync(outDir)) {
  fs.rmSync(outDir, { recursive: true, force: true })
  console.log(`已清空产物目录：${outDir}`)
} else {
  console.log(`产物目录不存在，无需清理：${outDir}`)
}
