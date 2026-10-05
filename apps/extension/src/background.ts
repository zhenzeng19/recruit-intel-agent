// ============================================================
// background service worker
// 职责：接收 content 上报 → 本地缓冲（断网不丢）→ 静默同步到后端
// 并向前台 popup 暴露「采集队列 / 后端连通 / 同步结果」状态
//
// 采集开关与手动保存的**权威状态**都在这一层（chrome.storage.local）：
//   capture_settings  用户设置（模式 / 状态点 / 卡片位置 / 本页暂停 / 列表页策略）
//   capture_log       最近 20 次决策留痕（回答「我刚才到底存没存」）
//   skipped_ids       被用户「这次不存」的签名
// content script 直接读同一份 storage（并监听 onChanged 实时生效），
// 但**上报仍要在这里再过一次闸门** —— 用户刚关掉开关时，
// 页面里可能已经有一个在途的采集，不能让它钻过去。
// ============================================================
import {
  DEFAULT_CAPTURE_SETTINGS,
  guessResumeName,
  type ApiResult,
  type CaptureAck,
  type CaptureLogEntry,
  type CaptureMethod,
  type CapturePayload,
  type CaptureResult,
  type CaptureSettings,
  type Platform,
  type SkipScope,
} from '@ria/shared'

// 构建期由 esbuild define 注入（见 build.mjs，取自 .env 的 VITE_API_BASE）
declare const __API_BASE__: string

const API_BASE = __API_BASE__ || 'http://localhost:8787'
const QUEUE_KEY = 'capture_queue'
const STATE_KEY = 'capture_state'
const SEEN_KEY = 'captured_ids'
const SETTINGS_KEY = 'capture_settings'
const LOG_KEY = 'capture_log'
const SKIP_KEY = 'skipped_ids'
/** 岗位列表缓存（保存时选岗位的下拉要用它） */
const POS_KEY = 'positions_cache'

/** 「本页都不再问」的有效期：见过期自动恢复，避免永久静默让人一头雾水 */
const PATH_PAUSE_MS = 7 * 24 * 3600 * 1000
const LOG_MAX = 20
const SKIP_MAX = 200

interface QueueItem extends CapturePayload {
  queuedAt: string
}

/** 持久化的运行状态（供 popup 展示） */
export interface CaptureState {
  lastSyncAt: string | null
  lastError: string | null
  totalSynced: number       // 累计成功入库条数
  totalDuplicated: number   // 累计被判重条数
  totalManual: number       // 其中手动保存成功入库的条数（人工兜底的量）
  totalSkipped: number      // 用户选择「不存」的次数
  lastPlatform: Platform | null
  lastCandidateId: string | null
}

const DEFAULT_STATE: CaptureState = {
  lastSyncAt: null,
  lastError: null,
  totalSynced: 0,
  totalDuplicated: 0,
  totalManual: 0,
  totalSkipped: 0,
  lastPlatform: null,
  lastCandidateId: null,
}

// ------------------------------------------------------------ 设置

/** 读设置并把默认值补齐（新增字段时老数据不会缺键） */
async function readSettings(): Promise<CaptureSettings> {
  const r = await chrome.storage.local.get(SETTINGS_KEY)
  const raw = (r[SETTINGS_KEY] as Partial<CaptureSettings> | undefined) ?? {}
  return {
    ...DEFAULT_CAPTURE_SETTINGS,
    ...raw,
    pausedPaths: { ...(raw.pausedPaths ?? {}) },
  }
}

async function writeSettings(next: CaptureSettings): Promise<CaptureSettings> {
  // 顺手清掉已过期的「本页暂停」
  const now = Date.now()
  const paused: Record<string, number> = {}
  for (const [k, v] of Object.entries(next.pausedPaths ?? {})) {
    if (typeof v === 'number' && v > now) paused[k] = v
  }
  const clean: CaptureSettings = { ...next, pausedPaths: paused }
  await chrome.storage.local.set({ [SETTINGS_KEY]: clean })
  return clean
}

async function patchSettings(patch: Partial<CaptureSettings>): Promise<CaptureSettings> {
  const cur = await readSettings()
  return writeSettings({
    ...cur,
    ...patch,
    // pausedPaths 是「按 key 合并」，整对象覆盖会把其他页的暂停记录抹掉
    pausedPaths: { ...cur.pausedPaths, ...(patch.pausedPaths ?? {}) },
  })
}

