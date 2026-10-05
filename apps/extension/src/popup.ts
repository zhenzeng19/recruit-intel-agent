// ============================================================
// popup：扩展图标点开后的面板
// 作用：让用户一眼看到「装好了吗 / 在采吗 / 后端通吗 / 积压多少」，
//       并且能在这里切采集模式、手动保存当前页、回看最近决策。
//
// 关于「当前页面能不能采」：不再靠 URL 猜，而是直接问页面的
// content script 要一份真实诊断（DIAGNOSE）。这样「有没有注入」
// 和「有没有识别到简历」都是实测结果，不是猜的。
//
// 手动保存刻意走页面的 content script（MANUAL_SAVE）而不是在这里自己
// 拼 payload —— 只有页面才知道「哪一块是简历」，而且放宽门槛的提取
// 逻辑（extractForced）也在那边。
// ============================================================
import {
  CAPTURE_MODE_LABEL,
  PLATFORM_LABEL,
  type CaptureLogEntry,
  type CaptureMode,
  type CaptureSettings,
  type Platform,
} from '@ria/shared'

interface StatusData {
  queueCount: number
  apiBase: string
  health: { ok: boolean; dataDir?: string; error?: string }
  settings: CaptureSettings
  log: CaptureLogEntry[]
  skippedCount: number
  state: {
    lastSyncAt: string | null
    lastError: string | null
    totalSynced: number
    totalDuplicated: number
    totalManual: number
    totalSkipped: number
    lastPlatform: Platform | null
    lastCandidateId: string | null
  }
}

interface OverlayResumeInfo {
  name: string
  chars: number
  lowConfidence?: boolean
  listPage?: boolean
}

interface DiagData {
  url: string
  containerFound: boolean
  via?: string
  chars?: number
  score?: number
  topCandidates: Array<{ el: string; chars: number; hits: number; score: number }>
  canvasCount: number
  imageCount: number
  iframeCount: number
  verdict: string
  frame?: string
  mode?: CaptureMode
  listPage?: boolean
  listPolicy?: 'skip' | 'manual' | 'normal'
  pathPaused?: boolean
  asking?: boolean
  resume?: OverlayResumeInfo | null
  /** 可选岗位（content 从 background 拿到后一并回传） */
  positions?: Array<{ id: string; title: string }>
  selectedPositionId?: string
  /** 平台推荐的职位（猎聘头部「推荐职位：X」） */
  recommendedTitle?: string
}

const $ = (id: string) => document.getElementById(id)!

/** 当前选中的岗位（用户在下拉里改过就用他选的） */
let pickedPositionId = ''

const MODE_HINT: Record<CaptureMode, string> = {
  auto: '识别到简历就静默入库，页面上留一个小圆点，可随时手动补采。',
  confirm: '每份简历都会先在页面上问你一下 —— 点了「保存到看板」才入库。',
  off: '完全不采集，页面零打扰。仍然可以用这里的「保存到看板」手动存当前页。',
}

const ACTION_LABEL: Record<CaptureLogEntry['action'], string> = {
  saved: '已保存',
  duplicated: '判重',
  queued: '已排队',
  skipped: '不存',
  rejected: '已拦下',
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function fmtClock(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '--:--'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

function escapeHtml(s: string): string {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )
}

function setBackend(ok: boolean, text: string) {
  const dot = $('backend-dot')
  dot.className = `dot ${ok ? 'ok' : 'bad'}`
  $('backend-text').textContent = text
}

/**
 * 按 hostname 后缀判定站点。
 * 必须覆盖子域：猎聘企业端跑在 lpt.liepin.com，不是 www.liepin.com。
 */
function resolvePlatform(url: string): Platform | null {
  let host = ''
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
  if (host === 'zhipin.com' || host.endsWith('.zhipin.com')) return 'boss'
  if (host === 'liepin.com' || host.endsWith('.liepin.com')) return 'liepin'
  return null
}

async function activeTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab?.id ?? null
}

interface ProbeResult {
  platform: Platform | null
  injected: boolean
  tabId: number | null
  diag?: DiagData
  error?: string
}

async function probeCurrentTab(): Promise<ProbeResult> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const url = tab?.url || ''
  const tabId = tab?.id ?? null
  const platform = resolvePlatform(url)
  if (!platform) return { platform: null, injected: false, tabId }
  if (tabId == null) return { platform, injected: false, tabId, error: '拿不到标签页 ID' }

  try {
    const resp = (await chrome.tabs.sendMessage(tabId, { type: 'DIAGNOSE' })) as {
      ok: boolean
      data: DiagData
    }
    if (resp?.ok && resp.data) return { platform, injected: true, tabId, diag: resp.data }
    return { platform, injected: false, tabId, error: '页面脚本未返回有效结果' }
  } catch {
    // 最常见的原因：扩展刚重载，而页面是重载之前打开的 —— content script 不在
    return { platform, injected: false, tabId, error: '扩展的内容脚本不在这个页面上' }
  }
}

