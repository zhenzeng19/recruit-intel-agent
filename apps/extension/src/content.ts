// ============================================================
// content script
// 运行在 zhipin.com / liepin.com 的页面（含全部子域、含 iframe）
// 职责：监听 SPA 状态变化 → 定位简历内容区 → 按用户设置决定怎么处理
// 原则：只读页面已展示、用户肉眼可见的内容，不主动发起任何请求
//
// 三种模式（captureMode，来自 chrome.storage.local.capture_settings）：
//   auto    识别到就静默入库，页面上只留一个收起的小圆点 + 手动补采
//   confirm 识别到先弹卡片问「保存 / 这次不存 / 本页都不再问」，不点不存（默认）
//   off     完全停手（页面零打扰；手动保存仍可从扩展面板或 __ria.save() 触发）
//
// 设置是**实时生效**的：content 直接读同一份 storage 并监听 onChanged，
// 所以在 popup 里改开关不用刷新页面。
// ============================================================
import {
  DEFAULT_CAPTURE_SETTINGS,
  guessResumeName,
  extractRecommendedPosition,
  splitResume,
  type CaptureAck,
  type CaptureMethod,
  type CapturePayload,
  type CaptureSettings,
  type SkipScope,
} from '@ria/shared'
import {
  decideCapture,
  diagnose,
  extractForced,
  extractFrom,
  isListPage,
  pathKeyOf,
  resolveSite,
  signatureOf,
  type ExtractOutcome,
  type PageLocation,
  type SiteProfile,
} from './extract'
import {
  Overlay,
  type OverlayFeedback,
  type OverlayPosition,
  type OverlayResume,
  type OverlayView,
} from './overlay'

const SETTINGS_KEY = 'capture_settings'

const site: SiteProfile | null = resolveSite(location.hostname)

