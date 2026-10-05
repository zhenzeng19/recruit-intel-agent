// ============================================================
// 运行时 .env 加载器
// ------------------------------------------------------------
// 说明：Node 不会自动读取 .env。构建脚本 scripts/build.mjs 里已有一份加载逻辑，
//       但那只作用于「构建期」。服务启动时（尤其是开发态直接跑 TS 源码）也需要
//       读到 DATA_DIR / SERVER_PORT / LLM_* 等配置，所以这里再补一份运行时的。
//
// 查找方式：从启动目录向上逐级找 .env（最多 8 层）。
//   - 开发态：apps/server/src → 命中仓库根 招聘agent/.env
//   - 产物态：招聘agent-build/server → 祖先里没有仓库根，找不到 .env，
//             此时的数据目录由 resolveDataDir 的「产物形态」分支兜底，无需配置。
// 已存在的环境变量优先，不被 .env 覆盖。
// ============================================================
import fs from 'node:fs'
import path from 'node:path'

function findEnvFile(startDir: string): string | null {
  let dir = startDir
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, '.env')
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

export function loadEnvFile(startDir: string): string | null {
  const file = findEnvFile(startDir)
  if (!file) return null

  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m) continue
    const [, key, value] = m
    if (process.env[key] === undefined) {
      process.env[key] = value.replace(/^["']|["']$/g, '')
    }
  }
  return file
}
