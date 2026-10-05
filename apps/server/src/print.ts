// ============================================================
// 简历打印页（浏览器打印 → PDF）
// ------------------------------------------------------------
// 为什么不做成前端页面：
//   这份东西要发给业务部门，必须「打开就是一份 A4 文档」——
//   不能依赖看板的路由、也不能被 SPacker 打包进前端里等着人点。
//   所以由后端直接吐一整页自包含 HTML：内联 CSS、零外部资源
//   （无图片 / 无字体文件 / 无 JS 库），断网、内网、跳板机上都长一个样。
//
// ★ 安全前提：正文是从外部招聘网站抓来的**不受信内容**。
//   本文件里**所有**来自数据侧的字符串都必须过 esc() 之后才允许拼进 HTML，
//   一处漏掉就是一个 XSS。换行一律交给 CSS 的 `white-space: pre-wrap`，
//   绝不用 innerHTML / dangerouslySetInnerHTML 那种「让正文自己变成标签」的写法。
//
// ★ 排版降级：parseResumeSections() 给的是置信度。
//   high / medium → 按结构化区块排（好看）；
//   low          → 不硬排版，按清洗后的原文逐行输出 + 顶部提示（宁可朴素也不印错）。
//   无论哪种置信度，只要 raw=1 就再附一份「未结构化原文」在最后。
// ============================================================
import type {
  Candidate,
  CandidateDetail,
  CandidateSource,
  Match,
  ResumeSections,
} from '@ria/shared'
import { parseResumeSections, stripResumeChrome, UI_CHROME_WORDS } from '@ria/shared'

// ------------------------------------------------------------ 选项

/** 打印页的开关（对应 URL 查询参数，全部默认开启） */
export interface PrintFlags {
  /** 印匹配度与命中点 / 缺失点 */
  score: boolean
  /** 页脚印来源链接与采集时间 */
  source: boolean
  /** 附「未结构化原文」 */
  raw: boolean
  /** 页面加载后自动唤起打印对话框 */
  auto: boolean
}

export const DEFAULT_FLAGS: PrintFlags = { score: true, source: true, raw: true, auto: true }

/** 批量上限 —— 一次生成几百人的 HTML 会把浏览器和内存都拖死 */
export const BATCH_LIMIT = 50

/** 一张简历页（单人）或批量里的一节 */
export interface PrintCard {
  id: string
  detail: CandidateDetail
  /** 页眉上印的「应聘岗位」 */
  positionTitle: string
  /** 选中的那条匹配（可能没有：还没归岗） */
  match?: Match
  /** 批量模式下的「1 / 3」 */
  index?: number
  total?: number
}

// ------------------------------------------------------------ 转义

/**
 * HTML 转义 —— 数据侧字符串进 HTML 的唯一入口。
 *
 * `&` 必须第一个换，否则会把后面生成的 `&lt;` 再转成 `&amp;lt;`。
 * 单引号用 `&#39;`（属性用双引号包裹，但转义了更保险）。
 */
export function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 多行文本 → HTML。
 *
 * 刻意**不**把 `\n` 换成 `<br>`：正文里本来就可能出现 `<br>` 字符串，
 * 一旦我们把换行折叠成标签，就很难再向人解释「哪些标签是我们加的、哪些是抓来的」。
 * 统一用 `white-space: pre-wrap` 让浏览器按文本渲染换行 —— 正文永远只是文本。
 */
const pre = (s: string): string => esc(s)

/** 「A · B」—— 跳过空值，全空返回 '' */
function joinParts(parts: Array<string | undefined | null>, sep = ' · '): string {
  return parts.map((p) => (p ?? '').trim()).filter(Boolean).join(sep)
}

/** 时间区间 + 时长 */
function periodOf(p: { period?: string; duration?: string }): string {
  const period = (p.period ?? '').trim()
  const dur = (p.duration ?? '').trim()
  if (!period) return dur
  if (!dur) return period
  return `${period}（${dur}）`
}

// ------------------------------------------------------------ 选择岗位 / 来源

/**
 * 选「页眉上要印的岗位」：显式 positionId → 分数最高的 match → 未归岗。
 * 返回值里 match 为空表示这个人还没挂任何岗位。
 */
