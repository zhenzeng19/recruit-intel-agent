// ============================================================
// 简历打印页集成测试
// ------------------------------------------------------------
// 为什么必须起真服务端：
//   /print/* 的价值全在「真实数据 → 真实 HTML 字符串」这一段 ——
//   直接单测渲染函数会绕过路由匹配（/print/batch 抢不抢得到 :candidateId 路由）、
//   content-type、404/400 走的是 HTML 还是 JSON，这些都在这一层。
//
// ★ 数据安全：**绝不**指向仓库外的 招聘agent-data。
//   先把真实数据目录整体复制到 os.tmpdir() 的临时目录，再用 DATA_DIR 指过去启动服务端。
//   测试里改 candidates.json 造 XSS 样本也只动副本，跑完连副本一起删。
// ============================================================
import esbuild from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../..')

/**
 * 端口：约定用 8901，但本机可能已被别的软件占着（实测 douyin_tray 就常驻 8901）。
 * 被别人占着的端口上 bind 会「成功但立刻被 RST」，表现为 fetch 一直 ECONNRESET →
 * 等待就绪超时。所以这里准备一串候选端口，并且**只认数据目录对得上的那个实例**，
 * 绝不误连到别人的服务上。
 */
const PORT_CANDIDATES = [8901, 8902, 8903, 8904]

/**
 * 真实数据目录（只用来**复制**，绝不直接指向它启动服务端）。
 * 按 store.resolveDataDir 的约定：仓库根的上一级才是默认数据目录，
 * 源码直接跑时也是从 apps/server/src 向上找到它。
 */
const REAL_DATA_DIR_CANDIDATES = [
  path.resolve(repoRoot, '..', '招聘agent-data'),
  path.join(repoRoot, '招聘agent-data'),
]
const REAL_DATA_DIR = REAL_DATA_DIR_CANDIDATES.find((p) => fs.existsSync(p)) ?? REAL_DATA_DIR_CANDIDATES[0]

// ---------------------------------------------------------- 断言工具
let pass = 0
let fail = 0
const failures = []

function ok(cond, label) {
  if (cond) {
    pass++
    console.log(`  ✓  ${label}`)
  } else {
    fail++
    failures.push(label)
    console.log(`  ✗  ${label}`)
  }
}
function eq(actual, expected, label) {
  if (actual === expected) {
    pass++
    console.log(`  ✓  ${label}`)
  } else {
    fail++
    failures.push(label)
    console.log(`  ✗  ${label}`)
    console.log(`       期望 ${JSON.stringify(expected)}`)
    console.log(`       实际 ${JSON.stringify(actual)}`)
  }
}
const section = (t) => console.log(`\n${t}`)
const countOf = (hay, needle) => hay.split(needle).length - 1

// ---------------------------------------------------------- 1. 临时数据目录（副本）
/**
 * 把真实数据**复制**到临时目录。
 *
 * ⚠️ 刻意不用 `fs.cpSync(src, dst, { recursive: true })`：真实数据目录里有一个
 *    `_backup/` 子目录，Node 24 在 Windows 上对它做递归复制会**原生崩溃**
 *    （进程直接 STATUS_STACK_BUFFER_OVERRUN，连 JS 异常都抛不出来，现场只剩一片空白）。
 *    我们只需要那 4 张表，所以逐个文件复制即可 —— 顺带也把备份目录排除在外。
 */
function copyJsonTables(from, to) {
  fs.mkdirSync(to, { recursive: true })
  let n = 0
  for (const name of fs.readdirSync(from)) {
    if (!name.endsWith('.json')) continue
    const src = path.join(from, name)
    if (!fs.statSync(src).isFile()) continue
    fs.copyFileSync(src, path.join(to, name))
    n++
  }
  return n
}

const outFile = path.join(os.tmpdir(), `ria-print-server-${Date.now()}.mjs`)
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ria-print-data-'))
let shuttingDown = false
/** 当前活着的服务端进程（第 5/7 节会换新实例，所以用变量而不是常量） */
let activeChild = null
let exited = false
/** 主动重启窗口期：此时子进程退出是预期的，不算失败 */
let awaitingRestart = false

