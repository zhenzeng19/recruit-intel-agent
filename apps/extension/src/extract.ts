// ============================================================
// 简历提取核心逻辑（纯函数式，不引用全局 document / location）
// 独立成文件的原因：这部分最容易出错，需要能在 Node 里单测
//
// 设计取舍：
//   不硬编码某一条 CSS 选择器去赌站点结构 —— 招聘站点改版频繁，
//   而且同一站点不同入口（列表页 / IM 页 / 详情页）结构完全不同。
//   改为「站点提示选择器 + 启发式定位」两级：
//     ① 站点已知选择器命中 → 直接采信（人工维护，最准）
//     ② 否则在页面里找「最小充分容器」——同时满足
//           · 正文长度够
//           · 命中足够多的简历章节词（工作经历 / 教育经历 …）
//           · 不夹带招聘端外壳词（消息 / 通讯录 / 职位管理 …）
//        并在得分相近时取**文本最短**的，从而逼近最内层的那块。
// ============================================================
import type { CaptureMode, CapturePayload, Platform } from '@ria/shared'
import {
  RESUME_SECTION_WORDS,
  UI_CHROME_WORDS,
  extractResumeNo,
  guessResumeName,
  isVolatileLine,
  looksLikeChromeOrJunk,
  stripResumeChrome,
} from '@ria/shared'

// 姓名识别与「面板按钮词」放在 @ria/shared，与服务端的字段粗提取共用一份实现，
// 避免两端各写一遍、然后一起把姓名抓成「查看大图」。这里做一次转发，
// 让本模块的老调用方（含测试）仍能从 extract.ts 直接拿到。
export { UI_CHROME_WORDS, looksLikeChromeOrJunk, stripResumeChrome, isVolatileLine }
export const RESUME_SECTIONS = RESUME_SECTION_WORDS
export const guessName = guessResumeName

// ------------------------------------------------------------ 站点档案

export interface SiteProfile {
  platform: Platform
  label: string
  /** 域名后缀。命中 hostname 本身或其任意子域即认站 */
  hosts: string[]
  /** URL / hash 里可能是候选人 ID 的参数名，按优先级从前到后 */
  idParams: string[]
  /** DOM 上可能挂着候选人 ID 的属性名 */
  idAttrs: string[]
  /** 站点已知的简历容器选择器（命中即优先采信） */
  containerSelectors: string[]
  /**
   * 「一屏多人」的列表 / 聚合页路径。
   *
   * 为什么需要它：列表页上几十张候选人卡片的文本聚合起来，很容易同时满足
   * 「正文 > 240 字」和「命中 ≥2 个章节词」，被启发式误判成**一份**简历 ——
   * 结果存进去一条包含多个人的脏数据（猎聘人才推荐 /recommend 就是这种页）。
   * 命中这里就按 settings.listPagePolicy 处理，默认不自动采集。
   */
  listPaths?: RegExp[]
}

export const SITE_BOSS: SiteProfile = {
  platform: 'boss',
  label: 'BOSS直聘',
  hosts: ['zhipin.com'],
  idParams: ['geekId', 'geek_id', 'encryptGeekId', 'encryptGeekIdStr', 'candidateId', 'resumeId', 'id'],
  idAttrs: [
    'data-geekid',
    'data-geek',
    'data-encryptgeekid',
    'data-candidateid',
    'data-resumeid',
    'data-id',
  ],
  // BOSS 招聘端的推荐 / 搜索列表页同样是一屏多人
  listPaths: [/\/recommend/, /\/web\/geek\/search/, /\/web\/boss\/search/, /\/search\/list/],
  containerSelectors: [
    '.resume-detail',
    '.geek-detail',
    '.resume-content',
    '.resume-box',
    '.geek-card',
    '.chat-conversation .resume',
    '#resume',
  ],
}

export const SITE_LIEPIN: SiteProfile = {
  platform: 'liepin',
  label: '猎聘',
  hosts: ['liepin.com'],
  idParams: [
    // ★ 猎聘简历详情页 URL 里的真 ID（/resume/detail?...&resIdEncode=CD34EF56AB7800cc33dd44）
    //   必须排在最前面 —— pickCandidateId 取的是「第一个命中的」。
    //   没有它，从详情页采的简历也只能退化成内容指纹。
    'resIdEncode',
    'usercIdEncode',
    'resumeId',
    'resumeid',
    'resume_id',
    'candidateId',
    'candidateid',
    'candidate_id',
    'rid',
    // ejobId 是「职位」不是「人」，所以排在候选人 ID 之后
    'ejobId',
    'eid',
    'id',
  ],
  idAttrs: [
    'data-resumeid',
    'data-resume-id',
    'data-candidateid',
    'data-candidate-id',
    'data-eid',
    'data-id',
  ],
  // 猎聘 HR 端的人才推荐 / 搜索 / 人才库列表页
  listPaths: [/\/recommend/, /\/search/, /\/talent/, /\/candidate\/list/, /\/resume\/list/],
  containerSelectors: [
    '.resume-detail',
    '.resume-content',
    '.resume-box',
    '.resume-preview',
    '.im-resume',
    '.detail-content',
    '[class*="resume-detail"]',
    '[class*="resumeDetail"]',
    '[class*="ResumeDetail"]',
    '[class*="resume-content"]',
    '[class*="resumeContent"]',
    '[class*="preview-content"]',
    '[class*="previewContent"]',
  ],
}

