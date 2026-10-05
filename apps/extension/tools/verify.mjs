// 扩展产物完整性自检
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = process.argv[2] || 'E:/zzl_workbuddy_datas/招聘agent-build/extension'
process.chdir(dir)

let bad = 0
const m = JSON.parse(fs.readFileSync('manifest.json', 'utf8'))
console.log(`manifest v${m.manifest_version}  |  ${m.name}  |  ${m.version}`)

const need = []
need.push(m.background.service_worker)
;(m.content_scripts || []).forEach((cs) => cs.js.forEach((j) => need.push(j)))
if (m.action.default_popup) need.push(m.action.default_popup)
Object.values(m.icons || {}).forEach((p) => need.push(p))
Object.values(m.action.default_icon || {}).forEach((p) => need.push(p))

console.log('--- 引用文件检查 ---')
for (const f of [...new Set(need)]) {
  const ok = fs.existsSync(f)
  if (!ok) bad++
  console.log(`  ${ok ? 'OK  ' : 'MISS'}  ${f}`)
}

console.log('--- 权限 ---')
console.log('  permissions: ' + (m.permissions || []).join(', '))
console.log('  含 alarms: ' + ((m.permissions || []).includes('alarms') ? '是' : '否 ← background 定时重试会失效'))
console.log('  host_permissions: ' + (m.host_permissions || []).join(', '))

// ---------------------------------------------------------------
// 域名覆盖校验
// 这是本次「扩展装了却没采到」事故的根因所在：manifest 里只写了
// www.liepin.com，而 HR 实际用的猎聘企业端在 lpt.liepin.com —— 子域没覆盖，
// content script 压根不会注入，而且没有任何报错，极难发现。
// 所以这里拿真实页面 URL 去跑一遍 match pattern，不匹配就红。
// ---------------------------------------------------------------
function matchPattern(pattern, url) {
  const m = /^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/.exec(pattern)
  if (!m) return false
  const [, pScheme, pHost, pPath] = m
  let u
  try {
    u = new URL(url)
  } catch {
    return false
  }
  const uScheme = u.protocol.replace(':', '')
  if (pScheme !== '*' && pScheme !== uScheme) return false

  const uHost = u.hostname.toLowerCase()
  const uHostPort = u.host.toLowerCase()
  const ph = pHost.toLowerCase()
  if (ph !== '*') {
    if (ph.includes(':')) {
      // pattern 指定了端口（如 http://localhost:8787/*）→ 必须连端口一起精确匹配
      if (ph !== uHostPort) return false
    } else if (ph.startsWith('*.')) {
      const base = ph.slice(2)
      // Chrome 的 *.example.com 覆盖 example.com 本身及其所有子域
      if (uHost !== base && !uHost.endsWith('.' + base)) return false
    } else if (ph !== uHost) {
      return false
    }
  }

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp('^' + pPath.split('*').map(esc).join('[\\s\\S]*') + '$')
  return re.test(u.pathname + u.search)
}
const coveredBy = (patterns, url) => (patterns || []).some((p) => matchPattern(p, url))

const CS_URLS = (m.content_scripts || []).flatMap((cs) => cs.matches || [])
const HP = m.host_permissions || []

const CASES = [
  { url: 'https://lpt.liepin.com/chat/im?jobId=85838997&jobKind=2&tab=message#preview', need: true, note: '猎聘企业端 IM 页 ← 本次线上问题' },
  { url: 'https://www.liepin.com/resume/123456', need: true, note: '猎聘主站简历页' },
  { url: 'https://h.liepin.com/chat/index', need: true, note: '猎聘其他企业端子域' },
  { url: 'https://www.zhipin.com/web/chat/index', need: true, note: 'BOSS 企业端聊天页' },
  { url: 'https://www.zhipin.com/web/geek/resume?geekId=abc', need: true, note: 'BOSS 简历页' },
  { url: 'https://example.com/', need: false, note: '无关站点不应注入' },
  { url: 'https://evil-liepin.com/', need: false, note: '相似域名不应注入' },
]

console.log('--- content_scripts 域名覆盖 ---')
console.log('  matches: ' + CS_URLS.join(', '))
let coverBad = 0
for (const c of CASES) {
  const hit = coveredBy(CS_URLS, c.url)
  const good = hit === c.need
  if (!good) coverBad++
  console.log(`  ${good ? '✓' : '✗'}  ${c.need ? '应覆盖' : '不应注入'}  ${c.note}`)
  if (!good) console.log(`       URL: ${c.url}`)
}
if (coverBad) bad += coverBad
if (coverBad) console.log('  ← 域名覆盖有问题，content script 会在这些页面上完全静默失效')