function cleanup() {
  for (const p of [outFile, dataDir]) {
    try {
      fs.rmSync(p, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

function stopServer() {
  shuttingDown = true
  try {
    activeChild?.kill()
  } catch {
    /* ignore */
  }
}

process.on('exit', () => {
  stopServer()
  cleanup()
})

if (fs.existsSync(REAL_DATA_DIR)) {
  const n = copyJsonTables(REAL_DATA_DIR, dataDir)
  console.log(`已把真实数据目录的 ${n} 张表复制到临时目录：${dataDir}`)
  console.log(`（来源：${REAL_DATA_DIR} —— 只读复制，测试里的改动只落在临时副本上）`)
} else {
  console.log('未找到真实数据目录，测试将用自动灌入的示例数据')
}

// ---------------------------------------------------------- 2. 打包真实服务端
// 与 build.mjs 一致：依赖一起打进产物，但多一行 banner 把 require 注入回去 ——
// fastify 的依赖链里有 CJS 包，ESM 产物里没有 require 会直接「Dynamic require…」报错。
console.log('正在打包 apps/server/src/index.ts …')
await esbuild.build({
  entryPoints: [path.join(repoRoot, 'apps/server/src/index.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'bundle',
  banner: {
    js: [
      "import { createRequire as __cr } from 'node:module';",
      'const require = __cr(import.meta.url);',
    ].join('\n'),
  },
  alias: { '@ria/shared': path.join(repoRoot, 'packages/shared/src/index.ts') },
  logLevel: 'warning',
})

// ---------------------------------------------------------- 3. 起隔离服务端
let PORT = PORT_CANDIDATES[0]
const BASE = () => `http://127.0.0.1:${PORT}`

function startServer(seedOnEmpty = '1') {
  exited = false
  shuttingDown = false
  const child = spawn(process.execPath, [outFile], {
    cwd: dataDir,
    env: {
      ...process.env,
      SERVER_PORT: String(PORT),
      DATA_DIR: dataDir,
      SEED_ON_EMPTY: seedOnEmpty,
      // 断掉「找到前端产物就托管静态文件」这条分支，让测试只走 API
      WEB_DIST: path.join(dataDir, 'no-such-web-dist'),
      NODE_ENV: 'test',
    },
    stdio: 'inherit',
  })
  child.on('exit', (code) => {
    exited = true
    if (!shuttingDown && !awaitingRestart) {
      // 不在这里直接 exit(1)：端口被占用时 bootOnFreePort 正要换一个端口重试，
      // 由它把「所有候选端口都不行」收敛成一次失败。
      //
      // ⚠️ 这里**刻意不用 `✗`**：端口被占用（实测本机 douyin_tray 常驻 8901）
      //    是预期内、且会被自动处理的情况。用失败符号打印它，会让读日志的人
      //    以为测试坏了 —— 而「训练人忽略 ✗」比这个显示问题危害大得多。
      //    真正的失败（所有候选端口都试完）由 bootOnFreePort 用 ✗ 报出来。
      console.log(`  ·  端口 ${PORT} 上的实例退出（code=${code}），准备换端口重试`)
    }
  })
  activeChild = child
  return child
}

/** 等到「我们自己的那个实例」就绪：health 里的 dataDir 必须等于临时目录 */
async function waitForServer(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (exited) throw new Error('服务端启动过程中退出')
    try {
      const r = await fetch(`${BASE()}/api/health`)
      if (r.ok) {
        const body = await r.json()
        if (body?.data?.dataDir === dataDir) return body
      }
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`等待服务端就绪超时（${timeoutMs}ms，端口 ${PORT}）`)
}

async function get(url) {
  const r = await fetch(`${BASE()}${url}`)
  const text = await r.text()
  return { status: r.status, type: r.headers.get('content-type') || '', text }
}
const enc = (s) => encodeURIComponent(s)

/** 只读地拿 JSON 接口的 data */
async function apiJson(url) {
  try {
    return (await (await fetch(`${BASE()}${url}`)).json())?.data
  } catch {
    return undefined
  }
}

/** 等当前子进程真正退出（比轮询 health 可靠：轮询可能命中还在关闭中的旧实例） */
function waitForChildExit(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      resolve()
    }, 5000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/**
 * 重启服务端实例。
 * JsonStore 在构造时把 json 读进内存，所以「直接改临时副本里的数据文件」必须
 * 换一个进程才生效。SEED_ON_EMPTY=0 保证重启不会把改动冲掉。
 */
async function restartServer() {
  awaitingRestart = true
  const dying = activeChild
  stopServer()
  await waitForChildExit(dying)
  // bootOnFreePort 换端口时留下的 exited=true 必须清掉，否则新实例一启动就被判成「已退出」
  exited = false
  startServer('0')
  await waitForServer()
  awaitingRestart = false
}

/** 在候选端口里挑一个能真正跑起我们自己实例的（每个端口最多试 3 次，抖动的占用会让首次失败） */
async function bootOnFreePort() {
  for (const p of PORT_CANDIDATES) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      PORT = p
      startServer('1')
      try {
        const health = await waitForServer(8000)
        console.log(`已在本机端口 ${p} 起了隔离实例（第 ${attempt} 次尝试）`)
        return health
      } catch (e) {
        console.log(`  · 端口 ${p} 第 ${attempt} 次尝试不可用：${e.message}`)
        awaitingRestart = true // 主动放弃这个实例，别让 exit 处理器把它当崩溃
        const dying = activeChild
        stopServer()
        await waitForChildExit(dying)
        awaitingRestart = false
        exited = false
      }
    }
  }
  return null
}

// ---------------------------------------------------------- 4. 主流程
console.log('\n=== 简历打印页集成测试 ===')

const health = await bootOnFreePort()
if (!health) {
  console.error(`✗ 候选端口都被占用或服务端起不来（${PORT_CANDIDATES.join(', ')}）`)
  process.exit(1)
}
console.log(`服务端就绪：${BASE()}｜数据目录 ${health?.data?.dataDir ?? dataDir}\n`)

const list = await apiJson('/api/candidates?limit=500')
const rows = list?.items ?? []
ok(rows.length > 0, `数据目录里有候选人（${rows.length} 人）`)
if (rows.length === 0) {
  console.error('✗ 没有候选人数据，无法继续')
  process.exit(1)
}

const sample = rows.find((r) => r.positionTitle && r.candidate.name) ?? rows[0]
const sampleId = sample.candidate.id
const sampleName = sample.candidate.name
const samplePosition = sample.positionTitle
console.log(`样本：${sampleName}（${sampleId}）→ ${samplePosition}`)

section('1. 单人打印页：200 + text/html + 关键内容')
{
  const r = await get(`/print/${enc(sampleId)}`)
  eq(r.status, 200, '返回 200')
  ok(r.type.includes('text/html'), `content-type 含 text/html（实际 ${r.type}）`)
  ok(r.text.includes(sampleName), `页面里有候选人姓名「${sampleName}」`)
  ok(r.text.includes(samplePosition), `页面里有岗位名「${samplePosition}」`)
  ok(r.text.includes('应聘岗位'), '页眉有「应聘岗位」标签')
  ok(r.text.startsWith('<!doctype html>'), '是一整页 HTML（不是 JSON 信封）')
  ok(!r.text.includes('"ok":true'), '没有把 JSON 信封混进 HTML')
  ok(!/<img|<link|@font-face/i.test(r.text), '零外部资源（无图片 / 无字体 / 无外链样式）')
  ok(/@page\s*\{[^}]*A4/.test(r.text), '有 @page A4 规则')
  ok(r.text.includes('white-space: pre-wrap'), '正文换行交给 pre-wrap，而不是折叠成标签')
  ok(r.text.includes('Microsoft YaHei'), '用的是系统中文字体（不嵌字体文件）')
}

section('2. 页脚：来源 URL / 采集时间 / 内部使用声明')
{
  const r = await get(`/print/${enc(sampleId)}`)
  ok(r.text.includes('来源：'), '页脚有「来源：」')
  ok(r.text.includes('采集时间'), '页脚有采集时间')
  ok(r.text.includes('采集方式：'), '页脚有采集方式')
  ok(r.text.includes('手动保存') || r.text.includes('自动采集'), '采集方式归一成「手动保存 / 自动采集」')
  ok(r.text.includes('仅供内部招聘评估使用'), '页脚有内部使用声明')
  ok(r.text.includes('class="pfoot"'), '页脚有固定定位容器')
  ok(/\.pfoot\s*\{[^}]*position:\s*fixed/.test(r.text), '页脚是 position:fixed（每页重复）')
  if (sample.resumeUrl) {
    ok(r.text.includes(sample.resumeUrl.replace(/&/g, '&amp;')), '页脚印出了来源链接')
  } else {
    console.log('       （该样本没有 resumeUrl，走「未记录链接」兜底）')
  }
}

section('3. 开关：score / source / raw / auto')
{
  const off = await get(`/print/${enc(sampleId)}?score=0&source=0&raw=0`)
  eq(off.status, 200, 'score=0&source=0&raw=0 仍返回 200')
  ok(!off.text.includes('匹配度'), 'score=0 时不出现「匹配度」')
  ok(!off.text.includes('命中点'), 'score=0 时不出现「命中点」')
  ok(!off.text.includes('来源：'), 'source=0 时不出现「来源：」')
  ok(!off.text.includes('采集时间'), 'source=0 时页脚整块不出现')
  ok(!off.text.includes('未结构化原文'), 'raw=0 时不出现「未结构化原文」')

  const on = await get(`/print/${enc(sampleId)}`)
  ok(on.text.includes('匹配度'), '默认 score=1 时出现「匹配度」')
  ok(on.text.includes('未结构化原文'), '默认 raw=1 时附上「未结构化原文」')
  ok(on.text.includes('来源：'), '默认 source=1 时出现「来源：」')
  ok(on.text.includes('window.print()'), 'auto 默认开启：页面自带自动唤起打印')
  ok(!/https?:\/\/[^"'<]*\.js\b/.test(on.text), '页面没有引用任何外部 JS')

  const autoOff = await get(`/print/${enc(sampleId)}?auto=0`)
  ok(!autoOff.text.includes('window.print()'), 'auto=0 时不出现自动打印脚本')
}

section('4. 岗位选择：默认取最高分，positionId 可覆盖')
{
  const detail = await apiJson(`/api/candidates/${enc(sampleId)}`)
  const matches = detail?.matches ?? []
  ok(matches.length > 0, `样本有 ${matches.length} 条岗位匹配`)
  const top = [...matches].sort((a, b) => b.score - a.score)[0]
  const low = [...matches].sort((a, b) => a.score - b.score)[0]

  const r = await get(`/print/${enc(sampleId)}`)
  ok(r.text.includes(top.positionTitle), `默认取分数最高的岗位「${top.positionTitle}」`)
  ok(r.text.includes(`匹配度 <b>${top.score}</b> 分`), `印的是最高分 ${top.score}`)

  const r2 = await get(`/print/${enc(sampleId)}?positionId=${enc(low.positionId)}`)
  ok(r2.text.includes(low.positionTitle), `指定 positionId 后印「${low.positionTitle}」`)
  ok(r2.text.includes(`匹配度 <b>${low.score}</b> 分`), `分数也跟着换成 ${low.score}`)
  if (matches.length === 1) console.log('       （该样本只有一条匹配，覆盖用例与默认值相同）')
}

section('5. 置信度降级：low 不硬排版，medium/high 出结构化区块')
{
  const r = await get(`/print/${enc(sampleId)}`)
  const lowNotice = '本页内容由页面文本自动分节，未做结构化，可能不完全准确'
  const hasSections = r.text.includes('class="sec-h"') && /工作经历|教育经历/.test(r.text)
  const hasLowNotice = r.text.includes(lowNotice)
  ok(
    hasSections !== hasLowNotice,
    hasSections ? '结构够清楚：出了分节排版，没有降级提示' : '置信度 low：按原文逐行输出并给出降级提示'
  )
  ok(!r.text.includes('innerHTML'), '不靠 innerHTML 注入正文')

  // 造一份「没有章节标题」的简历 → 必须落到 low 分支
  const file = path.join(dataDir, 'candidates.json')
  if (fs.existsSync(file)) {
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'))
    const marker = '低置信度样本'
    const probe = {
      ...arr[0],
      id: 'cand_low_confidence_probe',
      name: marker,
      resumeText: `${marker}\n38 岁\n盐城\n工作15年\n本科\n做过一些项目，具体内容见附件，此处不再展开。`,
      skills: [],
    }
    arr.push(probe)
    fs.writeFileSync(file, JSON.stringify(arr, null, 2), 'utf8')
    await restartServer()
    const low = await get('/print/cand_low_confidence_probe')
    eq(low.status, 200, '低置信度样本返回 200')
    ok(low.text.includes(lowNotice), 'low 置信度时页面顶部有「未做结构化」提示')
    ok(low.text.includes('原文逐行输出'), 'low 置信度时正文按原文逐行输出')
    ok(!low.text.includes('class="blk-h"'), 'low 置信度时没有硬排版成结构化区块')
    ok(!low.text.includes('正文分节核对'), 'low 置信度时不做「分节核对」（连章节都没认出来）')
    ok(low.text.includes('具体内容见附件'), '原文内容一句不丢')

    // 同一份改成「有章节、但没有块结束标记」→ medium：结构化 + 分节核对（防字段丢内容）
    probe.resumeText =
      `${marker}\n38 岁\n盐城\n工作15年\n本科\n` +
      `【工作经历】\n某某科技有限公司\n项目经理\n2020.01 - 至今\n负责项目管理。\n这句是结构化字段容易漏掉的补充说明。\n` +
      `【教育经历】\n某某大学 · 计算机 · 本科 · 统招\n2005.09 - 2009.06`
    fs.writeFileSync(file, JSON.stringify(arr, null, 2), 'utf8')
    await restartServer()
    const med = await get('/print/cand_low_confidence_probe')
    eq(med.status, 200, '中置信度样本返回 200')
    ok(!med.text.includes(lowNotice), 'medium 时不再给降级提示')
    ok(med.text.includes('class="blk-h"'), 'medium 时按结构化区块排版（公司 / 职位 / 起止）')
    ok(med.text.includes('某某科技有限公司'), '印出了公司名')
    ok(med.text.includes('正文分节核对'), 'medium 时追加「分节核对」区块')
    ok(med.text.includes('这句是结构化字段容易漏掉的补充说明'), '分节核对补回了结构化字段漏掉的原文')
  } else {
    console.log('  · 临时目录没有 candidates.json，跳过低置信度用例')
    ok(false, '低置信度用例未执行')
  }
}

section('6. 全量真实数据：每一份简历都能印出一页')
{
  let okCount = 0
  const problems = []
  for (const row of rows) {
    const r = await get(`/print/${enc(row.candidate.id)}`)
    const bodyOk = r.status === 200 && r.text.includes(row.candidate.name) && r.text.includes('<!doctype html>')
    if (bodyOk) okCount++
    else problems.push(`${row.candidate.name}(${row.candidate.id}) → HTTP ${r.status}`)
  }
  eq(okCount, rows.length, `${rows.length} 份简历全部返回可打印页面`)
  if (problems.length > 0) console.log(`       问题：${problems.join('；')}`)

  // 真实数据里已经有 capturedUrl / resumeNo 的样本，顺带确认页脚没把它们印错
  const withNo = rows.find((r) => r.candidate.resumeNo)
  if (withNo) {
    const r = await get(`/print/${enc(withNo.candidate.id)}`)
    ok(r.text.includes(`简历编号：${withNo.candidate.resumeNo}`), '真实数据的简历编号印在页脚')
  } else {
    console.log('  · 真实数据里没有带 resumeNo 的样本，跳过')
  }
}

section('7. 不存在的 id → 404（中文 HTML 错误页）')
{
  const r = await get('/print/cand_does_not_exist_zzz')
  eq(r.status, 404, '返回 404')
  ok(r.type.includes('text/html'), '错误页是 HTML，不是 JSON')
  ok(r.text.includes('候选人不存在'), '错误页有中文说明')
  ok(!r.text.includes('"ok":false'), '错误页没有 JSON 信封')
}

section('8. XSS 防护：正文里的 <script> / onerror / 闭合标签必须全部转义')
{
  const file = path.join(dataDir, 'candidates.json')
  const arr = JSON.parse(fs.readFileSync(file, 'utf8'))
  const target = arr.find((c) => c.id === sampleId) ?? arr[0]

  target.resumeText =
    `${target.name}\n38 岁\n盐城\n工作15年\n<script>alert(1)</script>\n` +
    `【工作经历】\n某某公司\n项目经理\n2020.01 - 至今\n<img src=x onerror="alert(2)">\n` +
    `【技能标签】\n</div><svg/onload=alert(3)>`
  fs.writeFileSync(file, JSON.stringify(arr, null, 2), 'utf8')
  console.log('  · 已把 XSS 样本写进**临时副本**，重启服务端实例以加载改动…')
  await restartServer()

  const r = await get(`/print/${enc(target.id)}?auto=0`)
  eq(r.status, 200, '注入后仍返回 200')
  ok(r.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), '正文里的 <script> 被转义成 &lt;script&gt;')
  ok(!r.text.includes('<script>alert(1)'), '页面里没有可执行的 <script>alert(1)')
  ok(!/<img[^>]*onerror/i.test(r.text), 'img onerror 不再构成一个标签')
  ok(r.text.includes('&lt;img src=x onerror=&quot;alert(2)&quot;&gt;'), 'img 标签整体被转义（双引号也转）')
  ok(r.text.includes('&lt;/div&gt;&lt;svg/onload=alert(3)&gt;'), '闭合标签 + svg 注入被转义')
  eq(countOf(r.text, '<script'), 0, 'auto=0 时整页不含任何 <script 标签')
  ok(r.text.includes('&lt;'), '危险字符只以转义实体形式出现')

  // 单引号也要转（属性注入场景）
  const q = arr.find((c) => c.id === 'cand_low_confidence_probe')
  if (q) {
    q.resumeText = `' onmouseover='alert(4)`
    fs.writeFileSync(file, JSON.stringify(arr, null, 2), 'utf8')
    await restartServer()
    const r2 = await get('/print/cand_low_confidence_probe?auto=0')
    ok(r2.text.includes('&#39;'), '单引号被转义成 &#39;')
  }
}

section('9. 页眉/页脚补充字段 + 50 人上限（自造夹具，只写临时副本）')
{
  const file = path.join(dataDir, 'candidates.json')
  const bulkIds = Array.from({ length: 60 }, (_, i) => `cand_bulk_${String(i + 1).padStart(3, '0')}`)
  const arr = JSON.parse(fs.readFileSync(file, 'utf8'))
  const base = arr[0]
  const now = new Date().toISOString()

  // 60 份极简但合法的简历：用来验 50 人截断
  for (const id of bulkIds) {
    arr.push({
      ...base,
      id,
      name: `批量样本${id.slice(-3)}`,
      resumeText: `批量样本${id.slice(-3)}\n30 岁\n深圳\n工作5年\n【工作经历】\n某某科技有限公司\n工程师\n2020.01 - 至今\n负责若干事项。`,
      skills: ['Python'],
      createdAt: now,
      updatedAt: now,
    })
  }
  // 第一个人补上平台简历编号 + 采集页，验证页脚补充信息
  const first = arr.find((c) => c.id === bulkIds[0])
  first.resumeNo = 'EF56AB78CD9000ee55ff66'
  fs.writeFileSync(file, JSON.stringify(arr, null, 2), 'utf8')

  // sources.json 里给第一个人造一条「简历链接 ≠ 实际采集页」的来源
  const srcFile = path.join(dataDir, 'sources.json')
  if (fs.existsSync(srcFile)) {
    const sources = JSON.parse(fs.readFileSync(srcFile, 'utf8'))
    const own = sources.find((s) => s.candidateId === bulkIds[0])
    if (own) {
      own.resumeUrl = 'https://www.zhipin.com/web/geek/resume?geekId=9999'
      own.capturedUrl = 'https://www.zhipin.com/web/chat/index?jobId=85838997'
      own.captureMethod = 'manual'
    } else {
      sources.push({
        id: `src_bulk_001`,
        candidateId: bulkIds[0],
        platform: 'boss',
        platformCandidateId: 'bulk-001',
        resumeUrl: 'https://www.zhipin.com/web/geek/resume?geekId=9999',
        capturedUrl: 'https://www.zhipin.com/web/chat/index?jobId=85838997',
        capturedAt: now,
        captureMethod: 'manual',
      })
    }
    fs.writeFileSync(srcFile, JSON.stringify(sources, null, 2), 'utf8')
  }
  await restartServer()

  const one = await get(`/print/${enc(bulkIds[0])}`)
  ok(one.text.includes('简历编号：EF56AB78CD9000ee55ff66'), '页脚印出平台简历编号（resumeNo）')
  ok(one.text.includes('来源：https://www.zhipin.com/web/geek/resume?geekId=9999'), '来源优先用简历自己的 resumeUrl')
  ok(one.text.includes('采集页：https://www.zhipin.com/web/chat/index?jobId=85838997'), 'capturedUrl 与 resumeUrl 不同时作为补充印出')
  ok(one.text.includes('采集方式：手动保存'), 'captureMethod=manual → 手动保存')

  const r = await get(`/print/batch?ids=${bulkIds.map(enc).join(',')}`)
  eq(r.status, 200, '60 人请求返回 200')
  ok(r.text.includes('一次最多打印 50 份简历'), '超过 50 人时页面上说明了截断')
  eq(countOf(r.text, 'class="pdoc'), 50, '只生成 50 份')
  ok(!r.text.includes('批量样本060'), '被截断的人确实没有进页面')
}

section('10. 批量：ids 模式')
{
  const two = rows.slice(0, 2)
  const ids = two.map((r) => r.candidate.id)
  const r = await get(`/print/batch?ids=${ids.map(enc).join(',')}`)
  eq(r.status, 200, '批量返回 200')
  ok(r.type.includes('text/html'), '批量也是 text/html')
  for (const row of two) ok(r.text.includes(row.candidate.name), `批量页里有「${row.candidate.name}」`)
  ok(r.text.includes('page-break-before: always'), '带 page-break-before 相关样式（每人另起一页）')
  ok(r.text.includes('1 / 2') && r.text.includes('2 / 2'), '每节有「N / M」批量标题')
  eq(countOf(r.text, 'class="pdoc first"'), 1, '只有第一个人不带分页样式')
  eq(countOf(r.text, 'class="pdoc"'), 1, '第二个人带分页样式')

  const single = await get(`/print/batch?ids=${enc(ids[0])}`)
  eq(single.status, 200, '批量传 1 人也能用')
  ok(single.text.includes('class="pdoc first"'), '单人批量时第一个人也不带分页')

  const mixed = await get(`/print/batch?ids=${enc(ids[0])},nope_zzz`)
  eq(mixed.status, 200, '有一个 id 无效时仍返回 200')
  ok(mixed.text.includes('未找到'), '并说明了跳过的 id')
}

section('11. 批量：按岗位导出 positionId 模式')
{
  // 找一个候选人 ≥2 的岗位来验排序与「不混入别人」
  const positions = (await apiJson('/api/positions')) ?? []
  const target = positions.find((p) => p.candidateCount >= 2)
  ok(!!target, `找到一个有 ≥2 名候选人的岗位（${target?.title}，${target?.candidateCount} 人）`)
  if (!target) {
    // 兜底：自己造两个候选人挂到同一岗位
    ok(false, 'positionId 模式用例未执行')
  } else {
    const expectedRows =
      (await apiJson(`/api/candidates?positionId=${enc(target.id)}&limit=500`))?.items ?? []
    const expectedIds = [...expectedRows]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .map((r) => r.candidate.id)
    const others = rows.filter((r) => !expectedIds.includes(r.candidate.id)).slice(0, 1)

    const r = await get(`/print/batch?positionId=${enc(target.id)}`)
    eq(r.status, 200, 'positionId 模式返回 200')
    ok(r.text.includes(target.title), `页眉印的就是该岗位「${target.title}」`)
    for (const row of expectedRows.slice(0, 3)) {
      ok(r.text.includes(row.candidate.name), `该岗位下「${row.candidate.name}」被导出`)
    }
    eq(countOf(r.text, 'class="pdoc'), expectedIds.length, `导出人数等于该岗位候选人数（${expectedIds.length}）`)
    ok(r.text.includes(`1 / ${expectedIds.length}`), '批量标题带总人数')
    if (others.length > 0) {
      ok(!r.text.includes(others[0].candidate.name), `没把别的岗位的人混进来（${others[0].candidate.name}）`)
    }
    // 分数从高到低：第一个出现的姓名应当是最高分那位
    const topName = expectedRows.find((x) => x.candidate.id === expectedIds[0])?.candidate.name
    const lastName = expectedRows.find((x) => x.candidate.id === expectedIds[expectedIds.length - 1])?.candidate.name
    if (topName && lastName && topName !== lastName) {
      const iTop = r.text.indexOf(topName)
      const iLast = r.text.indexOf(lastName)
      ok(iTop >= 0 && iLast >= 0 && iTop < iLast, `按分数从高到低排序（${topName} 在 ${lastName} 之前）`)
    }

    // ids 优先：同时给 ids 和 positionId 时以 ids 为准
    const onlyOther = others.length > 0 ? others[0] : null
    if (onlyOther) {
      const both = await get(`/print/batch?ids=${enc(onlyOther.candidate.id)}&positionId=${enc(target.id)}`)
      eq(both.status, 200, 'ids + positionId 同时给时返回 200')
      ok(both.text.includes(onlyOther.candidate.name), 'ids 优先：导出的是 ids 指定的人')
      eq(countOf(both.text, 'class="pdoc'), 1, 'ids 优先：没有被岗位下的其他人覆盖')

      // 但页眉岗位仍应用传入的 positionId
      const detail = await apiJson(`/api/candidates/${enc(onlyOther.candidate.id)}`)
      const hasThatMatch = (detail?.matches ?? []).some((m) => m.positionId === target.id)
      if (hasThatMatch) {
        ok(both.text.includes(target.title), 'ids 优先时页眉岗位仍用传入的 positionId')
      }
    }
  }
}

section('12. 批量参数校验（400 文案要能区分三种原因）')
{
  const empty = await get('/print/batch?ids=')
  eq(empty.status, 400, 'ids 为空且无 positionId → 400')
  ok(empty.type.includes('text/html'), '400 也是中文 HTML 错误页')
  ok(empty.text.includes('缺少 ids 与 positionId'), '文案说清是「没给 ids / positionId」')

  const none = await get('/print/batch?ids=nope1,nope2')
  eq(none.status, 400, 'id 全无效 → 400')

  const badPos = await get('/print/batch?positionId=pos_does_not_exist_zzz')
  eq(badPos.status, 400, 'positionId 不存在 → 400')
  ok(badPos.text.includes('岗位不存在'), '文案说清是「岗位不存在」')

  const positions = (await apiJson('/api/positions')) ?? []
  const emptyPos = positions.find((p) => p.candidateCount === 0)
  if (emptyPos) {
    const r = await get(`/print/batch?positionId=${enc(emptyPos.id)}`)
    eq(r.status, 400, '该岗位下没有人 → 400')
    ok(r.text.includes('该岗位下还没有候选人'), '文案说清是「该岗位下还没有候选人」')
    ok(r.text.includes(emptyPos.title), '错误页点明了是哪个岗位')
  } else {
    // 没有空岗位就临时造一个（写操作只落在临时副本上）
    const created = await (
      await fetch(`${BASE()}/api/positions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: '打印自检空岗位', jdText: '仅用于自检' }),
      })
    ).json()
    const r = await get(`/print/batch?positionId=${enc(created?.data?.id ?? 'x')}`)
    eq(r.status, 400, '该岗位下没有人 → 400')
    ok(r.text.includes('该岗位下还没有候选人'), '文案说清是「该岗位下还没有候选人」')
  }
}

section('13. 开关在批量下同样生效')
{
  const two = rows.slice(0, 2).map((r) => r.candidate.id)
  const r = await get(`/print/batch?ids=${two.map(enc).join(',')}&score=0&source=0&raw=0&auto=0`)
  eq(r.status, 200, '批量全关仍 200')
  ok(!r.text.includes('匹配度'), '批量 score=0 不出现「匹配度」')
  ok(!r.text.includes('来源：'), '批量 source=0 不出现「来源：」')
  ok(!r.text.includes('未结构化原文'), '批量 raw=0 不出现「未结构化原文」')
  ok(!r.text.includes('window.print()'), '批量 auto=0 不自动打印')

  const pos = ((await apiJson('/api/positions')) ?? []).find((p) => p.candidateCount >= 1)
  if (pos) {
    const rp = await get(`/print/batch?positionId=${enc(pos.id)}&score=0&raw=0`)
    ok(!rp.text.includes('匹配度'), 'positionId 模式同样尊重 score=0')
    ok(!rp.text.includes('未结构化原文'), 'positionId 模式同样尊重 raw=0')
  }
}

// ---------------------------------------------------------- 5. 汇总
stopServer()

console.log(`\n=== ${pass} 项通过，${fail} 项失败 ===`)
if (fail > 0) {
  console.log('失败项：')
  failures.forEach((f) => console.log(`  · ${f}`))
}
cleanup()
process.exit(fail > 0 ? 1 : 0)