// ------------------------------------------------------------ 决策留痕

async function pushLog(entry: CaptureLogEntry): Promise<void> {
  const r = await chrome.storage.local.get(LOG_KEY)
  const list = (r[LOG_KEY] as CaptureLogEntry[] | undefined) ?? []
  list.unshift(entry)
  await chrome.storage.local.set({ [LOG_KEY]: list.slice(0, LOG_MAX) })
}

function entryFor(
  payload: CapturePayload,
  action: CaptureLogEntry['action'],
  method: CaptureMethod,
  reason?: string
): CaptureLogEntry {
  return {
    at: new Date().toISOString(),
    platform: payload.platform,
    platformCandidateId: payload.platformCandidateId,
    name: guessResumeName(payload.rawText) || '未识别姓名',
    chars: (payload.rawText || '').length,
    action,
    method,
    reason,
  }
}

async function readSkipped(): Promise<string[]> {
  const r = await chrome.storage.local.get(SKIP_KEY)
  return (r[SKIP_KEY] as string[] | undefined) ?? []
}

// ------------------------------------------------------------ 岗位列表（带缓存）

/** 岗位缓存的存活时间：岗位变动不频繁，5 分钟足够，省掉每次弹卡都往返 */
const POS_TTL_MS = 5 * 60 * 1000

export interface PositionLite {
  id: string
  title: string
  status: string
  city?: string
  department?: string
}

/**
 * 取岗位列表。
 *
 * 为什么由 background 去拉、而不是让 content / popup 自己 fetch：
 *   content script 里的 fetch 跑在**页面源**下，要受页面 CSP / CORS 约束；
 *   而 background 的 fetch 用的是扩展自己的 host_permissions，干净得多。
 *   顺便还能缓存 —— 卡片每次弹出来都请求一次后端没必要。
 */
async function readPositions(force = false): Promise<{ list: PositionLite[]; stale: boolean }> {
  const cached = await chrome.storage.local.get(POS_KEY)
  const hit = cached[POS_KEY] as { at: number; list: PositionLite[] } | undefined
  if (!force && hit && Date.now() - hit.at < POS_TTL_MS) {
    return { list: hit.list ?? [], stale: false }
  }
  try {
    const resp = await fetch(`${API_BASE}/api/positions`)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const json = (await resp.json()) as ApiResult<PositionLite[]>
    if (!json.ok || !json.data) throw new Error(json.error || '后端返回异常')
    // 只留在招/暂停的：已关闭的岗位不该出现在「挂到哪个岗位」的下拉里
    const list = json.data
      .filter((p) => p.status !== 'closed')
      .map((p) => ({ id: p.id, title: p.title, status: p.status, city: p.city, department: p.department }))
    await chrome.storage.local.set({ [POS_KEY]: { at: Date.now(), list } })
    return { list, stale: false }
  } catch {
    // 后端没起来 → 退回上次缓存（宁可给旧列表，也别让下拉是空的）
    return { list: hit?.list ?? [], stale: true }
  }
}

async function addSkipped(signature: string): Promise<void> {
  if (!signature) return
  const list = await readSkipped()
  const next = [signature, ...list.filter((s) => s !== signature)].slice(0, SKIP_MAX)
  await chrome.storage.local.set({ [SKIP_KEY]: next })
}

async function readQueue(): Promise<QueueItem[]> {
  const r = await chrome.storage.local.get(QUEUE_KEY)
  return (r[QUEUE_KEY] as QueueItem[] | undefined) ?? []
}

async function writeQueue(items: QueueItem[]) {
  await chrome.storage.local.set({ [QUEUE_KEY]: items })
}

async function readState(): Promise<CaptureState> {
  const r = await chrome.storage.local.get(STATE_KEY)
  return { ...DEFAULT_STATE, ...((r[STATE_KEY] as CaptureState | undefined) ?? {}) }
}

async function patchState(patch: Partial<CaptureState>) {
  const next = { ...(await readState()), ...patch }
  await chrome.storage.local.set({ [STATE_KEY]: next })
  return next
}