function renderDiag(d: DiagData) {
  const box = $('diag-box')
  box.style.display = 'block'
  box.className = `diag ${d.containerFound ? 'good' : 'bad'}`

  const meta: string[] = []
  if (d.frame) meta.push(`框架 ${d.frame}`)
  if (d.containerFound) {
    meta.push(d.via === 'selector' ? '站点选择器' : '智能识别')
    meta.push(`${d.chars ?? 0} 字`)
  }
  if (d.listPage) meta.push(`列表页策略 ${d.listPolicy ?? 'manual'}`)
  meta.push(`canvas ${d.canvasCount}`, `img ${d.imageCount}`, `iframe ${d.iframeCount}`)

  const html: string[] = [
    `<span class="v">${d.containerFound ? '✓ ' : '✕ '}${escapeHtml(d.verdict)}</span>`,
    `<span class="meta">${escapeHtml(meta.join(' · '))}</span>`,
  ]

  if (!d.containerFound && d.topCandidates.length > 0) {
    html.push(
      '<ul>' +
        d.topCandidates
          .slice(0, 5)
          .map(
            (c) =>
              `<li><b>${escapeHtml(c.el)}</b> — ${c.chars} 字 / ${c.hits} 命中 / ${c.score} 分</li>`
          )
          .join('') +
        '</ul>'
    )
  }
  box.innerHTML = html.join('')
}

/** 当前标签页处于什么状态 */
async function renderCurrentTab() {
  const box = $('tab-box')
  const diagBox = $('diag-box')
  const resumeBox = $('resume-box')
  const pauseBox = $('pause-box')
  const pickBox = $('pick-box')
  const posHint = $('pos-hint')
  diagBox.style.display = 'none'
  resumeBox.style.display = 'none'
  pauseBox.classList.remove('show')
  pickBox.classList.remove('show')
  posHint.style.display = 'none'

  const r = await probeCurrentTab()

  if (!r.platform) {
    box.className = 'tab-box idle'
    $('tab-text').textContent = '当前页面不是 BOSS直聘 / 猎聘，去那边打开简历才会采集'
    return
  }

  if (!r.injected) {
    box.className = 'tab-box warn'
    $('tab-text').textContent = `在 ${PLATFORM_LABEL[r.platform]} 上，但扩展没注入到本页 —— 按 F5 刷新页面即可`
    return
  }

  const d = r.diag
  const resume = d?.resume
  const good = !!d?.containerFound

  if (d?.pathPaused) {
    box.className = 'tab-box warn'
    $('tab-text').textContent = `${PLATFORM_LABEL[r.platform]} · 本页已被设为「都不再问」`
    pauseBox.classList.add('show')
  } else if (d?.listPage && d.listPolicy === 'manual') {
    box.className = 'tab-box warn'
    $('tab-text').textContent = `${PLATFORM_LABEL[r.platform]} · 这是列表页（一屏多人），已跳过自动采集 —— 点开某位候选人的简历后可手动保存`
  } else if (good) {
    box.className = 'tab-box active'
    const mode = d?.mode ?? 'confirm'
    $('tab-text').textContent =
      mode === 'off'
        ? `${PLATFORM_LABEL[r.platform]} · 已识别到简历（但自动采集已关闭，可手动保存）`
        : mode === 'auto'
          ? `${PLATFORM_LABEL[r.platform]} · 已识别到简历，正在自动采集`
          : `${PLATFORM_LABEL[r.platform]} · 已识别到简历，等你决定要不要存`
  } else {
    box.className = 'tab-box warn'
    $('tab-text').textContent = `${PLATFORM_LABEL[r.platform]} · 扩展已注入，但当前没识别到简历 —— 点开某位候选人的在线简历`
  }

  if (resume) {
    resumeBox.style.display = 'block'
    $('resume-text').innerHTML = `识别到 <b>${escapeHtml(resume.name)}</b> · ${resume.chars} 字`
    const notes: string[] = []
    if (resume.listPage) notes.push('疑似列表页，建议点开单份简历再存')
    if (resume.lowConfidence) notes.push('正文可能不完整')
    if (d?.asking) notes.push('正在等你决定')
    $('resume-meta').textContent = notes.join(' · ')
  }

  // ---- 岗位选择器（识别到简历才显示）
  const positions = d?.positions ?? []
  if (resume && positions.length > 0) {
    pickBox.classList.add('show')
    const sel = $('pos-select') as HTMLSelectElement
    sel.replaceChildren()
    const none = document.createElement('option')
    none.value = ''
    none.textContent = '不指定（按规则自动挂）'
    sel.appendChild(none)
    for (const p of positions) {
      const o = document.createElement('option')
      o.value = p.id
      o.textContent = p.title
      sel.appendChild(o)
    }
    // 默认值：用户这次已经选过就用他选的；否则用页面给的（平台推荐 → 上次选过的）
    const known = positions.some((p) => p.id === pickedPositionId)
    sel.value = known ? pickedPositionId : (d?.selectedPositionId ?? '')
    pickedPositionId = sel.value
  }

  // 平台推荐的职位（猎聘自己写的），拿来提示 —— 用户想听平台的建议时可以据此选
  const rec = d?.recommendedTitle
  if (rec && resume) {
    const known = positions.some((p) => p.title === rec)
    posHint.style.display = 'block'
    posHint.textContent = known
      ? `猎聘推荐：${rec}`
      : `猎聘推荐：${rec}（你的岗位里没有，先去「岗位管理」加一个）`
  }

  if (d) renderDiag(d)
}

