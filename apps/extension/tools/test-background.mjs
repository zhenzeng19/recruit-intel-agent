// ============================================================
// 扩展核心逻辑集成自检
// ------------------------------------------------------------
// 用假的 chrome API 桩驱动真实构建产物（background.js），
// 并自带一个隔离的后端实例（独立端口 + 临时数据目录），
// 因此不会污染你的示例数据，也不依赖你先手动启动服务。
//
// 覆盖：设置读写 → 采集模式闸门（auto/confirm/off）→ 手动保存 →
//       入队去重 → 静默同步 → 状态回读 → 断网保留 → 恢复补传 →
//       跳过（这份/本页）→ 决策留痕 → 清空队列
//
// ⚠️ 注意：0.4.0 起默认模式是 **confirm（保存前询问）**，
//    所以凡是要断言「自动入库」的用例，都必须先显式 SET_SETTINGS mode=auto。
//    这不是测试写错了，而是默认行为真的变了。
//
// 运行：npm run test:ext
// ============================================================
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../..')

const PORT = Number(process.env.TEST_PORT) || 8899
const API = `http://localhost:${PORT}`
const OFFLINE_API = 'http://127.0.0.1:9' // 必然连不上

// ------------------------------------------------------------ 路径解析
function readBuildOutDir() {
  let out = '../招聘agent-build'
  try {
    const env = fs.readFileSync(path.join(repoRoot, '.env'), 'utf8')
    for (const line of env.split(/\r?\n/)) {
      const m = /^\s*BUILD_OUT_DIR\s*=\s*(.+?)\s*$/.exec(line)
      if (m) out = m[1]
    }
  } catch {
    /* 用默认值 */
  }
  return path.resolve(repoRoot, out)
}

const buildDir = readBuildOutDir()
const srcBundle = path.join(buildDir, 'extension', 'background.js')
const serverEntry = path.join(buildDir, 'server', 'index.js')

if (!fs.existsSync(srcBundle) || !fs.existsSync(serverEntry)) {
  console.error(`找不到构建产物：\n  ${srcBundle}\n  ${serverEntry}\n请先执行：npm run build`)
  process.exit(2)
}

// ------------------------------------------------------------ 断言
let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  ✓  ${name}${extra ? '  — ' + extra : ''}`)
  } else {
    fail++
    console.log(`  ✗  ${name}${extra ? '  — ' + extra : ''}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------ chrome 桩
// 产物里的函数在调用时才从全局解析 chrome，所以全局只能有一份。
// 做法：单一 chrome 对象 + 可切换的「活动存储」，每个实例调用前先切到自己的存储。
let activeStore = {}
let pendingListeners = []
let storageChangedListeners = []

globalThis.chrome = {
  storage: {
    local: {
      get: async (key) =>
        typeof key === 'string'
          ? key in activeStore
            ? { [key]: activeStore[key] }
            : {}
          : { ...activeStore },
      set: async (obj) => {
        const changes = {}
        for (const [k, v] of Object.entries(obj)) {
          changes[k] = { oldValue: activeStore[k], newValue: v }
        }
        Object.assign(activeStore, obj)
        // content script 靠 onChanged 实时生效，桩里也照常派发
        for (const fn of storageChangedListeners) fn(changes, 'local')
      },
      remove: async (key) => {
        if (Array.isArray(key)) for (const k of key) delete activeStore[k]
        else delete activeStore[key]
      },
    },
    onChanged: { addListener: (fn) => storageChangedListeners.push(fn) },
  },
  runtime: { onMessage: { addListener: (fn) => pendingListeners.push(fn) } },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
}

/**
 * 加载一份 background 产物实例（各自独立的 storage）。
 * 产物里的后端地址是构建期内联的常量，先探测出该值再替换。
 */