/**
 * 会话内已捕获集合：用于拦住「同一页面 DOM 抖动导致重复入队」。
 * 持久化到 storage，service worker 被回收后依然有效。
 */
async function markSeen(platform: Platform, id: string): Promise<boolean> {
  const r = await chrome.storage.local.get(SEEN_KEY)
  const seen = (r[SEEN_KEY] as Record<string, number> | undefined) ?? {}
  const key = `${platform}:${id}`
  if (seen[key]) return false
  seen[key] = Date.now()
  // 只保留最近 500 条，防止无限增长
  const keys = Object.keys(seen)
  if (keys.length > 500) {
    keys
      .sort((a, b) => seen[a] - seen[b])
      .slice(0, keys.length - 500)
      .forEach((k) => delete seen[k])
  }
  await chrome.storage.local.set({ [SEEN_KEY]: seen })
  return true
}

/**
 * 接受一次采集：过闸门 → 落本地队列 → 尝试同步 → 如实回执。
 *
 * 三个闸门：
 *   ① 模式：off 拒绝一切自动上报；confirm 拒绝一切自动上报
 *      （confirm 模式下 content 应该先问用户，不会发 auto 上报 ——
 *       这里再拦一次是因为「用户刚关掉开关，页面里还有一个在途采集」
 *       这种时序缝隙真的存在）
 *   ② 会话内已见：只对 auto 生效。**手动保存刻意绕过** ——
 *      用户明确点了保存，该由后端判重给出「这份已经存过」的诚实答复，
 *      而不是被扩展自己悄悄吞掉。
 *   ③ 队列内已存在同来源：避免同一份在队列里排两次（后端没起时尤其明显）
 */
async function accept(payload: CapturePayload, method: CaptureMethod): Promise<CaptureAck> {
  const settings = await readSettings()

  if (method === 'auto') {
    if (settings.mode === 'off') {
      await pushLog(entryFor(payload, 'rejected', method, '自动采集已关闭'))
      return { saved: false, queued: false, method, reason: 'disabled' }
    }
    if (settings.mode === 'confirm') {
      await pushLog(entryFor(payload, 'rejected', method, '需要用户确认后才入库'))
      return { saved: false, queued: false, method, reason: 'needs-confirm' }
    }
    const isNew = await markSeen(payload.platform, payload.platformCandidateId)
    if (!isNew) {
      return { saved: false, queued: false, method, reason: 'already-seen' }
    }
  }

  const queue = await readQueue()
  const dup = queue.some(
    (q) => q.platform === payload.platform && q.platformCandidateId === payload.platformCandidateId
  )
  if (!dup) {
    queue.push({
      ...payload,
      source: payload.source ?? method,
      queuedAt: new Date().toISOString(),
    })
    await writeQueue(queue)
  }
  await patchState({
    lastPlatform: payload.platform,
    lastCandidateId: payload.platformCandidateId,
  })

  // 同步尝试后就地给出真实回执 —— 手动保存必须让用户看到「存了没」
  const result = await flush()
  const stillQueued = (await readQueue()).some(
    (q) => q.platform === payload.platform && q.platformCandidateId === payload.platformCandidateId
  )

  await pushLog(
    entryFor(
      payload,
      stillQueued ? 'queued' : result.duplicated > 0 ? 'duplicated' : 'saved',
      method,
      stillQueued ? `后端未连上（${API_BASE}），已排队等补传` : undefined
    )
  )

  // 后端这次入库给了什么归属？把它的答复转成回执，让用户看得到「挂到哪个岗位了」
  const serverData = result.results.find(
    (r) => r.platformCandidateId === payload.platformCandidateId
  )?.data

  let matched: CaptureAck['matched'] = null
  if (serverData?.autoMatched) {
    const pos = (await readPositions()).list.find((p) => p.id === serverData.autoMatched!.positionId)
    matched = {
      positionId: serverData.autoMatched.positionId,
      title: pos?.title ?? serverData.autoMatched.positionId,
      score: serverData.autoMatched.score,
      assignedBy: serverData.assignedBy ?? 'rule',
    }
  }

  return {
    saved: true,
    queued: stillQueued,
    duplicated: !stillQueued && result.duplicated > 0 ? true : undefined,
    method,
    matched,
    ruleSuggested: serverData?.ruleSuggested ?? null,
  }
}