console.log('--- host_permissions 域名覆盖 ---')
for (const c of CASES.filter((x) => x.need)) {
  const hit = coveredBy(HP, c.url)
  if (!hit) bad++
  console.log(`  ${hit ? '✓' : '✗'}  ${c.note}`)
}
console.log(
  `  含 localhost 后端: ${coveredBy(HP, 'http://localhost:8787/api/health') ? '✓' : '✗'}` +
    `  |  含 127.0.0.1: ${coveredBy(HP, 'http://127.0.0.1:8787/api/health') ? '✓' : '✗'}`
)

console.log('--- 注入范围 ---')
const allFrames = (m.content_scripts || []).every((cs) => cs.all_frames === true)
const runAt = (m.content_scripts || []).map((cs) => cs.run_at).join(',')
console.log(`  all_frames: ${allFrames ? '✓ 已开启（简历常在内嵌 iframe 里）' : '✗ 未开启，iframe 内的简历采不到'}`)
console.log(`  run_at: ${runAt}`)
if (!allFrames) bad++

// esbuild 会把非 ASCII 转成 \uXXXX 转义，比对前先还原
const decode = (s) => s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))

console.log('--- popup ---')
const ph = fs.readFileSync('popup.html', 'utf8')
console.log('  popup.html 引用 popup.js: ' + (ph.includes('src="popup.js"') ? 'OK' : 'MISS'))
for (const k of ['立即同步', '打开看板', '清空本地队列', '诊断当前页', 'queue-num', 'backend-dot', 'err-box', 'diag-box']) {
  const hit = ph.includes(k)
  if (!hit) bad++
  console.log(`  ${hit ? '✓' : '✗'}  popup.html: ${k}`)
}
const pj = decode(fs.readFileSync('popup.js', 'utf8'))
for (const k of [
  'BOSS直聘',
  '猎聘',
  '当前页面不是',
  'btn-sync',
  'btn-open',
  'btn-clear',
  'btn-diag',
  'diag-box',
  'DIAGNOSE',
  'sendMessage',
  'GET_STATUS',
  'FLUSH_NOW',
  'CLEAR_QUEUE',
]) {
  const hit = pj.includes(k)
  if (!hit) bad++
  console.log(`  ${hit ? '✓' : '✗'}  popup.js: ${k}`)
}

// popup.js 引用的元素 ID 必须都存在于 popup.html，否则运行时会静默 null 崩溃
// 源码里统一走 `const $ = (id) => document.getElementById(id)`，所以两种写法都要覆盖
console.log('--- popup 元素 ID 对应关系 ---')
const ids = [
  ...new Set([
    ...[...pj.matchAll(/\$\(\s*"([A-Za-z0-9_-]+)"\s*\)/g)].map((m) => m[1]),
    ...[...pj.matchAll(/getElementById\(\s*"([A-Za-z0-9_-]+)"\s*\)/g)].map((m) => m[1]),
  ]),
].sort()
if (ids.length === 0) {
  bad++
  console.log('  ✗ 未从 popup.js 中解析出任何元素 ID（检查逻辑可能已失效）')
}
const missing = ids.filter((id) => !new RegExp(`id="${id}"`).test(ph))
for (const id of ids) console.log(`  ${missing.includes(id) ? '✗ 缺失' : '✓'}  #${id}`)
if (missing.length) {
  bad++
  console.log(`  ← popup.html 缺少 ${missing.length} 个元素：${missing.join(', ')}`)
}

console.log('--- background ---')
const bg = fs.readFileSync('background.js', 'utf8')
const apiMatch = bg.match(/http:\/\/[a-zA-Z0-9.:]+/)
console.log('  注入的后端地址: ' + (apiMatch ? apiMatch[0] : '(未找到)'))
for (const k of ['GET_STATUS', 'FLUSH_NOW', 'CLEAR_QUEUE', 'alarms']) {
  console.log(`  ${bg.includes(k) ? '✓' : '✗'}  ${k}`)
}

console.log('--- content ---')
const ct = decode(fs.readFileSync('content.js', 'utf8'))
for (const k of ['zhipin', 'liepin', 'CAPTURE', 'DIAGNOSE', '__ria', 'hashchange', '已注入', '采集出错']) {
  const hit = ct.includes(k)
  if (!hit) bad++
  console.log(`  ${hit ? '✓' : '✗'}  ${k}`)
}
// 回归点：采集闸门必须基于「内容签名」而不是 URL ——
// IM 页切换候选人时 URL 常常一模一样，用 URL 当闸门会永久漏采。
const noUrlGate = !/\blastUrl\b/.test(ct)
console.log(`  ${noUrlGate ? '✓' : '✗'}  未使用 URL 作为采集闸门（lastUrl 已移除）`)
if (!noUrlGate) bad++
const hasSignature = ct.includes('rawText.length') || ct.includes('signatureOf')
console.log(`  ${hasSignature ? '✓' : '✗'}  使用内容签名判重`)
if (!hasSignature) bad++