export const SITES: SiteProfile[] = [SITE_BOSS, SITE_LIEPIN]

/**
 * 按 hostname 解析站点。
 * 必须覆盖子域：猎聘企业端在 lpt.liepin.com（不是 www.liepin.com），
 * 早先的 manifest 只写了 www.liepin.com，导致 HR 端页面根本没被注入。
 */
export function resolveSite(hostname: string): SiteProfile | null {
  const h = (hostname || '').toLowerCase()
  if (!h) return null
  for (const site of SITES) {
    for (const suffix of site.hosts) {
      if (h === suffix || h.endsWith(`.${suffix}`)) return site
    }
  }
  return null
}

// ------------------------------------------------------------ 文本判据

/** 招聘端「页面外壳」上的词 —— 用来惩罚把导航/会话列表一起圈进来的大容器 */
export const NOISE_WORDS = [
  '通讯录',
  '职位管理',
  '候选人管理',
  '人才库',
  '我的猎聘',
  '退出登录',
  '切换身份',
  '账户设置',
  '招聘管理',
  '企业版',
  '购买',
  '续费',
  '消息列表',
  '全部消息',
] as const

export const MIN_RESUME_CHARS = 240
export const MAX_CONTAINER_CHARS = 60000
export const MIN_SECTION_HITS = 2
/** 通过阈值：hits=2 且无噪声 → 20；hits=2 且 1 个噪声词 → 12（拦掉） */
export const PASS_SCORE = 18

export function countHits(text: string, words: readonly string[]): number {
  let n = 0
  for (const w of words) if (text.includes(w)) n++
  return n
}

/**
 * 给一段文本打「像不像简历」的分。
 * 章节词加分；页面外壳词重扣；面板内的按钮文案轻扣（有上限，
 * 因为按钮数量有限且必然存在，不能因为它把整块容器一票否决）。
 * 只看 textContent（快，且能带上折叠内容）。
 */
export function scoreResumeText(text: string): number {
  if (!text) return 0
  if (text.length < MIN_RESUME_CHARS) return 0
  const hits = countHits(text, RESUME_SECTIONS)
  if (hits < MIN_SECTION_HITS) return 0
  const noise = countHits(text, NOISE_WORDS)
  const chrome = countHits(text, UI_CHROME_WORDS)
  const score = hits * 10 - noise * 8 - Math.min(chrome, 6) * 2
  return score < 0 ? 0 : score
}