export function pickMatch(
  matches: Array<Match & { positionTitle: string }>,
  positionId?: string
): { positionTitle: string; match?: Match & { positionTitle: string } } {
  if (positionId) {
    const hit = matches.find((m) => m.positionId === positionId)
    if (hit) return { positionTitle: hit.positionTitle, match: hit }
  }
  if (matches.length > 0) {
    // store.detail() 已按分数倒序，这里再排一次是为了不依赖调用方
    const top = [...matches].sort((a, b) => b.score - a.score)[0]
    return { positionTitle: top.positionTitle, match: top }
  }
  return { positionTitle: '未归岗', match: undefined }
}

/** 主来源：sources 已按 capturedAt 倒序，取第一条 */
function primarySource(sources: CandidateSource[]): CandidateSource | undefined {
  return sources.length > 0 ? sources[0] : undefined
}

/** 采集方式：manual → 手动保存；其余（含老数据缺字段）→ 自动采集 */
export function captureMethodLabel(s?: CandidateSource): string {
  return s?.captureMethod === 'manual' ? '手动保存' : '自动采集'
}

/** ISO → `2026-09-30 14:05`（本地时区，便于人核对） */
function fmtTime(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 页脚那句话（每页固定重复，见 FOOTER_NOTE 的用法说明） */
const FOOTER_NOTE = '本简历由「招聘捕手」从猎聘在线简历文本自动生成，非候选人原附件简历，仅供内部招聘评估使用。'

// ------------------------------------------------------------ HTML 骨架

/**
 * A4 + 中文字体 + 零外部资源。
 *
 * 页脚方案：`position: fixed; bottom: 0`（**每一页都会出现**）。
 * 代价是它不占文档流，可能压住正文最后一行 —— 用 `.pdoc { padding-bottom }`
 * 给它留出专属空间来抵消（留 26mm，比页脚自身高）。
 */
// 注意：<style> 里的注释也是页面可见文本（Ctrl+F 能找到），
// 所以「区块名」这类词**不要**写进 CSS 注释，否则关闭开关后仍能在页面里搜到。
const STYLES = `
@page { size: A4; margin: 14mm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Source Han Sans SC", system-ui, sans-serif;
  font-size: 13px;
  line-height: 1.6;
  color: #1f2328;
  background: #f1f3f5;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.pdoc {
  position: relative;
  background: #fff;
  max-width: 820px;
  margin: 0 auto 24px;
  padding: 26px 30px 26mm;
}
.pdoc + .pdoc { margin-top: 24px; }

/* ---- 屏幕专用：返回看板 ---- */
.pbar {
  position: sticky; top: 0; z-index: 5;
  display: flex; align-items: center; gap: 12px;
  background: #23272b; color: #e9ecef;
  padding: 8px 16px; font-size: 12px;
}
.pbar a { color: #9ecbff; text-decoration: none; }
.pbar a:hover { text-decoration: underline; }
.pbar .sp { flex: 1; }
.pbar .hint { color: #adb5bd; }

/* ---- 页眉信息条 ---- */
.phead { display: flex; align-items: flex-start; gap: 20px; border-bottom: 2px solid #2f3439; padding-bottom: 10px; }
.phead .who { flex: 1; min-width: 0; }
.pname { font-size: 25px; font-weight: 700; line-height: 1.25; letter-spacing: .5px; }
.pmeta { margin-top: 5px; color: #3f454b; }
.pmeta2 { color: #5b636a; }
.pside { flex: none; width: 34%; text-align: right; padding-top: 3px; }
.pside .label { font-size: 11px; color: #868e96; letter-spacing: 2px; }
.pside .val { font-weight: 700; font-size: 15px; line-height: 1.4; word-break: break-word; }
.pscore { display: inline-block; margin-top: 7px; font-size: 12px; padding: 1px 10px; border: 1px solid #b9c0c7; border-radius: 10px; }
.pscore b { font-size: 15px; }

/* ---- 章节 ---- */
.sec { margin-top: 15px; break-inside: auto; }
.sec-h {
  font-size: 14px; font-weight: 700; letter-spacing: 3px; color: #1f2328;
  border-left: 4px solid #2f3439; padding-left: 8px; margin-bottom: 7px;
}
.sec-h .sub { font-size: 11px; font-weight: 400; letter-spacing: 0; color: #868e96; margin-left: 8px; }
.blk { margin: 0 0 11px; break-inside: avoid; }
.blk:last-child { margin-bottom: 0; }
.blk-h { display: flex; align-items: baseline; gap: 10px; }
.blk-h .main { font-weight: 700; }
.blk-h .sub { color: #3f454b; }
.blk-h .sp { flex: 1; }
/* 起止 + 时长：刻意用普通字重 + 深灰，避免抢「公司 / 职位」的注意力 */
.blk-h .when { flex: none; color: #4a5157; white-space: nowrap; }
.blk-b { margin-top: 2px; color: #30363c; white-space: pre-wrap; }
.blk-b ul { margin: 2px 0 0; padding-left: 1.15em; }
.blk-b li { margin: 0 0 1px; }
.line { white-space: pre-wrap; }
.chips { display: flex; flex-wrap: wrap; gap: 5px; }
.chip {
  display: inline-block; padding: 0 9px; border: 1px solid #c8ced4;
  border-radius: 3px; background: #f8f9fa; white-space: nowrap;
}
.hr { border: 0; border-top: 1px solid #e3e6e9; margin: 15px 0 0; }

/* ---- raw text appendix ---- */
.rawbox { margin-top: 15px; }
.rawbox .raw {
  font-family: Consolas, "Courier New", monospace;
  font-size: 11px; line-height: 1.55; color: #3f454b;
  white-space: pre-wrap; word-break: break-word;
  background: #fafbfc; border: 1px solid #e3e6e9; border-radius: 3px;
  padding: 9px 11px; margin-top: 5px;
}

/* ---- 提示条 ---- */
.notice {
  margin: 12px 0 0; padding: 7px 10px;
  background: #f8f6ef; border-left: 3px solid #9c8f6a;
  color: #5c5646; font-size: 12px;
}
.pdoc > .notice:first-child { margin-top: 0; }

/* ---- 批量标题 ---- */
.pbtitle {
  font-size: 12px; letter-spacing: 1px; color: #495057;
  border-bottom: 1px solid #dee2e6; padding-bottom: 5px; margin-bottom: 13px;
}
.pbtitle b { color: #1f2328; }

/* ---- 页脚（每页固定） ---- */
.pfoot {
  position: fixed; left: 0; right: 0; bottom: 0;
  padding: 6px 30px 9px;
  border-top: 1px solid #d7dbdf;
  background: #fff;
  font-size: 10.5px; line-height: 1.5; color: #6b7379;
}
.pfoot .r1 { word-break: break-all; }
.pfoot .r2 { color: #868e96; }
.pfoot .num { float: right; margin-left: 10px; }

@media print {
  body { background: #fff; font-size: 13px; }
  .no-print { display: none !important; }
  .pdoc { max-width: none; margin: 0; padding: 0 0 26mm; }
  /* 批量：每人从新页开始（第一个人不带，由渲染器控制） */
  .pdoc + .pdoc { page-break-before: always; break-before: page; margin-top: 0; }
  .sec-h { break-after: avoid; page-break-after: avoid; }
  .blk-h { break-after: avoid; page-break-after: avoid; }
}
`

/** 批量模式下被截断时的说明（超过 BATCH_LIMIT 人） */
function truncNote(kept: number, requested: number): string {
  return (
    `<div class="notice no-print">一次最多打印 ${BATCH_LIMIT} 份简历，` +
    `请求的 ${requested} 人中只取前 ${kept} 人；` +
    `其余请分批打印。</div>`
  )
}

/**
 * 组装一张完整的自包含打印页。
 *
 * @param cards   若干张简历卡（错误页传空数组）
 * @param footers 页脚 HTML（固定定位，每页重复；错误页传空串）
 * @param note    顶部提示条（批量截断说明等），放在第一张卡之前
 */
function shell(
  title: string,
  cards: string[],
  footers: string,
  flags: PrintFlags,
  note = ''
): string {
  const autoScript = flags.auto
    ? '\n  <script>window.onload = function () { window.print() }</script>'
    : ''
  const bar = cards.length
    ? '<div class="pbar no-print"><a href="/">← 返回看板</a>' +
      '<span class="hint">本页可直接用浏览器打印（Ctrl / ⌘ + P）导出 PDF</span>' +
      '<span class="sp"></span><span class="hint">' +
      esc(flags.auto ? '已开启自动唤起打印对话框' : '未自动唤起打印对话框') +
      '</span></div>'
    : ''

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<style>${STYLES}</style>
</head>
<body>
${bar}
${note}
${cards.join('\n')}
${footers}${autoScript}
</body>
</html>`
}

// ------------------------------------------------------------ 错误页

export function renderErrorPage(status: number, heading: string, message: string): string {
  return shell(`打印失败（${status}）`, [], '', { ...DEFAULT_FLAGS, auto: false, score: false, source: false, raw: false })
    .replace(
      '<body>',
      `<body>
<div class="pdoc">
  <div class="phead"><div class="who">
    <div class="pname">${esc(heading)}</div>
    <div class="pmeta">HTTP ${esc(status)}</div>
  </div></div>
  <div class="notice">${esc(message)}</div>
  <div class="sec"><div class="sec-h">怎么办</div>
    <div class="line">· 回到看板，从候选人详情页重新点「打印简历」</div>
    <div class="line">· 若链接是别人发来的，可能该候选人已被删除或数据已重置</div>
  </div>
</div>`
    )
}

// ------------------------------------------------------------ 各区块

function headerHtml(c: Candidate, positionTitle: string, match: Match | undefined, flags: PrintFlags): string {
  const degree = joinParts([c.degree, c.educationMode ? `(${c.educationMode})` : ''])
  const meta = joinParts([
    c.gender === 'M' ? '男' : c.gender === 'F' ? '女' : '',
    c.age !== undefined ? `${c.age} 岁` : '',
    c.city,
    degree,
    c.yearsOfExperience !== undefined ? `${c.yearsOfExperience} 年经验` : '',
  ])
  const meta2 = joinParts([c.school, c.major, c.schoolTier])
  const contact = joinParts([c.phone, c.email])

  const scoreHtml =
    flags.score && match
      ? `<div class="pscore">匹配度 <b>${esc(match.score)}</b> 分</div>`
      : ''

  return `<div class="phead">
  <div class="who">
    <div class="pname">${esc(c.name || '未识别姓名')}</div>
    ${meta ? `<div class="pmeta">${esc(meta)}</div>` : ''}
    ${meta2 ? `<div class="pmeta2">${esc(meta2)}</div>` : ''}
    ${contact ? `<div class="pmeta2">${esc(contact)}</div>` : ''}
  </div>
  <div class="pside">
    <div class="label">应聘岗位</div>
    <div class="val">${esc(positionTitle)}</div>
    ${scoreHtml}
  </div>
</div>`
}

function secHtml(title: string, inner: string, sub = ''): string {
  if (!inner.trim()) return ''
  return `<div class="sec">
  <div class="sec-h">${esc(title)}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</div>
  ${inner}
</div>`
}

function intentionHtml(sections: ResumeSections, c: Candidate): string {
  const it = sections.intention
  const lines: string[] = []
  if (it) {
    if (it.positions.length > 0) lines.push(`期望职位：${it.positions.join(' / ')}`)
    if (it.salary) lines.push(`期望薪资：${it.salary}`)
    if (it.cities.length > 0) lines.push(`期望城市：${it.cities.join('、')}`)
    if (it.industries && it.industries.length > 0) lines.push(`期望行业：${it.industries.join('、')}`)
  }
  // 兜底：求职意向没能从正文里结构出来时，用候选人字段（parseResumeText 抽的）
  if (lines.length === 0) {
    const fallback = joinParts([c.intention, c.expectedSalary])
    if (!fallback) return ''
    lines.push(fallback)
  }
  return lines.map((l) => `<div class="line">${pre(l)}</div>`).join('')
}

function bulletHtml(bullets: string[]): string {
  const items = bullets.map((b) => b.trim()).filter(Boolean)
  if (items.length === 0) return ''
  return `<ul>${items.map((b) => `<li>${pre(b)}</li>`).join('')}</ul>`
}

function experiencesHtml(sections: ResumeSections): string {
  const blocks = sections.experiences.map((e) => {
    const head = joinParts([e.company, e.title], ' / ')
    const when = periodOf(e)
    return `<div class="blk">
  <div class="blk-h">
    <span class="main">${esc(head || e.company || e.title || '')}</span>
    <span class="sp"></span>
    ${when ? `<span class="when">${esc(when)}</span>` : ''}
  </div>
  ${e.bullets.length > 0 ? `<div class="blk-b">${bulletHtml(e.bullets)}</div>` : ''}
</div>`
  })
  return blocks.join('')
}

function projectsHtml(sections: ResumeSections): string {
  const blocks = sections.projects.map((p) => {
    const head = joinParts([p.name, p.title || p.company], ' / ')
    const when = periodOf(p)
    return `<div class="blk">
  <div class="blk-h">
    <span class="main">${esc(head || p.name)}</span>
    <span class="sp"></span>
    ${when ? `<span class="when">${esc(when)}</span>` : ''}
  </div>
  ${p.bullets.length > 0 ? `<div class="blk-b">${bulletHtml(p.bullets)}</div>` : ''}
</div>`
  })
  return blocks.join('')
}

function educationHtml(sections: ResumeSections): string {
  const blocks = sections.education.map((e) => {
    const main = joinParts([e.school, e.major], ' · ')
    const right = joinParts([e.degree, e.mode, e.tier], ' · ')
    return `<div class="blk">
  <div class="blk-h">
    <span class="main">${esc(main || e.school)}</span>
    <span class="sp"></span>
    ${right ? `<span class="sub">${esc(right)}</span>` : ''}
    ${e.period ? `<span class="when">${esc(e.period)}</span>` : ''}
  </div>
</div>`
  })
  return blocks.join('')
}

function skillsHtml(sections: ResumeSections, c: Candidate): string {
  const list = sections.skills.length > 0 ? sections.skills : c.skills ?? []
  const uniq = [...new Set(list.map((s) => s.trim()).filter(Boolean))]
  if (uniq.length === 0) return ''
  return `<div class="chips">${uniq.map((s) => `<span class="chip">${esc(s)}</span>`).join('')}</div>`
}

function languagesHtml(sections: ResumeSections): string {
  if (sections.languages.length === 0) return ''
  return sections.languages.map((l) => `<div class="line">${pre(l)}</div>`).join('')
}

function rawHtml(text: string): string {
  if (!text.trim()) return ''
  return `<div class="raw">${pre(text)}</div>`
}

/** 置信度 low：不硬排版，把清洗后的原文逐行原样输出 */
function plainBodyHtml(text: string): string {
  const lines = (text || '').replace(/\r/g, '').split('\n')
  return lines.map((l) => `<div class="line">${esc(l)}</div>`).join('')
}

/**
 * 分节核对：把 parseResumeSections 切出来的原始分节逐行印出来。
 *
 * 只在 confidence === 'medium' 时用。原因很实在 ——
 *   high  ：靠「*该段内容已整合附件简历信息」这种块结束标记切的，结构化结果可信，不必再印；
 *   medium：章节认出来了，但块内字段是**按模式猜**的。真实数据里就出现过
 *           「工作经历」只认出 3 条 bullet，而正文里同一段还有十几行没进结构化字段。
 *           一份要发给业务的简历，宁可多印半页冗余，也不能让 HR 以为这就是全部内容。
 */
const BLOCKS_SKIP = new Set(['求职意向', '技能标签', '专业技能', '语言能力'])

/**
 * 分节核对里要丢掉的行 = 抓取时混进来的面板按钮文案。
 * `stripResumeChrome()` 只切尾部操作区，正文中间的「查看大图 / 展开 / 发起意向沟通」
 * 会留在 blocks 里 —— 直接印出来很不专业，正好共享包里有一份现成的按钮词表。
 */
function isChromeLine(line: string): boolean {
  const l = line.trim()
  return UI_CHROME_WORDS.some((w) => l === w)
}

function blocksHtml(sections: ResumeSections): string {
  const parts = sections.blocks
    .filter((b) => !BLOCKS_SKIP.has(b.title))
    .map((b) => ({ title: b.title, lines: b.lines.filter((l) => !isChromeLine(l)) }))
    .filter((b) => b.lines.length > 0)
    .map(
      (b) =>
        `<div class="blk"><div class="blk-h"><span class="main">${esc(b.title)}</span></div>` +
        `<div class="blk-b">${b.lines.map((l) => `<div class="line">${esc(l)}</div>`).join('')}</div></div>`
    )
  if (parts.length === 0) return ''
  return `<div class="notice">以下为按章节切出的原文，用于核对上面的结构化字段是否有遗漏。</div>` + parts.join('')
}

// ------------------------------------------------------------ 卡片

/** 该印「匹配度」相关区块的哪些部分 —— 返回的 inner 直接丢进 secHtml */
function matchInner(match: Match | undefined): string {
  if (!match) return ''
  const parts: string[] = []
  if (match.hitPoints.length > 0) {
    parts.push(
      `<div class="blk"><div class="blk-h"><span class="main">命中点</span></div>` +
        `<div class="blk-b">${bulletHtml(match.hitPoints)}</div></div>`
    )
  }
  if (match.missPoints.length > 0) {
    parts.push(
      `<div class="blk"><div class="blk-h"><span class="main">缺失点</span></div>` +
        `<div class="blk-b">${bulletHtml(match.missPoints)}</div></div>`
    )
  }
  return parts.join('')
}

/**
 * 渲染一张简历卡（单人页 / 批量里的一节）。
 *
 * 注意：只有**批量**调用方才会给 index/total 并加 `page-break-before`，
 * 单人页永远不带分页样式（否则会先吐一张白纸）。
 */
export function renderCard(card: PrintCard, flags: PrintFlags): { html: string; footer: string } {
  const { candidate } = card.detail
  const cleaned = stripResumeChrome(candidate.resumeText ?? '')
  const sections = parseResumeSections(candidate.resumeText ?? '')

  const batchTitle =
    card.index && card.total
      ? `<div class="pbtitle"><b>${esc(card.index)} / ${esc(card.total)}</b>　` +
        `${esc(candidate.name || '未识别姓名')} — ${esc(card.positionTitle)}</div>`
      : ''

  const lowNotice =
    sections.confidence === 'low'
      ? `<div class="notice">本页内容由页面文本自动分节，未做结构化，可能不完全准确。</div>`
      : ''

  // ---- 正文：按置信度决定呈现方式
  let body = ''
  if (sections.confidence === 'low') {
    body =
      secHtml('简历正文', plainBodyHtml(cleaned), '（原文逐行输出）') +
      secHtml('教育经历', educationHtml(sections)) +
      secHtml('技能标签', skillsHtml(sections, candidate)) +
      secHtml('语言能力', languagesHtml(sections))
    if (!body.trim()) body = `<div class="sec"><div class="line">（正文为空）</div></div>`
  } else {
    body =
      secHtml('求职意向', intentionHtml(sections, candidate)) +
      secHtml('工作经历', experiencesHtml(sections)) +
      secHtml('项目经历', projectsHtml(sections)) +
      secHtml('教育经历', educationHtml(sections)) +
      secHtml('技能标签', skillsHtml(sections, candidate)) +
      secHtml('语言能力', languagesHtml(sections))
    if (!body.trim()) {
      // 置信度说「有结构」，但结构全是空的 —— 保底仍要把正文印出来，绝不交白卷
      body = secHtml('简历正文', plainBodyHtml(cleaned), '（原文逐行输出）')
    }
    // medium：块内字段是猜的，追加一份「按章节切出的原文」供核对（high 时结构可信，不重复印）
    if (sections.confidence === 'medium') {
      body += secHtml('正文分节核对', blocksHtml(sections), '（未经结构化，原文）')
    }
  }

  // 岗位名一律取 card.positionTitle（就是页眉上印的那个岗位），
  // 不要从 match 上找 positionTitle —— Match 类型本身没有这个字段。
  const scoreSec =
    flags.score && card.match
      ? secHtml(
          '匹配度与评估',
          matchInner(card.match),
          joinParts(
            [card.positionTitle, `${card.match.score} 分`, card.match.modelVersion],
            ' · '
          )
        )
      : ''

  const rawSec =
    flags.raw && cleaned.trim()
      ? `<div class="sec rawbox"><div class="sec-h">未结构化原文</div>${rawHtml(cleaned)}</div>`
      : ''

  const cls = card.index && card.index > 1 ? 'pdoc' : 'pdoc first'
  const html = `<div class="${cls}">
${batchTitle}${headerHtml(candidate, card.positionTitle, card.match, flags)}
${lowNotice}
${body}
${scoreSec}
${rawSec}
</div>`

  return { html, footer: footerFor(card.detail, flags) }
}

/** 页脚内容（固定定位，每页重复） */
function footerFor(detail: CandidateDetail, flags: PrintFlags): string {
  if (!flags.source) return ''
  const src = primarySource(detail.sources)
  const url = src?.resumeUrl || src?.capturedUrl || ''
  // capturedUrl 是「实际采到这份简历的页面」，只有和简历自己的链接不同时才附上 ——
  // 相同的话印两遍纯属噪声，不同的话是排查溯源的关键信息。
  const capturedExtra = src?.capturedUrl && src.capturedUrl !== src.resumeUrl ? `采集页：${src.capturedUrl}` : ''
  const line1 = joinParts(
    [
      url ? `来源：${url}` : '来源：无（未记录链接）',
      capturedExtra,
      // 平台简历编号（猎聘的 `简历编号`）：HR 报问题时报这个比报内部 id 好沟通
      detail.candidate.resumeNo ? `简历编号：${detail.candidate.resumeNo}` : '',
      src?.capturedAt ? `采集时间 ${fmtTime(src.capturedAt)}` : '',
      `采集方式：${captureMethodLabel(src)}`,
      src?.platform ? `平台：${src.platform}` : '',
    ],
    '　｜　'
  )
  return `<div class="pfoot"><div class="r1">${esc(line1)}</div><div class="r2">${esc(FOOTER_NOTE)}</div></div>`
}

// ------------------------------------------------------------ 单页 / 批量

/** 单人打印页 */
export function renderSinglePage(card: PrintCard, flags: PrintFlags): string {
  const { html, footer } = renderCard(card, flags)
  const title = `${card.detail.candidate.name || '候选人'} 简历 · ${card.positionTitle}`
  return shell(title, [html], footer, flags)
}

/** 批量打印页：多人合并成一份文档，第二个人起强制另起一页 */
export function renderBatchPage(
  cards: PrintCard[],
  flags: PrintFlags,
  extra?: { requested?: number; kept?: number; missing?: string[] }
): string {
  const rendered = cards.map((c) => renderCard(c, flags))
  const note =
    extra?.requested !== undefined && extra.kept !== undefined && extra.requested > extra.kept
      ? truncNote(extra.kept, extra.requested)
      : ''
  const missingNote =
    extra?.missing && extra.missing.length > 0
      ? `<div class="notice no-print">以下 id 未找到，已跳过：${esc(extra.missing.join('、'))}</div>`
      : ''
  // 页脚固定定位会重复出现；批量里各人的来源不同，所以取所有出现过的来源行合并
  const footers = [...new Set(rendered.map((r) => r.footer).filter(Boolean))].join('\n')
  const title =
    cards.length === 1
      ? `${cards[0].detail.candidate.name || '候选人'} 简历`
      : `批量简历打印（${cards.length} 人）`
  return shell(title, rendered.map((r) => r.html), footers, flags, note + missingNote)
}

/** 从查询串里读开关：只有显式 `0` 才是关，其余（含缺省）都是开 */
export function flagsFromQuery(q: Record<string, unknown>): PrintFlags {
  const on = (v: unknown): boolean => String(v ?? '1') !== '0'
  return {
    score: on(q.score),
    source: on(q.source),
    raw: on(q.raw),
    auto: on(q.auto),
  }
}

/** 逗号分隔的 id 列表 → 去重、去空、保序 */
export function parseIds(raw: unknown, limit = BATCH_LIMIT): { ids: string[]; requested: number } {
  const all = String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const uniq = [...new Set(all)]
  return { ids: uniq.slice(0, limit), requested: uniq.length }
}
