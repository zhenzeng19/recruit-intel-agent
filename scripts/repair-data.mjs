// ============================================================
// 历史采集数据的修复工具（维护脚本，不在正常运行时链路里）
// ------------------------------------------------------------
// 解决的问题：
//   采集端的提取逻辑改好之后，**已经入库**的简历不会自动变好 ——
//   姓名还是「查看大图」、同一个人还占着两条档案、没有岗位匹配所以沉在列表最底。
//   这个脚本用当前的真实代码把这些历史数据重跑一遍：
//
//     · 按「归一化身份（姓名 + 工作/教育背景）」合并重复档案，来源记录一并迁移
//     · 用现在的 parseResumeText 重跑字段粗提取（姓名 / 城市 / 学历 / 手机号 / 邮箱 …）
//     · 给仍然没有岗位匹配的候选人补一次规则匹配
//
// 默认 dry-run，只打印将要做的改动；加 --write 才真正落盘。
// 落盘前会自动把四张表备份到 <数据目录>/_backup/<时间戳>/。
//
// 用法：
//   node scripts/repair-data.mjs                 # 预览（默认，不改任何东西）
//   node scripts/repair-data.mjs --write         # 真正执行（自动备份）
//   node scripts/repair-data.mjs --data-dir D:/xxx --write
// ============================================================
import esbuild from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadEnv, repoRoot, resolveDataDirPath } from './load-env.mjs'

const args = process.argv.slice(2)
const WRITE = args.includes('--write')
const dirArgIdx = args.indexOf('--data-dir')

// 读 .env 才能让 DATA_DIR 生效 —— 否则改了 DATA_DIR 后这个脚本会去操作另一个
// 数据目录（它直接改文件，搞错目录是要坏数据的）。--data-dir 仍然最优先。
loadEnv()
const DATA_DIR = path.resolve(dirArgIdx >= 0 ? args[dirArgIdx + 1] : resolveDataDirPath())