function renderMode(settings: CaptureSettings) {
  // 刻意写成字面量而不是 `$(`mode-${m}`)`：verify.mjs 会从产物里抽
  // $("id") 并与 popup.html 的 id 做存在性比对，拼出来的 id 抽不到 ——
  // 于是少一个 id 也不会被发现，运行时却直接 null 崩溃。
  $('mode-auto').className = settings.mode === 'auto' ? 'active' : ''
  $('mode-confirm').className = settings.mode === 'confirm' ? 'active' : ''
  $('mode-off').className = settings.mode === 'off' ? 'active' : ''
  $('mode-hint').textContent = MODE_HINT[settings.mode]
}

function renderLog(list: CaptureLogEntry[]) {
  const ul = $('log-list')
  if (!list || list.length === 0) {
    ul.innerHTML = '<li><span class="nm">还没有记录</span></li>'
    return
  }
  ul.innerHTML = list
    .slice(0, 12)
    .map((e) => {
      const label = ACTION_LABEL[e.action] ?? e.action
      const methodTag = e.action === 'skipped' || e.action === 'rejected' ? '' : e.method === 'manual' ? '手动 ' : ''
      const name = e.action === 'skipped' ? e.name : `${e.name} · ${e.chars}字`
      return (
        `<li><span class="tm">${fmtClock(e.at)}</span>` +
        `<span class="nm">${escapeHtml(name)}</span>` +
        `<span class="ac ${e.action}">${methodTag}${label}</span></li>`
      )
    })
    .join('')
}

function render(d: StatusData) {
  // 后端
  if (d.health.ok) setBackend(true, `后端已连接 · ${d.apiBase}`)
  else setBackend(false, `${d.health.error || '连接失败'} · ${d.apiBase}`)

  // 采集模式
  renderMode(d.settings)

  // 队列
  const q = d.queueCount
  const badge = $('queue-num')
  badge.textContent = String(q)
  badge.className = `num ${q > 0 ? 'warn' : 'ok'}`
  $('queue-hint').textContent =
    q === 0
      ? '本地无积压，采集到的简历都已入库'
      : `${q} 份简历在本地排队，等后端恢复后会自动上传`

  // 累计
  $('stat-synced').textContent = String(d.state.totalSynced)
  $('stat-manual').textContent = String(d.state.totalManual)
  $('stat-dup').textContent = String(d.state.totalDuplicated)
  $('stat-skip').textContent = String(d.state.totalSkipped)

  renderLog(d.log)

  // 最近采集
  const last = $('last-capture')
  if (d.state.lastPlatform && d.state.lastCandidateId) {
    last.textContent = `${PLATFORM_LABEL[d.state.lastPlatform]} · ${fmtTime(d.state.lastSyncAt)}`
  } else {
    last.textContent = '还没有采集记录'
  }

  // 错误提示
  const err = $('err-box')
  if (d.state.lastError) {
    err.style.display = 'block'
    err.textContent = d.state.lastError
  } else {
    err.style.display = 'none'
  }
}

async function refresh() {
  try {
    const resp = (await chrome.runtime.sendMessage({ type: 'GET_STATUS' })) as {
      ok: boolean
      data: StatusData
    }
    if (resp?.ok) render(resp.data)
  } catch {
    setBackend(false, '扩展后台未响应，尝试重新加载扩展')
  }
}

// ------------------------------------------------------------ 交互

