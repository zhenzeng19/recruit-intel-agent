// ============================================================
// 规则版岗位匹配（P0.5）
// ------------------------------------------------------------
// 为什么需要它：
//   扩展把简历推上来时，只有一段「简历原文」。而看板的候选人列表是
//   「候选人 × 岗位」的视图，默认按匹配度倒序 —— 没有匹配记录的人
//   score 为空，会被压到列表最底部，HR 打开看板第一屏根本看不到，
//   观感上就像「我采了但看板没刷新」。
//   所以采集落库的那一刻，先用一套规则给简历打个分、挂到最合适的岗位上，
//   让新简历立刻以正常形态进入列表 / 漏斗 / 待办。
//
// 定位与边界：
//   · 这是**粗筛**，不是终判。分数只用来排序和分层，不做淘汰。
//   · 分数与命中理由都标了 modelVersion='rule-v1'，等 P1 接上大模型后
//     由模型覆盖同一批 match，前端无需改动。
//   · 刻意不做分词：这个行业的写法高度固定（OpenCV / Halcon / 缺陷检测 /
//     Zemax…），维护一份术语表比通用分词更准、也更好解释给 HR 听。
// ============================================================
import { TECH_TERMS, extractYearsOfExperience } from '@ria/shared'
import type { Candidate, Match, Position } from '@ria/shared'

// 行业术语表（TECH_TERMS）已移到 @ria/shared：
//   服务端用它给 JD 打分，字段提取用它给简历打技能标签 —— 同一份词典两处用，
//   放在共享包只维护一次。

/** 岗位标题里的通用词 —— 抽标题核心词时要剔除，否则「工程师」人人命中 */
const TITLE_STOPWORDS = [
  '高级', '资深', '中级', '初级', '工程师', '主管', '经理', '专家', '岗',
  '负责', '招聘', '（', '）', '(', ')', '、', '/', '·', ' ',
]

const norm = (s: string): string => (s || '').toLowerCase()

/** 在一段文本里命中哪些术语 */
function termsIn(text: string): Set<string> {
  const hay = norm(text)
  const out = new Set<string>()
  for (const t of TECH_TERMS) {
    if (hay.includes(norm(t))) out.add(t)
  }
  return out
}

/** 岗位标题里的核心词（「高级视觉算法工程师（缺陷检测）」→ 视觉算法 / 缺陷检测） */
function titleCores(position: Position): string[] {
  let t = position.title
  for (const w of TITLE_STOPWORDS) t = t.split(w).join('|')
  return t
    .split('|')
    .map((x) => x.trim())
    .filter((x) => x.length >= 2)
}

/** 岗位的「要求画像」：JD 全文里出现的术语 + 标题核心词 */
function positionProfile(position: Position) {
  const blob = [position.title, position.jdText, ...position.hardRequirements, ...position.niceToHave].join('\n')
  const terms = termsIn(blob)
  const cores = titleCores(position)
  return { terms, cores }
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi)

/** 学位关键词 → 权重（用于「学历条件是否满足」的粗判） */
function degreeOf(text: string): string {
  if (text.includes('博士')) return '博士'
  if (text.includes('硕士') || text.includes('研究生')) return '硕士'
  if (text.includes('本科')) return '本科'
  if (text.includes('大专') || text.includes('专科')) return '大专'
  return ''
}

/**
 * 从简历文本里粗提工作年限。
 *
 * ⚠️ 这里曾经和 `store.parseResumeText()` 各写了一份**不一致**的正则：
 *    本文件这版能认「工作2年」，store 那版要求「经验」二字 —— 结果真实猎聘简历
 *    （头部写的是 `工作17年`）在候选人的 yearsOfExperience 字段上全是空的，
 *    而规则打分时又能拿到年限。同一份代码两个答案。
 *    现在统一走共享包的 `extractYearsOfExperience()`。
 */
function yearsOf(text: string): number | null {
  return extractYearsOfExperience(text) ?? null
}