// ---------------------------------------------------------- 打包真实源码
const outFile = path.join(os.tmpdir(), `ria-repair-${Date.now()}.mjs`)
await esbuild.build({
  entryPoints: [path.join(repoRoot, 'apps/server/src/db/store.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  alias: { '@ria/shared': path.join(repoRoot, 'packages/shared/src/index.ts') },
  logLevel: 'warning',
})
const { JsonStore, parseResumeText, stripResumeChrome } = await import(pathToFileURL(outFile).href)
process.on('exit', () => {
  try {
    fs.rmSync(outFile, { force: true })
  } catch {
    /* ignore */
  }
})

const log = (...a) => console.log(...a)
const warn = (...a) => console.log('  !', ...a)

if (!fs.existsSync(DATA_DIR)) {
  console.error(`\n✗ 数据目录不存在：${DATA_DIR}`)
  console.error('  用 --data-dir 指定，或先启动一次服务让它自动创建。\n')
  process.exit(1)
}

log(`\n=== 采集数据修复 ${WRITE ? '【执行模式】' : '【预览模式，不会改动任何数据】'} ===`)
log(`数据目录：${DATA_DIR}\n`)

const store = new JsonStore(DATA_DIR)
const db = store.db

log('【0】剥掉正文尾部的 UI 操作区（配额计数 / 按钮 / 操作记录）')
// 为什么必须先做这一步：
//   ① 这些行会印进导出的 PDF（「剩10次权益」这种东西不该给业务部门看）；
//   ② 更要命的是它们会扰动**内容指纹** —— `剩N次权益`、`本月剩余N次` 随账号权益
//      余额变化，于是同一份简历隔几天再采就算出一个新指纹 → 又存一条重复档案。
//   所以清洗要放在「重跑字段」与「合并重复」之前，让后面的判据都基于干净正文。
let cleaned = 0
for (const c of db.candidates) {
  const before = c.resumeText || ''
  const after = stripResumeChrome(before)
  if (after === before) continue
  log(`  · ${c.id}（${c.name}）${before.length} → ${after.length} 字`)
  c.resumeText = after
  cleaned++
}
if (cleaned === 0) log('  （没有需要清洗的正文）')
log(`  合计清洗 ${cleaned} 条\n`)

// ---------------------------------------------------------- 1. 重跑字段粗提取
// 必须放在「合并重复」之前：合并是按「姓名 + 公司/学校」分组的，
// 而历史数据的姓名还是被按钮顶掉的「查看大图」「意向沟通」——
// 先合并的话，同一个人因为名字不同会被分成好几组，一条都合不掉。
log('【1】按当前的规则重跑字段粗提取（只动「未过大模型」的原始简历）')
let reparsed = 0
for (const c of db.candidates) {
  if (c.parseState !== 'raw') continue
  const next = parseResumeText(c.resumeText || '')
  const changed = Object.entries(next).filter(([k, v]) => v !== undefined && c[k] !== v)
  if (changed.length === 0) continue
  log(`  · ${c.id}`)
  for (const [k, v] of changed) {
    log(`      ${k}: ${JSON.stringify(c[k])} → ${JSON.stringify(v)}`)
    c[k] = v
  }
  reparsed++
}
if (reparsed === 0) log('  （没有需要修正的字段）')
log(`  合计修正 ${reparsed} 条\n`)

// ---------------------------------------------------------- 2. 合并重复档案
/**
 * 归一化身份：姓名 + 工作/教育相关的行。
 * 同一份简历在不同时间抓取，容器边界会变（多一个按钮、多一行手机号），
 * 但姓名和他待过的公司/学校不会变 —— 用它当合并判据。
 */
function identityOf(candidate) {
  const text = (candidate.resumeText || '').replace(/\r/g, '')
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const name = candidate.name && candidate.name !== '未识别姓名' ? candidate.name : ''
  const orgs = lines
    .filter((l) => /(有限公司|股份有限公司|集团|研究院|大学|学院|科技|电子|半导体|光电)/.test(l))
    .map((l) => l.replace(/[（(].*?[)）]/g, '').replace(/\s+/g, ''))
    .slice(0, 3)
  if (!name && orgs.length === 0) return null
  return `${name}|${orgs.join('/')}`
}

log('【2】重复档案合并')
const groups = new Map()
for (const c of db.candidates) {
  const key = identityOf(c)
  if (!key) continue
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key).push(c)
}

let mergeCount = 0
for (const [key, list] of groups) {
  if (list.length < 2) continue
  // 保留正文最长的那条（信息最全），其余合并进去
  const sorted = [...list].sort((a, b) => (b.resumeText || '').length - (a.resumeText || '').length)
  const keep = sorted[0]
  const drops = sorted.slice(1)
  log(`  · ${key}`)
  log(`      保留 ${keep.id}（${(keep.resumeText || '').length} 字）`)
  for (const d of drops) {
    log(`      合并 ${d.id}（${(d.resumeText || '').length} 字）→ 来源迁移至保留记录`)
    for (const s of db.sources) if (s.candidateId === d.id) s.candidateId = keep.id
    for (const m of db.matches) if (m.candidateId === d.id) m.candidateId = keep.id
    db.candidates = db.candidates.filter((c) => c.id !== d.id)
    mergeCount++
  }
}
if (mergeCount === 0) log('  （没有发现重复）')
log(`  合计合并 ${mergeCount} 条\n`)

// ---------------------------------------------------------- 3. 补岗位匹配
log('【3】给还没有岗位匹配的候选人补一次规则匹配')
const matchedIds = new Set(db.matches.map((m) => m.candidateId))
const unmatched = db.candidates.filter((c) => !matchedIds.has(c.id))
for (const c of unmatched) log(`  · ${c.name}（${c.id}）当前没有岗位匹配`)
log(`  待补匹配 ${unmatched.length} 人\n`)

// ---------------------------------------------------------- 4. 落盘
if (!WRITE) {
  log('预览结束。确认无误后加 --write 执行（会自动备份数据目录）。\n')
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
// 备份放在数据目录内部的 _backup/ 下，而不是数据目录的旁边：
//   ① 自包含 —— 备份跟着数据走，整个数据目录挪走/拷走时备份一起带走
//   ② 不污染仓库同级目录，也不会在某些受限环境下因为「在工作区外新建目录」而失败
// JsonStore 只按表名读 candidates/positions/matches/sources 这几个文件，子目录会被忽略。
const backupDir = path.join(DATA_DIR, '_backup', stamp)
fs.mkdirSync(backupDir, { recursive: true })
for (const name of ['candidates.json', 'positions.json', 'matches.json', 'sources.json']) {
  const src = path.join(DATA_DIR, name)
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backupDir, name))
}
log(`已备份原数据 → ${backupDir}`)

const res = store.rematchUnmatched()
log(`已补岗位匹配：${res.matched} 人`)
store.save()
log(`已写回数据目录：${DATA_DIR}\n`)