if (!site) {
  // 命中的不是支持的站点（例如招聘页里内嵌的第三方 iframe），静默退出
} else {
  bootstrap(site)
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function pageLocation(): PageLocation {
  return {
    href: location.href,
    hostname: location.hostname,
    pathname: location.pathname,
    search: location.search,
    hash: location.hash,
  }
}

function resumeInfo(payload: CapturePayload, lowConfidence?: boolean, listPage?: boolean): OverlayResume {
  return {
    name: guessResumeName(payload.rawText) || '未识别姓名',
    chars: (payload.rawText || '').length,
    lowConfidence,
    listPage,
  }
}

function bootstrap(site: SiteProfile) {
  /** 简历面板是异步渲染的，给它足够时间 */
  const WAIT_MS = 12000
  const POLL_MS = 600
  /** DOM 抖动防抖 */
  const DEBOUNCE_MS = 700
  /** 两次完整扫描之间的最小间隔，避免 IM 高频变化时反复遍历 DOM */
  const COOLDOWN_MS = 1500

  // ---------------------------------------------------------- 状态
  let settings: CaptureSettings = { ...DEFAULT_CAPTURE_SETTINGS }
  let overlay: Overlay | null = null

  /** 最近一次成功提取（用于状态展示与「保存这一页」） */
  let currentOutcome: ExtractOutcome | null = null
  /** confirm 模式下等待用户决定的 `那一份`（用户点保存时用它，而不是重新提取） */
  let pendingOutcome: ExtractOutcome | null = null
  /** 上一个已上报的签名 */
  let lastSignature = ''
  /** 正在询问中的签名（防止同一份反复弹卡） */
  let askingSignature = ''
  /** 本页生命周期内被「这次不存」的签名（内存态，持久化那份在 background） */
  const dismissed = new Set<string>()
  /** 页面上要显示的那份简历 */
  let lastResume: OverlayResume | null = null
  /** 当前要显示的回执（会一直留到下一次状态变化） */
  let feedback: OverlayFeedback | null = null
  /** 本页是否被本地标记为暂停（在 storage 往返之前就先生效） */
  let pathPausedLocal = false

  // ---- 岗位归属（保存时选岗位）
  /** 可选的岗位列表（由 background 拉取并缓存） */
  let positions: OverlayPosition[] = []
  /** 当前下拉选中的岗位（空 = 不指定） */
  let selectedPositionId = ''
  /** 平台推荐的职位（猎聘头部的「推荐职位：X」） */
  let recommendedTitle = ''
  /** 规则原本推荐谁 —— 用户选岗后用来提示「也挂上」 */
  let ruleSuggested: { positionId: string; title: string; score: number } | null = null

  let scanning = false
  let pending = false
  let lastScanAt = 0
  let debounceTimer: number | undefined
  let coolTimer: number | undefined
  let observersOn = false
  let mutationObserver: MutationObserver | null = null

  const inIframe = (() => {
    try {
      return window.top !== window
    } catch {
      return true
    }
  })()
  const frameLabel = inIframe ? `iframe(${location.hostname})` : 'top'

  function log(icon: string, msg: string) {
    console.log(`[招聘捕手] ${icon} ${msg}`)
  }

  // ---------------------------------------------------------- 设置

  async function loadSettings(): Promise<CaptureSettings> {
    try {
      const r = await chrome.storage.local.get(SETTINGS_KEY)
      const raw = (r[SETTINGS_KEY] as Partial<CaptureSettings> | undefined) ?? {}
      return {
        ...DEFAULT_CAPTURE_SETTINGS,
        ...raw,
        pausedPaths: { ...(raw.pausedPaths ?? {}) },
      }
    } catch {
      return { ...DEFAULT_CAPTURE_SETTINGS }
    }
  }

  /** 本页是否被用户选择过「都不再问」（过期的自动失效） */
  function isPathPaused(): boolean {
    if (pathPausedLocal) return true
    const until = settings.pausedPaths?.[pathKeyOf(pageLocation())]
    return typeof until === 'number' && until > Date.now()
  }

  function currentListPolicy(): 'skip' | 'manual' | 'normal' {
    if (!isListPage(site, pageLocation())) return 'normal'
    return settings.listPagePolicy
  }

  // ---------------------------------------------------------- 岗位列表

  /** 从 background 取岗位列表（带缓存）。失败也不影响采集，只是下拉为空。 */
  async function loadPositions(): Promise<void> {
    try {
      const resp = (await chrome.runtime.sendMessage({ type: 'GET_POSITIONS' })) as
        | { ok: boolean; data?: { list: OverlayPosition[]; stale: boolean } }
        | undefined
      if (resp?.ok && resp.data) positions = resp.data.list
    } catch {
      /* background 未就绪：保持上一次的列表 */
    }
  }

  /**
   * 下拉的默认选中项。优先级：
   *   ① 平台推荐的职位能在岗位里精确命中 → 用它（猎聘自己说的比我们猜的可信）
   *   ② 上次保存时选过的岗位（同一批简历往往同岗位，省得每次重选）
   *   ③ 空 = 不指定（按规则自动挂）
   */
  function preferredPositionId(): string {
    const byRec = positions.find((p) => p.title === recommendedTitle)
    if (byRec) return byRec.id
    if (settings.lastPositionId && positions.some((p) => p.id === settings.lastPositionId)) {
      return settings.lastPositionId
    }
    return ''
  }

  /** 记住这次选的岗位，下次默认就用它（不指定则清掉记忆） */
  async function rememberPosition(positionId: string): Promise<void> {
    try {
      await chrome.runtime.sendMessage({
        type: 'SET_SETTINGS',
        patch: { lastPositionId: positionId || undefined },
      })
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------- 触发源（可整体停手）

  const origPush = history.pushState
  const origReplace = history.replaceState
  const patchedPush = function (...args: Parameters<typeof origPush>) {
    const ret = origPush.apply(history, args)
    schedule()
    return ret
  }
  const patchedReplace = function (...args: Parameters<typeof origReplace>) {
    const ret = origReplace.apply(history, args)
    schedule()
    return ret
  }

  function startObservers(): void {
    if (observersOn) return
    observersOn = true
    window.addEventListener('load', schedule)
    window.addEventListener('popstate', schedule)
    // 猎聘 IM 页点开简历走的是 hash 变化（...#preview），
    // 早先没有这个监听，等于完全错过。
    window.addEventListener('hashchange', schedule)
    history.pushState = patchedPush
    history.replaceState = patchedReplace
    try {
      // DOM 兜底：IM 页里切换候选人往往「URL 完全不变」，
      // 只有右侧面板在换内容 —— 这是主要的触发路径。
      mutationObserver = new MutationObserver(schedule)
      mutationObserver.observe(document.documentElement, { childList: true, subtree: true })
    } catch {
      mutationObserver = null
    }
  }

  /** off 模式下彻底停手：不监听、不扫描、不注入 DOM */
  function stopObservers(): void {
    if (!observersOn) return
    observersOn = false
    window.removeEventListener('load', schedule)
    window.removeEventListener('popstate', schedule)
    window.removeEventListener('hashchange', schedule)
    history.pushState = origPush
    history.replaceState = origReplace
    mutationObserver?.disconnect()
    mutationObserver = null
    window.clearTimeout(debounceTimer)
    window.clearTimeout(coolTimer)
    scanning = false
    pending = false
  }

  function applySettings(next: CaptureSettings): void {
    const wasOff = settings.mode === 'off'
    settings = next

    if (next.mode === 'off') {
      stopObservers()
      currentOutcome = null
      pendingOutcome = null
      askingSignature = ''
      lastResume = null
      feedback = null
      overlay?.destroy()
      log('⏸', '自动采集已关闭（可在扩展面板里重新开启）')
      return
    }

    startObservers()
    if (wasOff) {
      // 从「关闭」切回来 —— 立刻扫一次，不用等 DOM 变化
      log('▶', `自动采集已开启（${next.mode === 'auto' ? '自动保存' : '保存前询问'}）`)
      schedule()
    }
    paint(null)
  }

  // ---------------------------------------------------------- 渲染

  /**
   * 渲染卡片。不传参数 = 保持当前回执不变 ——
   * 扫描是高频的（MutationObserver 触发），如果每次扫描都清空回执，
   * 用户刚看到的「已保存 ✓」会在两秒后自己消失。
   */
  function paint(fb?: OverlayFeedback | null): void {
    if (fb !== undefined) feedback = fb
    if (!overlay) return
    const view: OverlayView = {
      mode: settings.mode,
      showStatusChip: settings.showStatusChip,
      resume: lastResume,
      asking: !!askingSignature,
      pathPaused: isPathPaused(),
      feedback,
      positions,
      selectedPositionId,
      recommendedTitle,
      ruleSuggested,
    }
    overlay.render(view)
  }

  // ---------------------------------------------------------- 与 background 通信

  async function sendCapture(payload: CapturePayload, method: CaptureMethod): Promise<CaptureAck | null> {
    try {
      const resp = (await chrome.runtime.sendMessage({ type: 'CAPTURE', payload, method })) as
        | { ok: boolean; data?: CaptureAck; error?: string }
        | undefined
      if (resp?.ok && resp.data) return resp.data
      return null
    } catch {
      // background 未就绪（SW 正在启动 / 刚被回收）—— 由调用方给出诚实提示
      return null
    }
  }

  function feedbackFromAck(ack: CaptureAck | null, fallbackText = '这次没能上报'): OverlayFeedback {
    if (!ack) return { kind: 'err', text: `${fallbackText}：扩展后台没有响应，请重新加载扩展后再试。` }
    const how = ack.method === 'manual' ? '手动保存' : '自动采集'
    if (ack.reason === 'disabled') return { kind: 'warn', text: '自动采集已关闭，这一份没有入库。' }
    if (ack.reason === 'needs-confirm') return { kind: 'warn', text: '需要你确认后才入库，这一份没有保存。' }
    if (ack.reason === 'already-seen') return { kind: 'ok', text: '这一份之前已经处理过，没有重复入库。' }
    if (ack.queued) {
      return {
        kind: 'warn',
        text: `后端没连上，${how}的这份已排进本地队列（等看台服务起来会自动补传）。`,
      }
    }
    if (ack.duplicated) return { kind: 'ok', text: '看台里已经存在这份简历，判重跳过（未重复建档）。' }
    const where = ack.matched ? `，已挂到「${ack.matched.title}」` : ''
    return {
      kind: 'ok',
      text: ack.method === 'manual' ? `已手动保存到看板 ✓${where}` : `已自动保存到看板 ✓${where}`,
    }
  }

  // ---------------------------------------------------------- 核心：一次扫描

  async function scanOnce(): Promise<void> {
    const deadline = Date.now() + WAIT_MS
    for (;;) {
      const outcome = extractFrom(document, pageLocation(), site)
      if (outcome.ok && outcome.payload) {
        currentOutcome = outcome
        await handleOutcome(outcome)
        return
      }
      if (Date.now() >= deadline) {
        lastResume = null
        // 不清回执：上一次保存的结果要让用户看得到
        paint()
        return
      }
      await sleep(POLL_MS)
    }
  }

  async function handleOutcome(outcome: ExtractOutcome): Promise<void> {
    const payload = outcome.payload
    if (!payload) return

    const sig = signatureOf(payload)
    const decision = decideCapture({
      mode: settings.mode,
      outcomeOk: true,
      signature: sig,
      lastSignature,
      askingSignature,
      dismissed: [...dismissed],
      pathPaused: isPathPaused(),
      listPolicy: currentListPolicy(),
    })

    if (decision.action === 'ignore') {
      if (decision.reason === 'off') {
        overlay?.destroy()
      } else if (decision.reason === 'path-paused') {
        // 不销毁：卡片要显示「本页已暂停 + 恢复」的入口，否则用户只能去 popup 里找
        askingSignature = ''
        pendingOutcome = null
        paint(null)
      }
      return
    }

    if (decision.action === 'capture') {
      // 先占住签名再 await：MutationObserver 会连着触发好几次，
      // 不先置位就会把同一份连发多遍。
      lastSignature = sig
      lastResume = resumeInfo(payload)
      const ack = await sendCapture(payload, 'auto')
      if (ack) {
        log(
          ack.queued ? '⏳' : ack.duplicated ? '＝' : '✓',
          `${ack.method === 'manual' ? '手动' : '自动'}采集：${payload.platformCandidateId}` +
            `（${outcome.via === 'selector' ? '站点选择器' : '智能识别'}，${outcome.chars} 字）` +
            (ack.queued ? ' · 后端未连上，已排队' : ack.duplicated ? ' · 判重跳过' : '')
        )
      }
      paint(feedbackFromAck(ack))
      return
    }

    // decision.action === 'ask'
    askingSignature = sig
    pendingOutcome = outcome
    lastResume = resumeInfo(payload, false, decision.listPage)
    feedback = null
    ruleSuggested = null

    // 平台推荐的职位（猎聘头部「推荐职位：项目经理」）—— 用来做下拉的默认值
    try {
      recommendedTitle = extractRecommendedPosition(splitResume(payload.rawText).header) ?? ''
    } catch {
      recommendedTitle = ''
    }
    // 岗位列表与默认选中项都要在弹卡之前就绪，否则用户看到的是空下拉
    await loadPositions()
    selectedPositionId = preferredPositionId()

    paint(null)
    if (decision.listPage) log('!', '这一页像是列表页（一屏多人），已跳过自动采集')
  }

  // ---------------------------------------------------------- 手动保存

  function confirmRisky(forced: { wholePage?: boolean; listWarning?: { isList: boolean }; chars?: number }): boolean {
    if (forced.wholePage) {
      const n = forced.chars ?? 0
      return window.confirm(
        `这一页没找到明确的简历区块。\n\n准备保存「整页文本」（约 ${n} 字），里面可能混进导航、会话列表等无关内容。\n\n确定要保存吗？`
      )
    }
    if (forced.listWarning?.isList) {
      return window.confirm(
        '这块内容看起来包含了多位候选人（像是列表页）。\n\n确定要把这一整块当成一份简历保存吗？'
      )
    }
    return true
  }

  /**
   * 手动保存。
   * @param positionId 用户在卡片/popup 里选的岗位（空 = 不指定，后端按规则自动挂）
   */
  async function manualSave(positionId?: string): Promise<OverlayFeedback> {
    const forced = extractForced(document, pageLocation(), site)
    if (!forced.ok || !forced.payload) {
      const fb: OverlayFeedback = {
        kind: 'err',
        text: '这一页没找到可保存的简历文本。点开某位候选人的在线简历后再试。',
      }
      paint(fb)
      return fb
    }
    if (!confirmRisky(forced)) {
      const fb: OverlayFeedback = { kind: 'warn', text: '已取消，没有保存。' }
      paint(fb)
      return fb
    }

    // 选岗信息必须挂到 payload 上 —— 它会跟着 payload 一起进本地队列，
    // 所以「后端没起 → 先排队 → 之后补传」这条路径也不会把选岗丢掉。
    const chosen = positionId || selectedPositionId || undefined
    if (chosen) forced.payload.positionId = chosen

    const ack = await sendCapture(forced.payload, 'manual')
    lastSignature = signatureOf(forced.payload)
    lastResume = resumeInfo(forced.payload, forced.lowConfidence, forced.listWarning?.isList)
    askingSignature = ''
    pendingOutcome = null
    // 方案 C：默认只留用户选的那个岗位，把规则原本的推荐降级成一句提示 + 一键「也挂上」
    ruleSuggested = chosen && ack?.saved ? (ack.ruleSuggested ?? null) : null
    if (chosen) await rememberPosition(chosen)

    // 把不确定性摊开给用户看，而不是偷偷存一条看着正常的脏数据
    const fb = feedbackFromAck(ack, '手动保存失败')
    if (ack?.saved && !ack.duplicated && !ack.queued) {
      const notes: string[] = []
      if (forced.idFromContentHash) notes.push('未识别到平台 ID，已按内容指纹建档，可能与历史记录重复')
      if (forced.belowThreshold) notes.push('正文未达自动识别门槛，可能不完整')
      if (forced.wholePage) notes.push('保存的是整页文本')
      if (notes.length > 0) {
        fb.kind = 'warn'
        fb.text = `已保存，但请注意：${notes.join('；')}。`
      }
    }
    log('✓', `手动保存：${forced.payload.platformCandidateId}（${forced.chars} 字）${chosen ? ` → ${chosen}` : ''}`)
    paint(fb)
    return fb
  }

  /**
   * 「也挂上」：把规则推荐的那个岗位**追加**挂上（用户选的那个仍然保留）。
   *
   * 实现上不新增接口 —— 用同一份 payload 再上报一次、只换 positionId：
   * 后端的 ingestCapture 见到「来源已存在」会走 attach（幂等），于是多出一条匹配。
   */
  async function attachSuggested(positionId: string): Promise<void> {
    const payload = currentOutcome?.payload
    if (!payload || !positionId) return
    const ack = await sendCapture({ ...payload, positionId }, 'manual')
    const title = positions.find((p) => p.id === positionId)?.title ?? positionId
    ruleSuggested = null
    paint(
      ack?.saved
        ? { kind: 'ok', text: `已把「${title}」也挂上。` }
        : { kind: 'err', text: `挂「${title}」失败，请稍后重试。` }
    )
  }

  // ---------------------------------------------------------- 跳过

  async function handleSkip(scope: SkipScope): Promise<OverlayFeedback> {
    const sig =
      askingSignature ||
      (pendingOutcome?.payload
        ? signatureOf(pendingOutcome.payload)
        : currentOutcome?.payload
          ? signatureOf(currentOutcome.payload)
          : '')
    if (sig) dismissed.add(sig)
    if (scope === 'path') pathPausedLocal = true
    askingSignature = ''
    pendingOutcome = null

    try {
      await chrome.runtime.sendMessage({
        type: 'SKIP',
        signature: sig,
        scope,
        pathKey: pathKeyOf(pageLocation()),
      })
    } catch {
      /* background 未就绪也不影响本次跳过（本地已记住） */
    }

    const fb: OverlayFeedback = {
      kind: 'warn',
      text: scope === 'path' ? '这一页不会再自动采集了（可在扩展面板里恢复）。' : '这一份没有保存。',
    }
    paint(fb)
    return fb
  }

  async function resumePath(): Promise<OverlayFeedback> {
    pathPausedLocal = false
    try {
      await chrome.runtime.sendMessage({ type: 'RESUME_PATH', pathKey: pathKeyOf(pageLocation()) })
    } catch {
      /* ignore */
    }
    const fb: OverlayFeedback = { kind: 'ok', text: '已恢复这一页的采集。' }
    paint(fb)
    schedule()
    return fb
  }

  // ---------------------------------------------------------- 扫描调度

  async function maybeCapture(): Promise<void> {
    if (settings.mode === 'off') return
    if (scanning) {
      pending = true
      return
    }
    const since = Date.now() - lastScanAt
    if (since < COOLDOWN_MS) {
      window.clearTimeout(coolTimer)
      coolTimer = window.setTimeout(() => void maybeCapture(), COOLDOWN_MS - since)
      return
    }
    scanning = true
    lastScanAt = Date.now()
    try {
      await scanOnce()
    } catch (e) {
      log('!', `采集出错：${(e as Error)?.message ?? String(e)}`)
    } finally {
      scanning = false
      if (pending) {
        pending = false
        void maybeCapture()
      }
    }
  }

  function schedule(): void {
    if (settings.mode === 'off') return
    window.clearTimeout(debounceTimer)
    debounceTimer = window.setTimeout(() => void maybeCapture(), DEBOUNCE_MS)
  }

  // ---------------------------------------------------------- 诊断接口

  const ria = {
    site: site.platform,
    label: site.label,
    frame: frameLabel,
    /** 只跑一次提取，看有没有拿到 payload */
    extract: () => extractFrom(document, pageLocation(), site),
    /** 放宽门槛的提取（手动保存用的那套） */
    extractForced: () => extractForced(document, pageLocation(), site),
    /** 体检报告：为什么没采到 */
    scan: () => {
      const r = diagnose(document, pageLocation(), site)
      console.log(`[招聘捕手] 诊断 · ${site.label} · ${frameLabel}`)
      console.log(`  → ${r.verdict}`)
      if (isListPage(site, pageLocation())) {
        console.log(`  ⚠ 这一页命中列表页规则（listPagePolicy=${settings.listPagePolicy}）`)
      }
      if (typeof console.table === 'function') console.table(r.topCandidates)
      else console.log(r.topCandidates)
      return r
    },
    /** 当前设置（改设置请用扩展面板，或 __ria.setMode('auto'|'confirm'|'off')） */
    settings: () => settings,
    /** 当前决策状态，排障时一眼看清为什么没采 */
    state: () => ({
      mode: settings.mode,
      listPage: isListPage(site, pageLocation()),
      listPolicy: currentListPolicy(),
      pathPaused: isPathPaused(),
      asking: askingSignature,
      lastSignature,
      dismissed: [...dismissed],
      resume: lastResume,
      hasPending: !!pendingOutcome,
    }),
    /** 简单切模式（等价于在面板里点一下） */
    setMode: async (mode: CaptureSettings['mode']) => {
      // 直接写 storage：content 与 popup 都监听 onChanged，会自动同步
      const next = { ...settings, mode }
      await chrome.storage.local.set({ [SETTINGS_KEY]: next })
      return next
    },
    /** 无视冷却立刻重采一次 */
    capture: () => {
      lastSignature = ''
      lastScanAt = 0
      return maybeCapture()
    },
    /** 手动保存当前页；可传岗位 id */
    save: (positionId?: string) => manualSave(positionId),
    /** 跳过当前这一份 / 整页 */
    skip: (scope: SkipScope = 'once') => handleSkip(scope),
    /** 当前岗位相关状态（排障用） */
    positions: () => ({ list: positions, selected: selectedPositionId, recommended: recommendedTitle }),
  }
  ;(window as unknown as Record<string, unknown>).__ria = ria

  chrome.runtime.onMessage.addListener(
    (
      msg: { type?: string; scope?: SkipScope; positionId?: string },
      _sender,
      sendResponse: (r: unknown) => void
    ) => {
      if (msg?.type === 'PING') {
        sendResponse({
          ok: true,
          data: { site: site.platform, label: site.label, frame: frameLabel, mode: settings.mode },
        })
        return false
      }
      if (msg?.type === 'MANUAL_SAVE') {
        // 页面上/面板上的「保存到看板」都走这里 —— 只有页面知道哪一块是简历。
        // popup 可以把选好的岗位一起传进来。
        void (async () => {
          sendResponse({ ok: true, data: await manualSave(msg.positionId) })
        })()
        return true
      }
      if (msg?.type === 'SKIP_NOW') {
        void (async () => {
          sendResponse({ ok: true, data: await handleSkip(msg.scope === 'path' ? 'path' : 'once') })
        })()
        return true
      }
      if (msg?.type === 'RESUME_PATH_NOW') {
        void (async () => {
          sendResponse({ ok: true, data: await resumePath() })
        })()
        return true
      }
      if (msg?.type === 'DIAGNOSE') {
        const report = diagnose(document, pageLocation(), site)
        const extra = {
          frame: frameLabel,
          mode: settings.mode,
          listPage: isListPage(site, pageLocation()),
          listPolicy: currentListPolicy(),
          pathPaused: isPathPaused(),
          asking: !!askingSignature,
          resume: lastResume,
          // popup 里也要能选岗位，所以把岗位列表一并带过去
          positions,
          selectedPositionId,
          recommendedTitle,
        }
        if (report.containerFound) {
          // 开了 all_frames，同一次 sendMessage 会打到主框架 + 所有 iframe。
          // 真正装着简历的那个框架必须抢先应答，否则如实汇报「没找到」的一方
          // 会把结论带偏。
          sendResponse({ ok: true, data: { ...report, ...extra } })
          return false
        }
        setTimeout(() => {
          sendResponse({ ok: true, data: { ...report, ...extra } })
        }, 250)
        return true // 异步：给「找到了」的框架 250ms 抢先的机会
      }
      return false
    }
  )

  // ---------------------------------------------------------- 启动

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[SETTINGS_KEY]) return
    const raw = (changes[SETTINGS_KEY].newValue as Partial<CaptureSettings> | undefined) ?? {}
    applySettings({
      ...DEFAULT_CAPTURE_SETTINGS,
      ...raw,
      pausedPaths: { ...(raw.pausedPaths ?? {}) },
    })
  })

  void (async () => {
    settings = await loadSettings()
    overlay = new Overlay(
      {
        onSave: (positionId) => void manualSave(positionId),
        onSkip: (scope) => void handleSkip(scope),
        onResumePath: () => void resumePath(),
        onSelectPosition: (positionId) => {
          selectedPositionId = positionId
          // 记住选择（下一次默认就用它）。change 事件是在用户选完之后才触发的，
          // 所以这里重绘不会打断正在展开的下拉。
          void rememberPosition(positionId)
          paint()
        },
        onAttachSuggested: (positionId) => void attachSuggested(positionId),
        onPosChange: (pos) => {
          // 走 background 的合并写，而不是拿本地 settings 整份覆盖 ——
          // 否则会把「用户刚在 popup 里改的模式」冲掉
          void chrome.runtime
            .sendMessage({ type: 'SET_SETTINGS', patch: { cardPos: pos } })
            .catch(() => {
              /* ignore */
            })
        },
      },
      settings.cardPos
    )

    // 岗位列表先拉一次（用户可能一上来就手动保存）
    void loadPositions()

    if (settings.mode === 'off') {
      log('⏸', `已注入但自动采集处于关闭状态（${site.label} · ${frameLabel}）`)
      return
    }

    startObservers()
    // 打开即尝试一次（document_idle 时 load 可能已经过去了，所以主动补一次）
    schedule()
    log(
      '●',
      `已注入：${site.label}（${frameLabel}）· 模式：${
        settings.mode === 'auto' ? '自动保存' : '保存前询问'
      } · 排查用：Console 输入 __ria.scan()`
    )
  })()
}