/** 一次同步里每条的后端答复（accept 要用它给用户回执） */
interface FlushResult {
  synced: number
  duplicated: number
  remaining: number
  error: string | null
  /** 后端对每条的处理结果，按 platformCandidateId 关联 */
  results: Array<{ platformCandidateId: string; data?: CaptureResult }>
}

/** 出队：逐条上报后端，失败则保留在队列里等下次 */
async function flush(): Promise<FlushResult> {
  const queue = await readQueue()
  if (queue.length === 0) {
    await patchState({ lastSyncAt: new Date().toISOString(), lastError: null })
    return { synced: 0, duplicated: 0, remaining: 0, error: null, results: [] }
  }

  const remain: QueueItem[] = []
  const results: FlushResult['results'] = []
  let synced = 0
  let duplicated = 0
  let manualSynced = 0
  let lastError: string | null = null

  for (const item of queue) {
    try {
      const resp = await fetch(`${API_BASE}/api/capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item),
      })
      if (!resp.ok) {
        remain.push(item)
        lastError = `后端返回 HTTP ${resp.status}`
        continue
      }
      const json = (await resp.json()) as ApiResult<CaptureResult>
      if (!json.ok) {
        remain.push(item)
        lastError = json.error || '后端拒绝该条数据'
        continue
      }
      results.push({ platformCandidateId: item.platformCandidateId, data: json.data })
      if (json.data?.duplicated) duplicated++
      else {
        synced++
        if (item.source === 'manual') manualSynced++
      }
    } catch (e) {
      remain.push(item) // 后端没起来 / 断网：整条保留
      lastError = `无法连接后端（${API_BASE}）`
    }
  }

  await writeQueue(remain)
  const prev = await readState()
  await patchState({
    lastSyncAt: new Date().toISOString(),
    lastError,
    totalSynced: prev.totalSynced + synced,
    totalDuplicated: prev.totalDuplicated + duplicated,
    totalManual: prev.totalManual + manualSynced,
  })

  if (synced > 0 || duplicated > 0) {
    console.log(`[招聘捕手] 同步完成：新增 ${synced}，判重 ${duplicated}，剩余 ${remain.length}`)
  }
  return { synced, duplicated, remaining: remain.length, error: lastError, results }
}

/** 探活后端 */
async function ping(): Promise<{ ok: boolean; dataDir?: string; error?: string }> {
  try {
    const resp = await fetch(`${API_BASE}/api/health`)
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` }
    const json = (await resp.json()) as ApiResult<{ dataDir?: string; status?: string }>
    return { ok: true, dataDir: json.data?.dataDir }
  } catch {
    return { ok: false, error: `无法连接 ${API_BASE}` }
  }
}

// ------------------------------------------------------------ 消息路由
interface IncomingMessage {
  type?: string
  payload?: CapturePayload
  method?: CaptureMethod
  patch?: Partial<CaptureSettings>
  signature?: string
  scope?: SkipScope
  pathKey?: string
  force?: boolean
}

chrome.runtime.onMessage.addListener((msg: IncomingMessage, _sender, sendResponse) => {
  if (msg?.type === 'CAPTURE' && msg.payload) {
    // 从「发射后不管」改成有回包：手动保存必须给用户真实结果
    // （已保存 / 后端没连上已排队 / 后端判重），否则只能骗用户。
    const method: CaptureMethod = msg.method ?? msg.payload.source ?? 'auto'
    void (async () => {
      try {
        sendResponse({ ok: true, data: await accept(msg.payload!, method) })
      } catch (e) {
        sendResponse({ ok: false, error: (e as Error)?.message ?? String(e) })
      }
    })()
    return true // 异步响应
  }

  if (msg?.type === 'GET_SETTINGS') {
    void (async () => {
      sendResponse({ ok: true, data: await readSettings() })
    })()
    return true
  }

  /**
   * 岗位列表（保存时选岗位的下拉用）。
   * 走 background 拉取 + 5 分钟缓存，content / popup 只拿结果。
   */
  if (msg?.type === 'GET_POSITIONS') {
    void (async () => {
      const r = await readPositions(msg.force === true)
      sendResponse({ ok: true, data: r })
    })()
    return true
  }

  if (msg?.type === 'SET_SETTINGS') {
    void (async () => {
      sendResponse({ ok: true, data: await patchSettings(msg.patch ?? {}) })
    })()
    return true
  }

  if (msg?.type === 'SKIP') {
    void (async () => {
      const signature = msg.signature ?? ''
      await addSkipped(signature)
      if (msg.scope === 'path' && msg.pathKey) {
        const cur = await readSettings()
        await patchSettings({
          pausedPaths: { ...cur.pausedPaths, [msg.pathKey]: Date.now() + PATH_PAUSE_MS },
        })
      }
      const prev = await readState()
      await patchState({ totalSkipped: prev.totalSkipped + 1 })
      await pushLog({
        at: new Date().toISOString(),
        platform: 'other',
        platformCandidateId: signature,
        name: msg.pathKey ? '（本页）' : '（这份）',
        chars: 0,
        action: 'skipped',
        method: 'auto',
        reason: msg.scope === 'path' ? '本页都不再问' : '这一次不存',
      })
      sendResponse({ ok: true, data: { skipped: true, scope: msg.scope ?? 'once' } })
    })()
    return true
  }

  if (msg?.type === 'RESUME_PATH' && msg.pathKey) {
    void (async () => {
      const cur = await readSettings()
      const next = { ...cur.pausedPaths }
      delete next[msg.pathKey!]
      sendResponse({ ok: true, data: await patchSettings({ pausedPaths: next }) })
    })()
    return true
  }

  if (msg?.type === 'GET_LOG') {
    void (async () => {
      const r = await chrome.storage.local.get(LOG_KEY)
      sendResponse({ ok: true, data: (r[LOG_KEY] as CaptureLogEntry[] | undefined) ?? [] })
    })()
    return true
  }

  if (msg?.type === 'GET_STATUS') {
    void (async () => {
      const [queue, state, health, settings, log, skipped] = await Promise.all([
        readQueue(),
        readState(),
        ping(),
        readSettings(),
        chrome.storage.local.get(LOG_KEY).then((r) => (r[LOG_KEY] as CaptureLogEntry[] | undefined) ?? []),
        readSkipped(),
      ])
      sendResponse({
        ok: true,
        data: { queueCount: queue.length, state, health, apiBase: API_BASE, settings, log, skippedCount: skipped.length },
      })
    })()
    return true // 异步响应
  }

  if (msg?.type === 'FLUSH_NOW') {
    void (async () => {
      const result = await flush()
      const queue = await readQueue()
      sendResponse({ ok: true, data: { ...result, queueCount: queue.length } })
    })()
    return true
  }

  if (msg?.type === 'CLEAR_QUEUE') {
    void (async () => {
      await writeQueue([])
      // 一并清掉「已见」与「已跳过」：否则用户清空队列后想重新采同一份，
      // 会被这两份记忆挡住。决策留痕（log）刻意保留，便于事后回溯。
      await chrome.storage.local.remove([SEEN_KEY, SKIP_KEY])
      sendResponse({ ok: true, data: { queueCount: 0 } })
    })()
    return true
  }

  return false
})

// 定时兜底重试（需要 manifest 里声明 "alarms" 权限，否则 chrome.alarms 为 undefined）
if (chrome.alarms) {
  chrome.alarms.create('flush', { periodInMinutes: 5 })
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === 'flush') void flush()
  })
} else {
  console.warn('[招聘捕手] 缺少 alarms 权限，定时重试未启用')
}

// 安装/更新时给一次状态初始化
chrome.runtime.onInstalled?.addListener(() => {
  void (async () => {
    await patchState({ lastError: null })
    // 把默认设置落一次盘：默认值只在 @ria/shared 里定义一份，
    // 这里物化一下，popup 与 content 首屏直接就能读到，不用各自补默认
    await writeSettings(await readSettings())
  })()
})

// service worker 每次启动都确保状态存在（onInstalled 只在安装/更新时触发，
// 之后 SW 被回收重启就不会再跑，popup 首屏会读到空状态）
void patchState({})

console.log('[招聘捕手] background 已启动，后端地址：' + API_BASE)