// ---------------------------------------------------------------
// 版本号一致性
// manifest / package.json / popup.html 三处曾经各自漂移成 0.3.0 / 0.1.0 / 0.2.0。
// 用户看 edge://extensions 显示的是 manifest 的版本号，而扩展面板上印的是
// popup.html 里硬编码的那个 —— 「我装的到底是不是新版」会被直接误导。
// 这里以 manifest 为准，三处必须一致。
// ---------------------------------------------------------------
console.log('--- 版本号一致性 ---')
const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcManifest = JSON.parse(fs.readFileSync(path.join(srcDir, 'manifest.json'), 'utf8'))
const srcPkg = JSON.parse(fs.readFileSync(path.join(srcDir, 'package.json'), 'utf8'))
const srcPopupHtml = fs.readFileSync(path.join(srcDir, 'popup.html'), 'utf8')
const popupVersion = (srcPopupHtml.match(/class="v">v([\d.]+)</) || [])[1]
const versionPairs = [
  ['manifest.json', srcManifest.version],
  ['package.json', srcPkg.version],
  ['popup.html', popupVersion],
]
for (const [file, v] of versionPairs) {
  const same = v === srcManifest.version
  if (!same) bad++
  console.log(`  ${same ? '✓' : '✗'}  ${file}: ${v ?? '(未找到版本号)'}`)
}
if (srcManifest.version !== m.version) {
  bad++
  console.log(`  ✗  产物 manifest (${m.version}) 与源码 (${srcManifest.version}) 不一致 —— 需要重新 npm run build`)
}

// ---------------------------------------------------------------
// 采集开关 + 手动保存 + 保存时选岗位（0.4.x）
// 这一批能力横跨三个脚本 + 一条新的消息协议，任何一个环节没打进产物，
// 表现都是「界面上点了没反应」—— 光看产物文件在不在发现不了。
// ---------------------------------------------------------------
console.log('--- 采集开关 / 手动保存 / 选岗位 ---')
const bgDecoded = decode(bg)
for (const k of [
  'capture_settings',
  'capture_log',
  'skipped_ids',
  'positions_cache',
  'GET_SETTINGS',
  'SET_SETTINGS',
  'GET_POSITIONS',
  'SKIP',
  'RESUME_PATH',
  'GET_LOG',
  'needs-confirm',
  'disabled',
  'totalManual',
  'totalSkipped',
  'ruleSuggested',
]) {
  const hit = bgDecoded.includes(k)
  if (!hit) bad++
  console.log(`  ${hit ? '✓' : '✗'}  background: ${k}`)
}
for (const k of [
  'ria-catcher-overlay',
  'attachShadow',
  'capture_settings',
  'storage',
  'MANUAL_SAVE',
  'SKIP_NOW',
  'RESUME_PATH_NOW',
  '保存到看板',
  '本页都不再问',
  '这次不存',
  '保存前询问',
  'extractForced',
  'decideCapture',
  'isListPage',
  'GET_POSITIONS',
  'lastPositionId',
  '挂到岗位',
  '猎聘推荐',
  '也挂上',
]) {
  const hit = ct.includes(k)
  if (!hit) bad++
  console.log(`  ${hit ? '✓' : '✗'}  content: ${k}`)
}
for (const k of [
  'mode-auto',
  'mode-confirm',
  'mode-off',
  'MANUAL_SAVE',
  'SKIP_NOW',
  'RESUME_PATH_NOW',
  'stat-manual',
  'pick-box',
  'pos-select',
  'pos-hint',
  'positionId',
]) {
  const hit = pj.includes(k)
  if (!hit) bad++
  console.log(`  ${hit ? '✓' : '✗'}  popup: ${k}`)
}
// 回归点：content 必须真的「按设置决定采不采」，而不是只在 popup 里改了个显示
const hasGate = ct.includes('decideCapture') && ct.includes('capture_settings')
console.log(`  ${hasGate ? '✓' : '✗'}  content 按设置做采集决策（不是只改显示）`)
if (!hasGate) bad++
// 回归点：选岗信息必须随 payload 一起走（否则断网排队再补传就丢了）
const hasPos = ct.includes('positionId') && bgDecoded.includes('positionId')
console.log(`  ${hasPos ? '✓' : '✗'}  选岗信息随 payload 全链路透传（含本地队列）`)
if (!hasPos) bad++

console.log('--- 总体 ---')
if (bad === 0) console.log('  全部引用文件存在，可直接加载到 Edge')
else console.log(`  有 ${bad} 个文件缺失`)
process.exit(bad === 0 ? 0 : 1)
