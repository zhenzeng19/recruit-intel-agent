// ============================================================
// 仓库根 .env 的读取 —— build / start / clean / repair-data 共用
// ------------------------------------------------------------
// 为什么抽出来：这四个脚本原本各写一份（或干脆没写），结果只有 build.mjs
// 真的读了 .env。于是「改了 BUILD_OUT_DIR / DATA_DIR 却没生效」——
// build 往新目录写、clean 和 start 还盯着默认目录，
// repair-data 甚至会去操作另一个数据目录。同一份配置必须只有一个读法。
// ============================================================
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根目录（scripts/ 的上一级） */
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 读取仓库根 .env 并写进 process.env。
 * 已存在的环境变量优先 —— 命令行 / shell 显式传的不会被 .env 覆盖。
 *
 * @returns {string | null} .env 的绝对路径；文件不存在时返回 null
 */
export function loadEnv() {
  const envPath = path.join(repoRoot, '.env')
  if (!fs.existsSync(envPath)) return null

  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m) continue
    const [, key, value] = m
    if (process.env[key] === undefined) {
      process.env[key] = value.replace(/^["']|["']$/g, '')
    }
  }
  return envPath
}

/**
 * 编译产物目录（默认仓库同级的 招聘agent-build）。
 * 必须在 loadEnv() 之后调用，否则读不到 .env 里的 BUILD_OUT_DIR。
 */
export function resolveOutDir() {
  return path.resolve(repoRoot, process.env.BUILD_OUT_DIR || '../招聘agent-build')
}

/**
 * 运行时数据目录（默认仓库同级的 招聘agent-data）。
 * 必须在 loadEnv() 之后调用。
 */
export function resolveDataDirPath() {
  const value = (process.env.DATA_DIR || '../招聘agent-data').trim()
  return path.isAbsolute(value) ? value : path.resolve(repoRoot, value)
}