async function loadInstance(apiBase, tag) {
  const store = {}
  const listeners = []

  activeStore = store
  pendingListeners = []
  storageChangedListeners = []

  const src = fs.readFileSync(srcBundle, 'utf8')
  const baked = /API_BASE\s*=\s*"([^"]+)"/.exec(src)?.[1]
  if (!baked) {
    console.error('无法从产物中探测到内联的后端地址，产物可能已变更')
    process.exit(2)
  }
  const code = src.split(baked).join(apiBase)
  const entry = path.join(os.tmpdir(), `ria-bg-${tag}-${Date.now()}.mjs`)
  fs.writeFileSync(entry, code)
  tempFiles.push(entry)

  await import('file:///' + entry.replace(/\\/g, '/') + `?t=${tag}${Date.now()}`)
  await sleep(200)

  listeners.push(...pendingListeners)

  /**
   * 走真实的消息路由（与 popup / content 同一条路径）。
   * extra 用来带 method / patch / signature / scope / pathKey 这些附加字段。
   */
  const call = (type, payload, extra = {}) =>
    new Promise((resolve) => {
      activeStore = store // 切回本实例的存储，保证多实例互不干扰
      for (const fn of listeners) {
        const handled = fn({ type, payload, ...extra }, {}, resolve)
        if (handled === true) return
      }
      resolve(undefined)
    })

  /** 显式声明采集模式 —— 默认是 confirm，不声明就不会自动入库 */
  const setMode = async (mode) => {
    const r = await call('SET_SETTINGS', undefined, { patch: { mode } })
    return r?.data?.mode
  }

  const status = () => call('GET_STATUS')

  return { store, listeners, call, setMode, status }
}

// ------------------------------------------------------------ 起隔离后端
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ria-test-data-'))
const tempFiles = []
let serverProc = null
let cleanupDone = false