export interface RuleScore {
  positionId: string
  score: number
  hitPoints: string[]
  missPoints: string[]
}

/**
 * 给一份简历对单个岗位打规则分。
 *
 * 打分口径（可解释，不搞黑箱）：
 *   基础分 30
 *   + 岗位要求术语的覆盖率 × 50   ← 主项
 *   + 标题核心词命中 12
 *   + 学历达到岗位要求 6
 *   上限 94 —— 规则分永远到不了「强推」区间(≥85 且带强理由)，
 *   避免机器粗筛把高分名额占了、挤掉后面真实的人工/模型判断。
 */
export function scoreAgainst(position: Position, resumeText: string, candidate?: Candidate): RuleScore {
  const { terms: jobTerms, cores } = positionProfile(position)
  const resTerms = termsIn(resumeText)

  const overlap = [...jobTerms].filter((t) => resTerms.has(t))
  const missed = [...jobTerms].filter((t) => !resTerms.has(t))
  const titleHit = cores.some((c) => norm(resumeText).includes(norm(c)))

  const coverage = jobTerms.size > 0 ? overlap.length / jobTerms.size : 0

  const degree = degreeOf(resumeText)
  const needMaster = /硕士|研究生/.test([position.jdText, ...position.hardRequirements].join('\n'))
  const degreeOk = needMaster ? degree === '硕士' || degree === '博士' : degree !== ''
  const yoe = yearsOf(resumeText) ?? candidate?.yearsOfExperience ?? null

  let score = 30 + coverage * 50 + (titleHit ? 12 : 0) + (degreeOk ? 6 : 0)
  score = Math.round(clamp(score, 20, 94))

  const hitPoints: string[] = []
  if (titleHit) {
    const hitCore = cores.find((c) => norm(resumeText).includes(norm(c)))
    if (hitCore) hitPoints.push(`岗位方向对口：简历中出现「${hitCore}」`)
  }
  if (overlap.length > 0) {
    hitPoints.push(`命中岗位要求关键词 ${overlap.length} 项：${overlap.slice(0, 8).join(' / ')}`)
  }
  if (degreeOk) hitPoints.push(`学历满足：${degree || '已注明学历'}`)
  if (yoe !== null) hitPoints.push(`工作年限约 ${yoe} 年`)
  hitPoints.push('（规则初筛 rule-v1，等大模型结构化后复核）')

  const missPoints: string[] = []
  if (!titleHit && cores.length > 0) missPoints.push(`岗位方向未直接命中：${cores.join(' / ')}`)
  if (missed.length > 0) missPoints.push(`岗位要求中未出现：${missed.slice(0, 6).join(' / ')}`)
  if (!degree) missPoints.push('简历中未明确学历')
  if (yoe === null) missPoints.push('简历中未明确工作年限')

  return { positionId: position.id, score, hitPoints: hitPoints.slice(0, 6), missPoints: missPoints.slice(0, 4) }
}

/** 对所有在招岗位打分，返回按分数倒序的结果 */
export function rankPositions(positions: Position[], resumeText: string, candidate?: Candidate): RuleScore[] {
  return positions
    .filter((p) => p.status === 'open')
    .map((p) => scoreAgainst(p, resumeText, candidate))
    .sort((a, b) => b.score - a.score)
}

export const RULE_MODEL_VERSION = 'rule-v1'

/** 把规则打分结果组装成 Match 记录 */
export function buildRuleMatch(
  candidateId: string,
  rs: RuleScore,
  makeId: () => string,
  nowIso: () => string
): Match {
  return {
    id: makeId(),
    candidateId,
    positionId: rs.positionId,
    score: rs.score,
    hitPoints: rs.hitPoints,
    missPoints: rs.missPoints,
    status: 'new',
    note: '采集入库时由规则初筛自动生成',
    modelVersion: RULE_MODEL_VERSION,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }
}