async function switchMode(m: CaptureMode) {
  await chrome.runtime.sendMessage({ type: 'SET_SETTINGS', patch: { mode: m } })
  await refresh()
  // 模式变了，页面上的卡片形态会跟着变（content 监听 storage.onChanged），
  // 所以顺手把「当前标签页」也重测一次，让面板立刻反映新状态
  await renderCurrentTab()
  flash(`已切换为「${CAPTURE_MODE_LABEL[m]}」`)
}

// 同样刻意用字面量 id（见 renderMode 的说明）
$('mode-auto').addEventListener('click', () => void switchMode('auto'))
$('mode-confirm').addEventListener('click', () => void switchMode('confirm'))
$('mode-off').addEventListener('click', () => void switchMode('off'))

$('btn-save').addEventListener('click', async () => {
  const btn = $('btn-save') as HTMLButtonElement
  const tabId = await activeTabId()
  if (tabId == null) return flash('拿不到当前标签页')
  btn.disabled = true
  try {
    // 选好的岗位一起传过去：只有页面才知道「哪一块是简历」，
    // 而岗位是用户在这里选的，所以两边各出一半。
    const resp = (await chrome.tabs.sendMessage(tabId, {
      type: 'MANUAL_SAVE',
      positionId: pickedPositionId || undefined,
    })) as { ok: boolean; data?: { kind: string; text: string } } | undefined
    flash(resp?.data?.text ?? '已尝试保存')
  } catch {
    flash('这个页面没有可保存的内容（扩展没注入或没点开简历）')
  } finally {
    btn.disabled = false
    void refresh()
    void renderCurrentTab()
  }
})

$('pos-select').addEventListener('change', () => {
  pickedPositionId = ($('pos-select') as HTMLSelectElement).value
})

$('btn-skip').addEventListener('click', async () => {
  const tabId = await activeTabId()
  if (tabId == null) return flash('拿不到当前标签页')
  try {
    const resp = (await chrome.tabs.sendMessage(tabId, { type: 'SKIP_NOW', scope: 'once' })) as
      | { ok: boolean; data?: { kind: string; text: string } }
      | undefined
    flash(resp?.data?.text ?? '已跳过这一份')
  } catch {
    flash('跳过失败：扩展没注入到这个页面')
  }
  void refresh()
  void renderCurrentTab()
})

$('btn-resume').addEventListener('click', async () => {
  const tabId = await activeTabId()
  if (tabId == null) return flash('拿不到当前标签页')
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'RESUME_PATH_NOW' })
    flash('已恢复本页采集')
  } catch {
    flash('恢复失败：扩展没注入到这个页面')
  }
  void refresh()
  void renderCurrentTab()
})

$('btn-sync').addEventListener('click', async () => {
  const btn = $('btn-sync') as HTMLButtonElement
  btn.disabled = true
  btn.textContent = '同步中…'
  try {
    await chrome.runtime.sendMessage({ type: 'FLUSH_NOW' })
    await refresh()
    flash('已尝试同步')
  } catch {
    flash('同步失败，见图示状态')
  } finally {
    btn.disabled = false
    btn.textContent = '立即同步'
  }
})

$('btn-diag').addEventListener('click', async () => {
  const btn = $('btn-diag') as HTMLButtonElement
  btn.disabled = true
  btn.textContent = '检测中…'
  try {
    await renderCurrentTab()
    flash('已完成页面诊断')
  } finally {
    btn.disabled = false
    btn.textContent = '诊断当前页'
  }
})

$('btn-open').addEventListener('click', async () => {
  const resp = (await chrome.runtime.sendMessage({ type: 'GET_STATUS' })) as { data: StatusData }
  const base = resp?.data?.apiBase || 'http://localhost:8787'
  chrome.tabs.create({ url: base })
})

$('btn-clear').addEventListener('click', async () => {
  const btn = $('btn-clear') as HTMLButtonElement
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1'
    btn.textContent = '再点一次确认清空'
    setTimeout(() => {
      delete btn.dataset.armed
      btn.textContent = '清空本地队列'
    }, 3000)
    return
  }
  delete btn.dataset.armed
  btn.textContent = '清空本地队列'
  await chrome.runtime.sendMessage({ type: 'CLEAR_QUEUE' })
  await refresh()
  flash('本地队列已清空')
})

function flash(text: string) {
  const el = $('toast')
  el.textContent = text
  el.classList.add('show')
  setTimeout(() => el.classList.remove('show'), 2200)
}

// ------------------------------------------------------------ 启动
void renderCurrentTab()
void refresh()
// popup 打开期间每 2 秒刷新一次队列状态
const timer = setInterval(() => void refresh(), 2000)
window.addEventListener('unload', () => clearInterval(timer))