function cleanup() {
  if (cleanupDone) return
  cleanupDone = true
  try {
    serverProc?.kill()
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(tmpDataDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  for (const f of tempFiles) {
    try {
      fs.rmSync(f, { force: true })
    } catch {
      /* ignore */
    }
  }
}
process.on('exit', cleanup)

async function waitForServer(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${API}/api/health`)
      if (r.ok) return await r.json()
    } catch {
      /* 还没起来 */
    }
    await sleep(300)
  }
  return null
}

const payloadFor = (id, extra = {}) => ({
  platform: 'boss',
  platformCandidateId: id,
  resumeUrl: `https://www.zhipin.com/web/geek/resume?id=${id}`,
  rawText:
    '测试候选人\n28岁  深圳\n学历：硕士  毕业院校：测试大学\n5年工作经验\n现在测试科技有限公司 算法工程师\n期望薪资：30-50k\n1-3-8-1234-0000  ext@test.com',
  capturedAt: new Date().toISOString(),
  ...extra,
})

console.log('=== 扩展核心逻辑集成自检 ===')
console.log(`产物：${srcBundle}`)
console.log(`隔离后端：${API}`)
console.log(`临时数据目录：${tmpDataDir}\n`)

serverProc = spawn(process.execPath, [serverEntry], {
  env: { ...process.env, SERVER_PORT: String(PORT), DATA_DIR: tmpDataDir },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverLog = ''
serverProc.stdout.on('data', (d) => (serverLog += d))
serverProc.stderr.on('data', (d) => (serverLog += d))

console.log('--- 0. 启动隔离后端 ---')
const health = await waitForServer()
if (!health) {
  console.error('后端未能启动，输出如下：\n' + serverLog)
  cleanup()
  process.exit(2)
}
check('后端已就绪', health.ok === true)
check('数据目录已隔离到临时路径', String(health.data?.dataDir || '').includes('ria-test-data'), health.data?.dataDir)

try {
  // ---------------------------------------------------------- 1. 加载产物 + 默认设置
  const inst = await loadInstance(API, 'main')
  console.log('\n--- 1. 加载产物与默认设置 ---')
  check('注册了消息监听器', inst.listeners.length > 0, `${inst.listeners.length} 个`)
  check('启动即初始化捕获状态', !!inst.store['capture_state'])

  const s0 = await inst.call('GET_SETTINGS')
  check('GET_SETTINGS 有响应', !!s0?.ok)
  check(
    '默认模式是 confirm（保存前询问）—— 简历默认要人点头才入库',
    s0?.data?.mode === 'confirm',
    `mode=${s0?.data?.mode}`
  )
  check('默认开启页面状态点', s0?.data?.showStatusChip === true)
  check('默认列表页策略是 manual', s0?.data?.listPagePolicy === 'manual', `policy=${s0?.data?.listPagePolicy}`)

  // 「自动入库」的用例必须先显式声明模式
  check('切到 auto 模式', (await inst.setMode('auto')) === 'auto')
  check('模式已回读为 auto', (await inst.call('GET_SETTINGS'))?.data?.mode === 'auto')

  // ---------------------------------------------------------- 2. 模式闸门
  console.log('\n--- 2. 采集模式闸门（confirm / off 必须拦住自动上报） ---')
  await inst.setMode('confirm')
  const confId = 'ext-confirm-' + Date.now()
  const confAck = await inst.call('CAPTURE', payloadFor(confId), { method: 'auto' })
  check('confirm 模式下自动上报被拒', confAck?.data?.saved === false, JSON.stringify(confAck?.data))
  check('拒绝原因是「需要用户确认」', confAck?.data?.reason === 'needs-confirm', `reason=${confAck?.data?.reason}`)
  check('被拒的没有进队列', (await inst.status()).data.queueCount === 0)
  check(
    '被拒的没有落库',
    !(await fetch(`${API}/api/candidates?q=${confId}&limit=10`).then((r) => r.json()))?.data?.items?.length
  )

  await inst.setMode('off')
  const offId = 'ext-off-' + Date.now()
  const offAck = await inst.call('CAPTURE', payloadFor(offId), { method: 'auto' })
  check('off 模式下自动上报被拒', offAck?.data?.saved === false, JSON.stringify(offAck?.data))
  check('拒绝原因是「已关闭」', offAck?.data?.reason === 'disabled', `reason=${offAck?.data?.reason}`)
  check('off 模式下队列仍为空', (await inst.status()).data.queueCount === 0)

  // ---------------------------------------------------------- 3. 手动保存（off 下也必须能用）
  console.log('\n--- 3. 手动保存（用户明确点了保存，off 模式下也应放行） ---')
  const manId = 'ext-manual-' + Date.now()
  const manAck = await inst.call('CAPTURE', payloadFor(manId, { source: 'manual' }), { method: 'manual' })
  check('off 模式下手动保存被接受', manAck?.data?.saved === true, JSON.stringify(manAck?.data))
  check('回执标明是手动保存', manAck?.data?.method === 'manual', `method=${manAck?.data?.method}`)
  check('未判重（首次入库）', manAck?.data?.duplicated !== true)
  await sleep(400)
  check('手动保存已同步进后端（不在队列里）', (await inst.status()).data.queueCount === 0)

  const manStat = (await inst.status()).data.state
  check('手动保存计入 totalManual', manStat.totalManual >= 1, `totalManual=${manStat.totalManual}`)

  // 后端要能区分「自动采集」与「手动保存」
  const manFound = await fetch(`${API}/api/candidates?q=${encodeURIComponent('测试候选人')}&limit=100`).then((r) => r.json())
  const manHit = (manFound?.data?.items || []).find((r) => r.candidate.name === '测试候选人')
  if (manHit) {
    const detail = await fetch(`${API}/api/candidates/${manHit.candidate.id}`).then((r) => r.json())
    const manualSrc = (detail?.data?.sources || []).find((s) => s.platformCandidateId === manId)
    check('后端来源里记下了 captureMethod=manual', manualSrc?.captureMethod === 'manual', `captureMethod=${manualSrc?.captureMethod}`)
  } else {
    check('后端来源里记下了 captureMethod=manual', false, '未找到候选人')
  }

  console.log('\n--- 3b. 手动保存绕过「本会话已采过」的闸门（交给后端判重） ---')
  const manAck2 = await inst.call('CAPTURE', payloadFor(manId, { source: 'manual' }), { method: 'manual' })
  check('第二次手动保存仍被接受（不被扩展自己吞掉）', manAck2?.data?.saved === true, JSON.stringify(manAck2?.data))
  check('后端如实回报判重', manAck2?.data?.duplicated === true, `duplicated=${manAck2?.data?.duplicated}`)

  // ---------------------------------------------------------- 4. 入队 + 同步（auto）
  console.log('\n--- 4. auto 模式：上报一份简历应自动入队并同步 ---')
  await inst.setMode('auto')
  const id = 'ext-test-' + Date.now()
  await inst.call('CAPTURE', payloadFor(id), { method: 'auto' })
  await sleep(1400)

  const st1 = await inst.status()
  check('GET_STATUS 有响应', !!st1?.ok)
  check('队列已清空（同步成功）', st1?.data?.queueCount === 0, `queueCount=${st1?.data?.queueCount}`)
  check('后端连通状态为真', st1?.data?.health?.ok === true)
  check('累计已入库 ≥1', (st1?.data?.state?.totalSynced ?? 0) >= 1, `totalSynced=${st1?.data?.state?.totalSynced}`)
  check('记录了最近采集人', st1?.data?.state?.lastCandidateId === id)
  check('无遗留错误', !st1?.data?.state?.lastError, st1?.data?.state?.lastError || '')
  check('回传后端地址', st1?.data?.apiBase === API, st1?.data?.apiBase)

  // ---------------------------------------------------------- 5. 重复上报
  console.log('\n--- 5. 同一人重复自动上报（应被会话闸门拦住） ---')
  const before = (await inst.status()).data.state.totalSynced
  const dupAck = await inst.call('CAPTURE', payloadFor(id), { method: 'auto' })
  await sleep(1000)
  const st2 = await inst.status()
  check('闸门回报 already-seen', dupAck?.data?.reason === 'already-seen', `reason=${dupAck?.data?.reason}`)
  check('队列仍为空', st2.data.queueCount === 0)
  check('未重复入库', st2.data.state.totalSynced === before, `before=${before} after=${st2.data.state.totalSynced}`)

  // ---------------------------------------------------------- 6. 落库确认
  console.log('\n--- 6. 后端落库与字段粗提取 ---')
  const found = await fetch(`${API}/api/candidates?q=${encodeURIComponent('测试大学')}&limit=100`).then((r) => r.json())
  const hit = (found?.data?.items || []).find((r) => r.candidate.name === '测试候选人')
  check('检索到该候选人', !!hit, hit ? `${hit.candidate.name} / ${hit.candidate.city} / ${hit.candidate.degree}` : '未找到')
  if (hit) {
    check('解析出城市', hit.candidate.city === '深圳', `city=${hit.candidate.city}`)
    check('解析出学历', hit.candidate.degree === '硕士', `degree=${hit.candidate.degree}`)
    check('解析出年龄', hit.candidate.age === 28, `age=${hit.candidate.age}`)
    check('解析出工作年限', hit.candidate.yearsOfExperience === 5, `yoe=${hit.candidate.yearsOfExperience}`)
    check('解析出期望薪资', hit.candidate.expectedSalary === '30-50k', `salary=${hit.candidate.expectedSalary}`)
    check('解析出当前公司', /测试科技/.test(hit.candidate.currentCompany || ''), hit.candidate.currentCompany)
    check('手机号已脱敏', hit.candidate.phone === '138****0000', `phone=${hit.candidate.phone}`)
    check('邮箱已提取', hit.candidate.email === 'ext@test.com', hit.candidate.email)
    check('来源平台为 boss', hit.platform === 'boss', `platform=${hit.platform}`)
    check('保留了原页链接', /zhipin\.com/.test(hit.resumeUrl || ''), hit.resumeUrl)
  }

  // 看板统计要能区分两种采集方式
  const stats = await fetch(`${API}/api/stats`).then((r) => r.json())
  check('后端统计区分了自动/手动', typeof stats?.data?.capturedByMethod?.auto === 'number', JSON.stringify(stats?.data?.capturedByMethod))
  check('手动保存被单独计数', (stats?.data?.capturedByMethod?.manual ?? 0) >= 1, `manual=${stats?.data?.capturedByMethod?.manual}`)

  // ---------------------------------------------------------- 7. 断网不丢
  console.log('\n--- 7. 后端不可达（应保留在本地队列，不丢数据） ---')
  const offline = await loadInstance(OFFLINE_API, 'offline')
  await offline.setMode('auto')
  const oid = 'ext-offline-' + Date.now()
  await offline.call('CAPTURE', {
    platform: 'liepin',
    platformCandidateId: oid,
    resumeUrl: `https://www.liepin.com/resume/${oid}`,
    rawText: '离线候选人\n30岁  北京\n学历：本科\n3年工作经验',
    capturedAt: new Date().toISOString(),
  }, { method: 'auto' })
  await sleep(2000)
  const ost = await offline.status()
  check('条目保留在本地队列', ost?.data?.queueCount === 1, `queueCount=${ost?.data?.queueCount}`)
  check('队列内容正确', offline.store['capture_queue']?.[0]?.platformCandidateId === oid)
  check('记录了失败原因', !!ost?.data?.state?.lastError, ost?.data?.state?.lastError || '(未记录)')
  check('失败不计入已入库', ost?.data?.state?.totalSynced === 0, `totalSynced=${ost?.data?.state?.totalSynced}`)
  check('连通状态标记为异常', ost?.data?.health?.ok === false)

  console.log('\n--- 7b. 断网时手动保存也要给出「已排队」的诚实回执 ---')
  const omanId = 'ext-offline-manual-' + Date.now()
  const omanAck = await offline.call('CAPTURE', {
    platform: 'liepin',
    platformCandidateId: omanId,
    resumeUrl: `https://www.liepin.com/resume/${omanId}`,
    rawText: '离线手动候选人\n31岁  上海\n学历：硕士\n4年工作经验',
    capturedAt: new Date().toISOString(),
    source: 'manual',
  }, { method: 'manual' })
  check('手动保存被接受', omanAck?.data?.saved === true, JSON.stringify(omanAck?.data))
  check('如实回报「仍在队列里」', omanAck?.data?.queued === true, `queued=${omanAck?.data?.queued}`)
  check('离线队列累计 2 条', (await offline.status())?.data?.queueCount === 2)

  // ---------------------------------------------------------- 8. 恢复补传
  console.log('\n--- 8. 后端恢复后补传（队列不丢，等同浏览器 profile 复用） ---')
  const recovered = await loadInstance(API, 'recovered')
  await recovered.setMode('auto')
  recovered.store['capture_queue'] = structuredClone(offline.store['capture_queue'])
  check('补传前队列有 2 条', (await recovered.status()).data.queueCount === 2)
  await recovered.call('FLUSH_NOW')
  const fst = await recovered.status()
  check('补传后队列清空', fst.data.queueCount === 0, `queueCount=${fst.data.queueCount}`)
  check('补传成功入库 2 条', fst.data.state.totalSynced === 2, `totalSynced=${fst.data.state.totalSynced}`)
  check('其中 1 条计入手动保存', fst.data.state.totalManual === 1, `totalManual=${fst.data.state.totalManual}`)
  check('补传无报错', !fst.data.state.lastError, fst.data.state.lastError || '')

  // 后端确认这条离线简历也进去了
  const found2 = await fetch(`${API}/api/candidates?q=%E7%A6%BB%E7%BA%BF&limit=50`).then((r) => r.json())
  const hit2 = (found2?.data?.items || []).find((r) => r.candidate.name === '离线候选人')
  check('离线条目已落库', !!hit2, hit2 ? `${hit2.candidate.name} / ${hit2.candidate.city} / ${hit2.platform}` : '未找到')
  if (hit2) check('离线简历城市解析正确', hit2.candidate.city === '北京', `city=${hit2.candidate.city}`)

  // ---------------------------------------------------------- 9. 跳过与决策留痕
  console.log('\n--- 9. 跳过这份 / 本页都不再问，以及决策留痕 ---')
  const sig = 'boss|ext-skip-1|1234'
  const skipAck = await recovered.call('SKIP', undefined, { signature: sig, scope: 'once' })
  check('SKIP 有响应', skipAck?.ok === true)
  check('签名进入 skipped_ids', (recovered.store['skipped_ids'] || []).includes(sig))
  check('跳过次数计入 totalSkipped', (await recovered.status())?.data?.state?.totalSkipped === 1)

  const pathKey = 'lpt.liepin.com/recommend'
  await recovered.call('SKIP', undefined, { signature: 'boss|ext-skip-2|99', scope: 'path', pathKey })
  const sAfterPath = (await recovered.call('GET_SETTINGS'))?.data
  check('「本页都不再问」写进了 pausedPaths', !!sAfterPath?.pausedPaths?.[pathKey], JSON.stringify(sAfterPath?.pausedPaths))
  check(
    '暂停有有效期（不是永久静默）',
    typeof sAfterPath?.pausedPaths?.[pathKey] === 'number' && sAfterPath.pausedPaths[pathKey] > Date.now(),
    `until=${sAfterPath?.pausedPaths?.[pathKey]}`
  )

  const log = (await recovered.call('GET_LOG'))?.data
  check('决策留痕有记录', Array.isArray(log) && log.length > 0, `${log?.length} 条`)
  check('留痕里能看到「不存」', (log || []).some((e) => e.action === 'skipped'))

  // 「已保存 / 被拦下 / 手动」这些发生在主实例上 —— 留痕是**按实例的 storage** 存的，
  // 新加载的实例读不到别人的记录（这本身也是实例隔离正确的证据）
  const mainLog = (await inst.call('GET_LOG'))?.data
  check('主实例留痕里能看到「已保存」', (mainLog || []).some((e) => e.action === 'saved'))
  check('主实例留痕里能看到「已拦下」（confirm/off 被拒的）', (mainLog || []).some((e) => e.action === 'rejected'))
  check('主实例留痕区分了手动/自动', (mainLog || []).some((e) => e.method === 'manual'))
  check(
    '留痕里带着被拒的原因，便于事后查为什么没入库',
    (mainLog || []).some((e) => e.action === 'rejected' && !!e.reason),
    (mainLog || []).find((e) => e.action === 'rejected')?.reason || ''
  )
  check('新实例读不到别人的留痕（实例隔离）', !(log || []).some((e) => e.action === 'saved'))

  // ---------------------------------------------------------- 10. 清空队列
  console.log('\n--- 10. 清空本地队列 ---')
  await offline.call('CLEAR_QUEUE')
  const cst = await offline.status()
  check('清空后队列为 0', cst.data.queueCount === 0)
  check('队列存储已置空', Array.isArray(offline.store['capture_queue']) && offline.store['capture_queue'].length === 0)
  check('已捕获记录一并重置', !offline.store['captured_ids'])
  check('已跳过记录一并重置（否则想重采会被自己挡住）', !offline.store['skipped_ids'])
  check('主实例存储未受影响（实例隔离）', inst.store['capture_state']?.totalSynced >= 1)
} finally {
  cleanup()
}

console.log(`\n=== 结果：通过 ${pass}，失败 ${fail} ===`)
process.exit(fail === 0 ? 0 : 1)