/** 归一化文本：去掉硬回车、压缩行内空白、丢弃空行 */
export function cleanText(s: string): string {
  return (s || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0\u3000]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

/**
 * 取元素的可读正文。
 * 优先 innerText（反映渲染可见内容），但它对隐藏节点返回空；
 * 若 innerText 明显偏短则退回 textContent（拿折叠起来的部分）。
 */
export function textOf(el: Element): string {
  const he = el as HTMLElement
  let t = ''
  try {
    t = he.innerText || ''
  } catch {
    t = ''
  }
  if (t.trim().length < 60) {
    const tc = he.textContent || ''
    if (tc.length > t.length) t = tc
  }
  return cleanText(t)
}

// ------------------------------------------------------------ 容器定位

export interface ContainerHit {
  el: Element
  via: 'selector' | 'heuristic'
  score: number
  chars: number
}

export function describeEl(el: Element): string {
  const cls = (el.getAttribute?.('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.')
  const id = el.getAttribute?.('id') || ''
  return `${el.tagName.toLowerCase()}${id ? `#${id}` : ''}${cls ? `.${cls}` : ''}`
}

/**
 * 找出页面里承载简历的那块容器。
 *
 * 关键点：外层容器会把导航、会话列表一起圈进来 —— 它的章节命中数未必更少，
 * 但文本一定更长、噪声词一定更多。所以排序用「得分降序 + 长度升序」，
 * 天然选到最内层那块（最小充分容器）。
 * 再加一道 order 兜底：纯 wrapper 容器的 textContent 和内层一模一样，
 * 长度分不出高下，而先序遍历里祖先一定在子孙之前 —— 取靠后的即更内层的那块。
 */
export function findResumeContainer(doc: Document, site: SiteProfile): ContainerHit | null {
  // ① 站点已知选择器
  for (const sel of site.containerSelectors) {
    let nodes: Element[]
    try {
      nodes = Array.from(doc.querySelectorAll(sel))
    } catch {
      continue // 选择器写错不该拖垮整条链路
    }
    for (const n of nodes) {
      const raw = (n as HTMLElement).textContent || ''
      if (raw.length < MIN_RESUME_CHARS) continue
      const score = scoreResumeText(raw)
      if (score >= PASS_SCORE) {
        return { el: n, via: 'selector', score, chars: raw.length }
      }
    }
  }

  // ② 启发式
  const cands: Array<{ el: Element; score: number; len: number; order: number }> = []
  let order = 0
  for (const el of Array.from(doc.querySelectorAll('div,section,article,main'))) {
    order++
    const raw = (el as HTMLElement).textContent || ''
    const len = raw.length
    if (len < MIN_RESUME_CHARS || len > MAX_CONTAINER_CHARS) continue
    if (countHits(raw, RESUME_SECTIONS) < MIN_SECTION_HITS) continue
    const score = scoreResumeText(raw)
    if (score < PASS_SCORE) continue
    cands.push({ el, score, len, order })
  }
  if (cands.length === 0) return null

  cands.sort((a, b) => b.score - a.score || a.len - b.len || b.order - a.order)
  const top = cands[0]
  return { el: top.el, via: 'heuristic', score: top.score, chars: top.len }
}

// ------------------------------------------------------------ 列表页护栏
//
// 背景：猎聘 HR 端的人才推荐页 /recommend 是「一屏多人」——
// 几十张候选人卡片聚合起来的文本，很容易同时满足「> 240 字」和「命中 ≥2 个
// 章节词」，被启发式当成**一份**简历。存进去就是一条包含多个人的脏数据。
// 两层护栏：① 路径清单（快、确定）② 聚合容器检测（兜底，站点换 URL 也挡得住）

/** 单个「多人特征」出现多少次算超标 */
export const LIST_FEATURE_MIN = 3
/** 至少几种特征同时超标，才判定为聚合容器 */
export const LIST_FAMILIES_MIN = 2

export interface ListContainerVerdict {
  isList: boolean
  families: Array<{ name: string; count: number; over: boolean }>
}

function countMatches(text: string, re: RegExp): number {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`
  const m = text.match(new RegExp(re.source, flags))
  return m ? m.length : 0
}

/**
 * 一个容器里出现多个「候选人头部特征」→ 它是列表，不是一份简历。
 *
 * 单份简历里这些词各自只出现一两次（年龄 1 次、工作年限 1 次、按钮一两个），
 * 只有聚合了多人的容器才会让**多种**特征同时超过 3 次。
 * 所以要求「至少 2 种特征超标」而不是「总数超标」，避免误杀一份啰嗦的简历。
 */
export function looksLikeListContainer(text: string): ListContainerVerdict {
  const t = text || ''
  const families = [
    { name: '年龄行', count: countMatches(t, /\d{1,2}\s*岁/) },
    { name: '面板按钮', count: countMatches(t, /查看大图|意向沟通|继续沟通|立即沟通/) },
    { name: '手机号', count: countMatches(t, /1[3-9][\d*＊]{9}/) },
    { name: '工作年限', count: countMatches(t, /工作\s*\d{1,2}\s*年/) },
  ].map((f) => ({ ...f, over: f.count >= LIST_FEATURE_MIN }))

  return { isList: families.filter((f) => f.over).length >= LIST_FAMILIES_MIN, families }
}

/** 当前 URL 是不是站点的列表 / 聚合页 */
export function isListPage(site: SiteProfile, loc: PageLocation): boolean {
  const patterns = site.listPaths
  if (!patterns || patterns.length === 0) return false
  const target = `${loc.pathname || ''}${loc.hash || ''}`
  return patterns.some((re) => {
    try {
      return re.test(target)
    } catch {
      return false
    }
  })
}

/** 站点路径键（用于「本页都不再问」的记忆粒度：只到路径，不含 query） */
export function pathKeyOf(loc: PageLocation): string {
  return `${loc.hostname || ''}${loc.pathname || ''}`
}

// ------------------------------------------------------------ 手动强制保存
//
// 自动采集有两道门槛（MIN_RESUME_CHARS=240、PASS_SCORE=18），它们的存在是为了
// 防脏数据，代价是「页面确实是简历、只是写法不标准」时会漏采，而且用户无从补救。
// 手动保存就把门槛放开 —— 但必须把「这次拿到的正文可能不完整」如实告诉用户，
// 而不是偷偷存一条看着正常的脏数据。

export interface ForcedOutcome extends ExtractOutcome {
  /** 退化成整页文本了（最坏情况，需要用户二次确认） */
  wholePage?: boolean
  /** 聚合容器警告（疑似列表页的一整块） */
  listWarning?: ListContainerVerdict
  /** ID 来自内容指纹 —— 不是平台 ID，可能与历史记录重复建档 */
  idFromContentHash?: boolean
  /** 正文没达到自动采集的门槛（低置信） */
  belowThreshold?: boolean
  lowConfidence?: boolean
  /** 从 DOM 里找到的详情页链接 */
  detailUrl?: string | null
}

/**
 * 手动保存用的放宽提取：拿「最像简历的那一块」，不看 PASS_SCORE。
 * 站点选择器依然最优先（那是最强的证据），其次是章节词命中数与得分。
 */
export function extractForced(doc: Document, loc: PageLocation, site: SiteProfile): ForcedOutcome {
  type Cand = { el: Element; fromSelector: boolean; hits: number; score: number; len: number; order: number }
  const pool: Cand[] = []
  let order = 0

  for (const sel of site.containerSelectors) {
    let nodes: Element[]
    try {
      nodes = Array.from(doc.querySelectorAll(sel))
    } catch {
      continue
    }
    for (const n of nodes) {
      const raw = (n as HTMLElement).textContent || ''
      if (raw.length < MIN_RESUME_CHARS || raw.length > MAX_CONTAINER_CHARS) continue
      pool.push({
        el: n,
        fromSelector: true,
        hits: countHits(raw, RESUME_SECTIONS),
        score: scoreResumeText(raw),
        len: raw.length,
        order: ++order,
      })
    }
  }

  for (const el of Array.from(doc.querySelectorAll('div,section,article,main'))) {
    const raw = (el as HTMLElement).textContent || ''
    if (raw.length < MIN_RESUME_CHARS || raw.length > MAX_CONTAINER_CHARS) continue
    pool.push({
      el,
      fromSelector: false,
      hits: countHits(raw, RESUME_SECTIONS),
      score: scoreResumeText(raw),
      len: raw.length,
      order: ++order,
    })
  }

  pool.sort(
    (a, b) =>
      Number(b.fromSelector) - Number(a.fromSelector) ||
      b.hits - a.hits ||
      b.score - a.score ||
      a.len - b.len ||
      b.order - a.order
  )

  let text = ''
  let hits = 0
  let score = 0
  let root: Element | null = null
  let wholePage = false

  if (pool.length > 0) {
    root = pool[0].el
    hits = pool[0].hits
    score = pool[0].score
    text = textOf(pool[0].el)
    // 站点选择器命中的是 textContent，这里换成可读正文后可能明显变短
    if (text.length < MIN_RESUME_CHARS) {
      const tc = cleanText((pool[0].el as HTMLElement).textContent || '')
      if (tc.length > text.length) text = tc
    }
  } else {
    // 一个候选都没有（整页都是短块）→ 退化成整页文本，交给用户确认
    wholePage = true
    root = doc.documentElement
    text = textOf(doc.documentElement).slice(0, MAX_CONTAINER_CHARS)
  }

  if (!text || text.length < 60) return { ok: false, reason: 'text-too-short' }
  if (!root) return { ok: false, reason: 'no-container' }

  // 手动保存走同一套清洗与来源解析，保证「自动」和「手动」两条路产出的档案一致
  text = stripResumeChrome(text)

  const belowThreshold = hits < MIN_SECTION_HITS || score < PASS_SCORE
  const lowConfidence = wholePage || belowThreshold
  const detailUrl = findResumeDetailLink(doc, root)
  const id = pickCandidateId(doc, loc, site, root, text, detailUrl)
  const listWarning = looksLikeListContainer(text)

  return {
    ok: true,
    via: wholePage ? 'heuristic' : pool[0]?.fromSelector ? 'selector' : 'heuristic',
    chars: text.length,
    score,
    wholePage,
    listWarning,
    idFromContentHash: id.startsWith('content:'),
    belowThreshold,
    lowConfidence,
    detailUrl,
    payload: {
      platform: site.platform,
      platformCandidateId: id,
      resumeUrl: detailUrl || loc.href,
      capturedUrl: loc.href,
      rawText: text,
      capturedAt: new Date().toISOString(),
      source: 'manual',
      lowConfidence,
    },
  }
}

// ------------------------------------------------------------ 采集决策（纯函数，便于单测）

export type CaptureDecision =
  | { action: 'ignore'; reason: 'off' | 'no-resume' | 'duplicate' | 'dismissed' | 'path-paused' | 'list-skip' }
  | { action: 'capture'; source: 'auto' }
  | { action: 'ask'; listPage?: boolean }

export interface CaptureDecisionInput {
  mode: CaptureMode
  /** 本帧是否提取到了简历 */
  outcomeOk: boolean
  signature: string
  /** 上一次已经采过的签名 */
  lastSignature: string
  /** 正在询问中的签名（避免同一份反复弹卡） */
  askingSignature: string
  /** 用户已选择「这次不存」的签名 */
  dismissed: string[]
  /** 用户已选择「本页都不再问」 */
  pathPaused: boolean
  /** 列表页策略（非列表页传 'normal'） */
  listPolicy: 'skip' | 'manual' | 'normal'
}

/**
 * 把「当前状态 → 该干什么」抽成一个纯函数，是为了能在 Node 里跑真值表：
 * auto/confirm/off × 有简历/没简历 × 已跳过/未跳过 × 列表页/普通页。
 * 这段逻辑散在 content script 里就没法单测了，而它恰恰是最容易出错的判定。
 */
export function decideCapture(i: CaptureDecisionInput): CaptureDecision {
  if (i.mode === 'off') return { action: 'ignore', reason: 'off' }
  if (!i.outcomeOk) return { action: 'ignore', reason: 'no-resume' }
  if (i.pathPaused) return { action: 'ignore', reason: 'path-paused' }

  // 列表页：skip=完全不出卡；manual=不自动采，但允许用户手动存点开的那一份
  if (i.listPolicy === 'skip') return { action: 'ignore', reason: 'list-skip' }
  const onListPage = i.listPolicy === 'manual'

  if (i.signature && i.signature === i.askingSignature) return { action: 'ignore', reason: 'duplicate' }
  if (i.signature && i.dismissed.includes(i.signature)) return { action: 'ignore', reason: 'dismissed' }
  if (i.signature && i.signature === i.lastSignature) return { action: 'ignore', reason: 'duplicate' }

  if (onListPage) return { action: 'ask', listPage: true }
  return i.mode === 'auto' ? { action: 'capture', source: 'auto' } : { action: 'ask' }
}

// ------------------------------------------------------------ 候选人 ID

export function hashStr(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}



/** 手机号（含脱敏形态）。脱敏位数不同也归一成同一写法，避免同一人算出两个键 */
const PHONE_RE = /1[3-9][\d*＊]{9}/
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/

/**
 * 手机号的规范写法：统一成「前 3 位 + 后 4 位」。
 *
 * 同一份简历在不同入口下，手机号可能以完整形态（13800000000）出现，
 * 也可能被平台脱敏成 138****0000 —— 前者常见于聊天记录，后者常见于简历头部。
 * 两种写法其实指同一个人，不归一的话内容指纹会算出两个不同的值。
 */
export function canonicalPhone(p: string): string {
  // 只取数字位：脱敏写法（138****0000）剩下的数字位不足 11 位，
  // 但「前 3 位 + 后 4 位」一定还在，用它就能和完整写法对齐
  const digits = p.replace(/[^\d]/g, '')
  if (digits.length >= 7) return `${digits.slice(0, 3)}****${digits.slice(-4)}`
  return p.replace(/[＊*]+/g, '**')
}

/**
 * 稳定身份键：手机号 → 邮箱。
 *
 * ⚠️ 定位说明：这是**辅助信号**，不是去重主键。
 *   它看起来比内容指纹更"硬"，但在真实页面上并不可靠 ——
 *   容器边界松一点就会多圈进聊天气泡里的一行手机号，紧一点又只剩邮箱，
 *   于是同一个人两次抓取会得到 `phone:…` 和 `email:…` 两个不同的键。
 *   （这个坑是写测试时抓出来的：断言「两次抓取同一个 ID」直接失败。）
 *   所以真正的去重主键用归一化后的**内容指纹**（见 fingerprintText），
 *   这里的身份键留给：诊断展示、以及将来跨页面（IM 面板 ↔ 简历详情页）
 *   的二次校验用。
 */
export function stableIdentity(text: string): string | null {
  const phone = PHONE_RE.exec(text)
  if (phone) return `phone:${canonicalPhone(phone[0])}`
  const email = EMAIL_RE.exec(text)
  if (email) return `email:${email[0].toLowerCase()}`
  return null
}

/**
 * 用于内容指纹的归一化文本：把「同一份简历的两次抓取」之间的噪声全部抹平 ——
 *   · 去掉纯数字 / 纯符号行（聊天记录里的「13800000000」这种独立行）
 *   · 去掉**易变行**（`7天内活跃` / `更新简历时间：…` / `剩10次权益` / `本月剩余30次`）
 *     —— 这些会随时间和账号权益余额变化，留着就等于「同一份简历每天一个新指纹」
 *   · 去掉面板按钮文案（有时多一个「继续沟通」）
 *   · 手机号的完整形态与脱敏形态统一成同一写法
 *   · 去掉所有空白
 * 这样算出来的指纹只反映「简历正文本身」，不随容器边界抖动。
 */
export function fingerprintText(text: string): string {
  let t = cleanText(text)
  t = t
    .split('\n')
    .filter((l) => !/^[\d\s\-—+()（）*＊·.、,，|]+$/.test(l))
    .filter((l) => !isVolatileLine(l))
    .join('\n')
  for (const w of UI_CHROME_WORDS) t = t.split(w).join('')
  t = t.replace(/1[3-9][\d*＊]{9}/g, (m) => canonicalPhone(m))
  return t.replace(/[\s\u00a0\u3000]+/g, '')
}

/**
 * 在容器及其附近找一个「这份简历自己的详情页链接」。
 *
 * 为什么需要它：从 `/recommend#preview` 预览面板采集时，`location.href` 是**列表页** ——
 * 存下来的来源就指不到具体简历。而预览面板上那个「全屏 / 新页面查看」按钮的 href
 * 通常就是详情页 URL，里面有 `resIdEncode`（平台的真 ID）。
 *
 * 一石二鸟：① 来源 URL 对了 ② 平台 ID 拿到真值，
 * 于是「预览面板采一次 + 详情页再采一次」会收敛到同一个 ID，不再重复建档。
 *
 * ⚠️ 刻意**不依赖具体 class**（站点改版就废）—— 只扫 `a[href]` 里符合 URL 形态的。
 */
export function findResumeDetailLink(doc: Document, root: Element): string | null {
  const scopes: Element[] = []
  let cur: Element | null = root
  for (let d = 0; d < 3 && cur; d++) {
    scopes.push(cur)
    cur = cur.parentElement
  }
  scopes.push(doc.documentElement)

  const hits: string[] = []
  for (const scope of scopes) {
    let links: Element[] = []
    try {
      // 用 `[href]` 而不是 `a[href]`：范围更宽（有些「全屏查看」不是 <a>），
      // 而且「标签+属性」复合选择器在测试用的极简 DOM 里不支持。
      links = Array.from(scope.querySelectorAll('[href]'))
    } catch {
      continue
    }
    for (const a of links) {
      const href = a.getAttribute('href') || ''
      if (!/(resume\/detail\?|resumeId=|resIdEncode=)/.test(href)) continue
      if (!/[?&](resIdEncode|resumeId)=/.test(href)) continue
      try {
        hits.push(new URL(href, doc.location?.href ?? 'https://www.liepin.com/').href)
      } catch {
        hits.push(href)
      }
    }
    // 最近的一层里找到了就不再往上找（越靠近简历容器越相关）
    if (hits.length > 0) break
  }
  if (hits.length === 0) return null

  // ⚠️ 优先级很重要：真实数据里点过「发起意向沟通」之后，页面上
  //    `https://msk.liepin.com/intention/order/addorder/?resIdEncode=…` 这种
  //    **下单页**链接会排到简历详情页前面。它虽然带 resIdEncode（拿 ID 没问题），
  //    但作为「这份简历的来源」是误导的 —— 点进去不是简历。
  //    所以：简历详情页 > 任何 /resume/ 路径 > 其它带 id 的链接。
  return (
    hits.find((h) => /\/resume\/detail/i.test(h)) ??
    hits.find((h) => /\/resume\//i.test(h)) ??
    hits[0]
  )
}

/** 从详情页 URL 里取平台简历 ID（`resIdEncode` 优先，其次 `resumeId`） */
export function resumeIdFromDetailUrl(url: string): string | null {
  try {
    const sp = new URL(url).searchParams
    for (const k of ['resIdEncode', 'resumeId', 'usercIdEncode']) {
      const v = sp.get(k)
      if (v && v.length >= 4) return `${k}:${v}`
    }
  } catch {
    const m = /[?&](resIdEncode|resumeId)=([^&#]+)/.exec(url)
    if (m) return `${m[1]}:${m[2]}`
  }
  return null
}

function readParams(sp: URLSearchParams, keys: string[]): string | null {
  for (const k of keys) {
    const v = sp.get(k)
    if (v && v.length >= 2 && v !== 'undefined' && v !== 'null') return `${k}:${v}`
  }
  return null
}

function readAttrs(root: Element, attrs: string[]): string | null {
  let cur: Element | null = root
  for (let depth = 0; depth < 8 && cur; depth++) {
    for (const a of attrs) {
      const v = cur.getAttribute?.(a)
      if (v && v.length >= 2 && v !== 'undefined' && v !== 'null') return `${a}:${v}`
    }
    if (depth === 0) {
      for (const a of attrs) {
        let hit: Element | null = null
        try {
          hit = cur.querySelector(`[${a}]`)
        } catch {
          hit = null
        }
        const v = hit?.getAttribute(a)
        if (v && v.length >= 2) return `${a}:${v}`
      }
    }
    cur = cur.parentElement
  }
  return null
}

/**
 * 推断候选人 ID（去重主键）。
 *
 * ⚠️ 这里曾经有个会「静默吃掉所有猎聘简历」的 bug：
 *    旧实现是 `URLSearchParams.get('id') || pathname 末段`。
 *    猎聘 IM 页 URL 形如 `/chat/im?jobId=85838997&jobKind=2&tab=message#preview`，
 *    既没有 id 参数，路径末段取到的又是路由词 `im` —— 于是同一职位下
 *    所有候选人都撞成同一个 ID `im`，被 background 判重后全部丢弃。
 *    现在明确禁止把路由词当 ID，最后兜底用内容指纹。
 */
export function pickCandidateId(
  doc: Document,
  loc: PageLocation,
  site: SiteProfile,
  root: Element,
  text: string,
  /** 从 DOM 里找到的「这份简历自己的详情页链接」（见 findResumeDetailLink） */
  detailUrl?: string | null
): string {
  // ① URL query
  const fromQuery = readParams(new URLSearchParams(loc.search || ''), site.idParams)
  if (fromQuery) return fromQuery

  // ② hash 里的 query（如 #preview?resumeId=xxx）
  const qi = (loc.hash || '').indexOf('?')
  if (qi >= 0) {
    const fromHash = readParams(new URLSearchParams(loc.hash.slice(qi + 1)), site.idParams)
    if (fromHash) return fromHash
  }

  // ③ DOM 里找到的详情页链接 —— 预览面板采集时**唯一能拿到平台真 ID 的来源**。
  //    排在 data-* 之前：它是平台自己给的简历 URL，比泛化的 data-id 可信。
  if (detailUrl) {
    const fromDetail = resumeIdFromDetailUrl(detailUrl)
    if (fromDetail) return fromDetail
  }

  // ④ 路径末段是长数字（如 /resume/12345678）—— 仅在不是路由词时才认
  const seg = (loc.pathname || '').split('/').filter(Boolean).pop() || ''
  if (/^\d{5,}$/.test(seg)) return `path:${seg}`

  // ⑤ 简历容器自身 / 祖先 / 内部元素上的 data-* 属性
  const fromDom = readAttrs(root, site.idAttrs)
  if (fromDom) return fromDom

  // ⑥ 正文里的**平台简历编号**（猎聘：`简历编号 / : CD34EF56AB7800cc33dd44`）。
  //    这是平台自己给的身份，比内容指纹硬得多 ——
  //    而且它**跨容器边界稳定**：同一个人的简历从预览面板采、从详情页采，
  //    编号都一样，于是两条路会算出同一个 ID、不再重复建档。
  //    （实测：编号与详情页 URL 里的 resIdEncode 是同一个值。）
  const resumeNo = extractResumeNo(text)
  if (resumeNo) return `resumeNo:${resumeNo}`

  // ⑦ 兜底：归一化内容指纹。
  //    为什么不用手机号/邮箱当主键？见 stableIdentity 的说明 ——
  //    容器边界松紧会让手机号出现或消失，同一个人反而算出两个键。
  //    归一化指纹把按钮文案、易变行、纯数字行、手机号写法差异全部抹平，
  //    只反映简历正文本身，是这里最稳的判据。
  //    宁可换一个 ID，也不能退化成路由词。
  const name = guessName(text)
  return `content:${hashStr(`${name}|${fingerprintText(text).slice(0, 1500)}`)}`
}

// ------------------------------------------------------------ 提取

export interface PageLocation {
  href: string
  hostname: string
  pathname: string
  search: string
  hash: string
}

export interface ExtractOutcome {
  ok: boolean
  payload?: CapturePayload
  via?: 'selector' | 'heuristic'
  chars?: number
  score?: number
  /** 从 DOM 里找到的详情页链接（有就说明来源 URL 与平台 ID 都拿到了真值） */
  detailUrl?: string | null
  /** 失败原因，供诊断与 popup 展示 */
  reason?: 'no-container' | 'text-too-short'
}

export function extractFrom(doc: Document, loc: PageLocation, site: SiteProfile): ExtractOutcome {
  const found = findResumeContainer(doc, site)
  if (!found) return { ok: false, reason: 'no-container' }

  // 先剥掉尾部操作区再算长度/指纹/入库正文：
  //   ① 它会让内容指纹随「剩N次权益」这类会变的文案漂移 → 重复建档；
  //   ② 排进 PDF 会印出「剩10次权益」。
  const text = stripResumeChrome(textOf(found.el))
  if (text.length < MIN_RESUME_CHARS) return { ok: false, reason: 'text-too-short' }

  // 从 DOM 里找「这份简历自己的详情页链接」：
  //   预览面板采集时 location.href 只是列表页，靠它才能拿到平台真 ID + 正确来源
  const detailUrl = findResumeDetailLink(doc, found.el)
  const id = pickCandidateId(doc, loc, site, found.el, text, detailUrl)

  return {
    ok: true,
    via: found.via,
    chars: text.length,
    score: found.score,
    detailUrl,
    payload: {
      platform: site.platform,
      platformCandidateId: id,
      // 优先用详情页链接（这份简历自己的），拿不到才退回当前页
      resumeUrl: detailUrl || loc.href,
      capturedUrl: loc.href,
      rawText: text,
      capturedAt: new Date().toISOString(),
      source: 'auto',
    },
  }
}

/**
 * 判断两次采集是否是「同一份简历」——不能拿 URL 当判据（IM 页切人 URL 不变）。
 *
 * 长度用的是**归一化后**的文本长度：原实现用 rawText.length，而同一份简历
 * 两次抓取的容器边界会差几十个字符（面板顶部多一个「继续沟通」按钮就够），
 * 于是闸门误判成「换了个人」、把同一份简历重复推给后端。
 * 现在把按钮文案/纯数字行/空白抹平后再比，抖动就没了。
 */
export function signatureOf(p: CapturePayload): string {
  return `${p.platform}|${p.platformCandidateId}|${fingerprintText(p.rawText).length}`
}

// ------------------------------------------------------------ 诊断

export interface DiagnoseReport {
  site: string
  url: string
  containerFound: boolean
  via?: string
  score?: number
  chars?: number
  topCandidates: Array<{ el: string; chars: number; hits: number; score: number }>
  canvasCount: number
  imageCount: number
  iframeCount: number
  verdict: string
  /**
   * 诊断「来源 URL 与平台 ID 是否拿到了真值」——
   * 从预览面板采集时，平台 ID 只能靠 DOM 里的详情页链接取得。
   */
  detailLink?: {
    found: boolean
    /** 找到的详情页链接（截断展示） */
    href?: string
    /** 能从中取出的平台 ID */
    id?: string
    /** 页面上匹配到多少个候选链接 */
    candidates: number
    /** 最终会用的平台 ID（含兜底） */
    resolvedId?: string
    /** 最终会存的来源 URL */
    resolvedResumeUrl?: string
  }
}

/**
 * 「为什么没采到」的一站式体检报告。
 * 在页面 Console 里执行 `__ria.scan()` 即可拿到。
 */
export function diagnose(doc: Document, loc: PageLocation, site: SiteProfile): DiagnoseReport {
  const found = findResumeContainer(doc, site)

  const all: Array<{ el: Element; chars: number; hits: number; score: number; order: number }> = []
  let order = 0
  for (const el of Array.from(doc.querySelectorAll('div,section,article,main'))) {
    order++
    const raw = (el as HTMLElement).textContent || ''
    const len = raw.length
    if (len < MIN_RESUME_CHARS || len > MAX_CONTAINER_CHARS) continue
    const hits = countHits(raw, RESUME_SECTIONS)
    if (hits < 1) continue
    all.push({ el, chars: len, hits, score: scoreResumeText(raw), order })
  }
  // 与 findResumeContainer 同序，保证报告里的第一条就是「最可能的那块」
  all.sort((a, b) => b.score - a.score || a.chars - b.chars || b.order - a.order)

  const topCandidates = all.slice(0, 8).map((c) => ({
    el: describeEl(c.el),
    chars: c.chars,
    hits: c.hits,
    score: c.score,
  }))

  const canvasCount = doc.querySelectorAll('canvas').length
  const imageCount = doc.querySelectorAll('img').length
  let iframeCount = 0
  try {
    iframeCount = doc.querySelectorAll('iframe').length
  } catch {
    iframeCount = 0
  }

  let verdict: string
  if (found) {
    verdict = `已识别简历内容区（${found.via === 'selector' ? '站点选择器' : '智能识别'}，${found.chars} 字），链路正常`
  } else if (topCandidates.length > 0) {
    verdict = `有 ${topCandidates.length} 个疑似容器但都未达阈值（最高 ${topCandidates[0].score} 分 / 需 ${PASS_SCORE}）——简历面板可能还没渲染完，或站点改版需要补选择器`
  } else if (canvasCount > 0 && imageCount > 0) {
    verdict = `页面有 ${canvasCount} 个 canvas、${imageCount} 张图片，但摘不出简历文本 —— 很可能是图片/canvas 渲染，需要「截图 + 多模态解析」（P2 方案）`
  } else if (iframeCount > 0) {
    verdict = `本框架内没有简历文本，页面有 ${iframeCount} 个 iframe —— 简历可能在 iframe 里，确认扩展已开启 all_frames 并重新加载`
  } else {
    verdict = '未识别到简历内容区 —— 确认已在页面上点开某位候选人的在线简历（预览面板处于打开状态）'
  }

  // ---- 来源 URL 与平台 ID 是否拿到了真值（预览面板采集时只能靠 DOM 里的详情链接）
  let detailLink: DiagnoseReport['detailLink']
  {
    const candidates = Array.from(doc.querySelectorAll('[href]')).filter((a) => {
      const h = a.getAttribute('href') || ''
      return /[?&](resIdEncode|resumeId)=/.test(h)
    })
    const href = found ? findResumeDetailLink(doc, found.el) : null
    const fromDetail = href ? resumeIdFromDetailUrl(href) : null
    const text = found ? stripResumeChrome(textOf(found.el)) : ''
    const resolvedId = found
      ? pickCandidateId(doc, loc, site, found.el, text, href)
      : undefined
    detailLink = {
      found: !!href,
      href: href ? href.slice(0, 160) : undefined,
      id: fromDetail ?? undefined,
      candidates: candidates.length,
      resolvedId,
      resolvedResumeUrl: found ? href || loc.href : undefined,
    }
  }

  return {
    site: site.platform,
    url: loc.href,
    containerFound: !!found,
    via: found?.via,
    score: found?.score,
    chars: found?.chars,
    topCandidates,
    canvasCount,
    imageCount,
    iframeCount,
    verdict,
    detailLink,
  }
}
