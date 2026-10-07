// ============================================================
// 共享类型：web / server / extension 三端共用
// 只放类型与常量，不放运行时逻辑（保证可被任意端安全引用）
// ============================================================

// 简历正文的文本处理（章节词 / 面板按钮词 / 姓名识别）—— 见该文件的说明
export * from './resume-text.ts'

/** 简历来源平台 */
export type Platform = 'boss' | 'liepin' | 'offline' | 'other'

/** 招聘进度状态 */
export type ApplicationStatus =
  | 'new'          // 待沟通
  | 'contacted'    // 已沟通
  | 'screening'    // 筛选中
  | 'interview'    // 面试中
  | 'offer'        // 已发 Offer
  | 'rejected'     // 淘汰
  | 'hired'        // 已入职

/** 候选人（一人一档，跨平台合并后只留一条） */
export interface Candidate {
  id: string
  name: string
  gender?: 'M' | 'F' | 'unknown'
  age?: number
  city?: string
  degree?: string              // 本科 / 硕士 / 博士…
  school?: string
  major?: string
  /**
   * 学历性质。猎聘的学历行是固定格式「学校 · 专业 · 本科 · 统招」，
   * 而「统招 / 非统招」恰恰是招聘软件普遍识别不了、HR 又最在意的一项。
   * 归一化取值：统招 / 非统招 / 专升本 / 未知
   */
  educationMode?: string
  /**
   * educationMode 的原文依据（命中的那一行）。
   * 机器判断学历性质时必须可追溯 —— 判错了 HR 要能一眼看出来是原文这么写的。
   */
  educationEvidence?: string
  /** 院校层次：985 / 211 / 双一流 / ''（HR 筛简历时常用） */
  schoolTier?: string
  yearsOfExperience?: number
  currentCompany?: string
  currentTitle?: string
  expectedSalary?: string
  intention?: string           // 求职意向
  /**
   * 平台自己推荐的职位（猎聘头部有「推荐职位：项目经理」）。
   * 用途：保存时选岗位的默认值、看板上帮 HR 判断、将来做岗位归类的强特征。
   */
  recommendedPosition?: string
  phone?: string               // 脱敏存储
  email?: string
  skills: string[]
  /** skills 的来源：dictionary=用行业术语词典命中（不是模型抽取），model=大模型抽取 */
  skillsSource?: 'dictionary' | 'model'
  summary?: string             // 模型生成的摘要
  resumeText?: string          // 简历正文（文本型来源）
  /** 解析状态：raw=仅原始文本未结构化；parsed=已结构化 */
  parseState?: 'raw' | 'parsed'
  /**
   * 平台给的简历编号（猎聘正文里的 `简历编号：EF56AB78CD9000ee55ff66`）。
   * 比内容指纹硬 —— HR 找我们报问题时报这个编号比报指纹好沟通。
   */
  resumeNo?: string
  /**
   * 语言能力（英语/日语/…/普通话）。用白名单提取 ——
   * 「语言能力」这一节在猎聘页面上常常一直延到正文末尾，不过滤会把
   * 「附件简历」「0.4MB」「简历编号」这类东西当成语言收进来。
   */
  languages?: string[]
  /** 期望城市（分节解析出的「求职意向」里的城市，与 city=所在城市 区分） */
  intentionCities?: string[]
  createdAt: string            // ISO
  updatedAt: string
}

/** 候选人来源（一人可多来源，用于去重与合并） */
export interface CandidateSource {
  id: string
  candidateId: string
  platform: Platform
  platformCandidateId: string   // 平台内的候选人 ID
  /**
   * **这份简历自己的链接**（尽量取详情页，而不是列表页）。
   * 从预览面板采集时，`location.href` 是列表页 —— 所以优先用「从 DOM 里找到的详情页链接」。
   */
  resumeUrl?: string
  /** 实际发生采集的那个页面（列表页 / IM 页 / 详情页）。与 resumeUrl 区分，供溯源排查用 */
  capturedUrl?: string
  rawSnapshotKey?: string       // 对象存储里的原始快照 key
  capturedAt: string
  /**
   * 采集方式：auto = 无感自动采集；manual = 用户在页面上明确点了「保存」。
   * 不留这个字段的话，事后分不清哪些是自动采的、哪些是人手动补的 ——
   * 而这两者的可信度与合规依据完全不同。
   */
  captureMethod?: CaptureMethod
  /** 手动保存且正文未达自动阈值（放宽门槛或整页兜底）时为 true，便于事后筛出复核 */
  lowConfidence?: boolean
}

/** 岗位 + JD */
export interface Position {
  id: string
  title: string
  department?: string
  city?: string
  headcount?: number            // 招聘人数
  jdText: string
  hardRequirements: string[]    // 硬性条件
  niceToHave: string[]          // 加分项
  status: 'open' | 'paused' | 'closed'
  createdAt: string
}

/** 岗位归属是谁定的 */
export type MatchAssignedBy = 'rule' | 'manual' | 'pick-from-recommend' | 'model'

/** 匹配结果（候选人 × 岗位），同时承载该组合下的推进进度 */
export interface Match {
  id: string
  candidateId: string
  positionId: string
  score: number                 // 0–100
  hitPoints: string[]           // 命中点
  missPoints: string[]          // 缺失点
  status: ApplicationStatus     // 该候选人在该岗位下的推进进度
  owner?: string                // 跟进人
  note?: string                 // 备注
  modelVersion: string
  /**
   * 这个岗位归属是「谁定的」——
   * rule=采集时规则初筛自动挂的 / manual=用户在页面上手动选的 /
   * pick-from-recommend=用了平台推荐的职位 / model=大模型判定。
   * 有了它，HR 才能区分「这是机器猜的」还是「这是我指定的」。
   */
  assignedBy?: MatchAssignedBy
  createdAt: string
  updatedAt: string
}

/** 候选人列表行（candidate 与「主岗位匹配」的合并视图） */
export interface CandidateRow {
  candidate: Candidate
  positionId?: string
  positionTitle?: string
  score?: number
  status?: ApplicationStatus
  hitPoints: string[]
  missPoints: string[]
  platform?: Platform
  resumeUrl?: string
  capturedAt?: string
  matchCount: number            // 该候选人关联的岗位数
}

/** 候选人详情 */
export interface CandidateDetail {
  candidate: Candidate
  matches: Array<Match & { positionTitle: string }>
  sources: CandidateSource[]
}

/** 库内统计 */
export interface Stats {
  candidateCount: number
  positionCount: number
  matchCount: number
  avgScore: number
  newToday: number
  /** 今日采集进来的份数（按 sources.capturedAt 算，比 newToday 更贴近「扩展刚推了几份」） */
  capturedToday: number
  /** 还没有任何岗位匹配的候选人数（新采集、尚未归属岗位） */
  unmatchedCount: number
  /** 按采集方式拆分：自动采集 / 手动保存 各多少份（手动的是人工兜底补进来的，值得单独看） */
  capturedByMethod: { auto: number; manual: number }
  byStatus: Record<ApplicationStatus, number>
  byPlatform: Array<{ platform: Platform; count: number }>
  topPositions: Array<{ positionId: string; title: string; count: number; avgScore: number }>
}

/** 检索/筛选参数 */
export interface CandidateQuery {
  q?: string
  positionId?: string
  platform?: Platform
  status?: ApplicationStatus
  minScore?: number
  /** recent = 按最近采集时间倒序（新采集的排最前，不受「无匹配无分数」影响） */
  sort?: 'score' | 'updated' | 'name' | 'recent'
  /** true = 只看还没有岗位匹配的候选人 */
  unmatched?: boolean

  // ---- 字段级筛选 ----
  // 这些都是「简历里已经抽出来」的结构化字段，HR 逐条翻简历时最常用的筛法。
  // 一律**精确匹配**（值来自 /api/candidates/facets 的下拉），不做模糊匹配 ——
  // 模糊匹配会让「本科」命中「本科在读」这类不在预期内的东西。
  /** 所在城市（如 深圳 / 盐城） */
  city?: string
  /** 学历层次：大专 / 本科 / 硕士 / 博士 */
  degree?: string
  /** 学历性质：统招 / 非统招 / 专升本 / 未知 —— 招聘软件普遍识别不了，HR 最在意的一项 */
  educationMode?: string
  /** 院校层次：985 / 211 / 双一流 */
  schoolTier?: string
  /** 年龄区间（闭区间，只给一端就是开区间） */
  minAge?: number
  maxAge?: number
  /** 工作年限区间（闭区间） */
  minYears?: number
  maxYears?: number
  /** 语言能力：命中 languages 里任意一项即可（英语 / 日语 / 普通话…） */
  language?: string
  /** 采集方式：auto=扩展自动采的 / manual=人手动点保存的 */
  captureMethod?: CaptureMethod
  /** 最近 N 天内采集的（1 / 7 / 30） */
  capturedWithinDays?: number
  /** true = 只看有联系方式的（手机或邮箱任一） */
  hasContact?: boolean

  limit?: number
  offset?: number
}

/** 筛选下拉里的一个可选值 + 它在当前数据里出现的次数 */
export interface FacetValue {
  value: string
  count: number
}

/**
 * 筛选面板的可选值。
 *
 * 为什么要从数据里统计而不是写死：城市、语言这类值的拼写没法猜
 * （「盐城」在不在 CITY_LIST 里曾经就是个 bug），下拉里直接给出
 * 数据里真实存在的值 + 人数，用户不用试错。
 */
export interface CandidateFacets {
  cities: FacetValue[]
  degrees: FacetValue[]
  educationModes: FacetValue[]
  schoolTiers: FacetValue[]
  languages: FacetValue[]
}

/** 数据版本（看板自动刷新用：任何写操作都会让 revision 变大） */
export interface RevisionInfo {
  revision: number
  updatedAt: string
}

/** 分页结果 */
export interface Paged<T> {
  items: T[]
  total: number
  offset: number
  limit: number
}

// ------------------------------------------------------------
// 岗位漏斗（#/pipeline）
// ------------------------------------------------------------

/** 漏斗里的一格：某进度状态下的人数 */
export interface PipelineStage {
  status: ApplicationStatus
  count: number
}

/** 单个岗位的漏斗行 */
export interface PipelineRow {
  positionId: string
  title: string
  city?: string
  department?: string
  headcount?: number
  positionStatus: Position['status']
  total: number                 // 该岗位关联的候选人数
  avgScore: number
  strongCount: number           // ≥85 分（强推）
  stages: PipelineStage[]
}

/** 岗位漏斗看板数据 */
export interface PipelineData {
  positions: PipelineRow[]
  totals: PipelineStage[]       // 全库合计
  totalCandidates: number
}

// ------------------------------------------------------------
// 每日简报（#/daily）
// ------------------------------------------------------------

/** 简报里的一条候选人摘要 */
export interface BriefCandidate {
  candidateId: string
  name: string
  positionId: string
  positionTitle: string
  score: number
  status: ApplicationStatus
  platform?: Platform
}

/** 需要跟进的候选人 */
export interface FollowUp extends BriefCandidate {
  daysSinceUpdate: number
  reason: string
  priority: PriorityLevel
}

/** 优先级 */
export type PriorityLevel = 'high' | 'mid' | 'low'

/** 每日简报 */
export interface DailyReport {
  date: string                  // YYYY-MM-DD
  headline: string              // 一句话总结
  newToday: number
  newCandidates: BriefCandidate[]
  recommended: BriefCandidate[] // 高分但还没推进的，今天优先联系
  followUps: FollowUp[]         // 超时未动的，该催了
  byPosition: Array<{
    positionId: string
    title: string
    count: number
    avgScore: number
    strongCount: number
    interviewCount: number
    offerCount: number
  }>
}

// ------------------------------------------------------------
// 人才地图（#/talentmap）
// ------------------------------------------------------------

/** 分布项（城市 / 公司 / 院校 / 技能…） */
export interface DistItem {
  name: string
  count: number
}

/** 人才地图聚合数据 */
export interface TalentMapData {
  byCity: DistItem[]
  byCompany: DistItem[]
  bySchool: DistItem[]
  byDegree: DistItem[]
  bySkill: DistItem[]
  byExperience: DistItem[]
  /** 岗位 × 技能矩阵：每个岗位候选人最集中的技能 */
  positionSkills: Array<{ positionId: string; title: string; skills: DistItem[] }>
  coverage: {
    cityCount: number
    companyCount: number
    schoolCount: number
  }
}

// ------------------------------------------------------------
// 待办中心（#/todos）
// ------------------------------------------------------------

/** 一条待办 */
export interface TodoItem {
  id: string
  candidateId: string
  candidateName: string
  positionId: string
  positionTitle: string
  score: number
  status: ApplicationStatus
  priority: PriorityLevel
  reason: string
  daysSinceUpdate: number
}

export interface TodoData {
  items: TodoItem[]
  counts: Record<PriorityLevel, number>
  updatedAt: string
}

// ------------------------------------------------------------
// 智能问答（#/qa）
// ------------------------------------------------------------

/** 问答结果 */
export interface AskAnswer {
  question: string
  understood: boolean           // 是否解析出了有效条件
  filters: CandidateQuery
  filterLabels: string[]        // 解析出的条件（给人看）
  answer: string                // 自然语言结论
  total: number
  candidates: CandidateRow[]
  suggestions: string[]         // 猜你想问
  engine: string                // 当前引擎版本，接大模型后变为 llm-*
}

/** 扩展 → 后端 的上报载荷 */
export interface CapturePayload {
  platform: Platform
  platformCandidateId: string
  /**
   * **这份简历自己的链接**（优先详情页）。
   * 从预览面板采集时 `location.href` 只是列表页，所以采集端会去 DOM 里找详情页链接。
   */
  resumeUrl: string
  /** 实际发生采集的页面（列表页 / IM 页 / 详情页）—— 与 resumeUrl 区分，排查用 */
  capturedUrl?: string
  rawText: string               // 文本型简历的正文
  screenshotBase64?: string     // 图片型简历（canvas 渲染）的截图
  capturedAt: string
  /**
   * 由谁触发。缺省视为 'auto'（兼容旧版扩展）。
   * 手动保存时后端会额外记录，并可绕过「本会话已采过」的闸门。
   */
  source?: CaptureMethod
  /** 手动保存但未达自动阈值（放宽门槛或整页兜底）→ 正文可能不完整，标记出来别当高质量数据 */
  lowConfidence?: boolean
  /**
   * 保存时用户选定的岗位。
   * ⚠️ 它必须跟着 payload 一起进本地队列（断网时先排队、恢复后补传），
   * 否则「后端没起 → 先排队 → 之后补传」这条路径会把选岗信息丢掉。
   */
  positionId?: string
}
/** 岗位新建 / 编辑入参 */
export interface PositionInput {
  title: string
  department?: string
  city?: string
  headcount?: number
  status?: Position['status']
  jdText: string
  hardRequirements?: string[]
  niceToHave?: string[]
}

/** 采集方式 */
export type CaptureMethod = 'auto' | 'manual'

/** 采集上报的返回结果 */
export interface CaptureResult {
  received: boolean
  candidateId: string
  duplicated: boolean           // true = 该来源已采集过
  action: 'created' | 'updated'
  /** 入库时挂上的岗位（没有在招岗位时为 null，候选人会进入「待匹配」） */
  autoMatched?: { positionId: string; score: number } | null
  captureMethod?: CaptureMethod
  /** 这次归属是用户选的还是规则挂的 */
  assignedBy?: MatchAssignedBy
  /**
   * 规则原本推荐谁。方案 C 用：用户选岗后默认只留他选的，
   * 但要如实告诉他「规则原本推荐 X（N 分）」，并允许一键也挂上。
   */
  ruleSuggested?: { positionId: string; title: string; score: number } | null
  /**
   * 命中「不再采集」名单：这位候选人被用户删过且设为不再采集。
   * 直接忽略，**不建档、不排队重试** —— 否则「删了又自己回来」是必然发生的困惑。
   */
  ignored?: boolean
}

/** 「不再采集」名单里的一条（用户删除简历时可选加入） */
export interface IgnoredCandidate {
  id: string
  platform: Platform
  platformCandidateId: string
  /** 删除当时的姓名 —— 纯粹为了界面好认 */
  name: string
  resumeUrl?: string
  ignoredAt: string
}

/** 删除候选人的结果 */
export interface DeleteResult {
  deleted: boolean
  /** 是否同时进了「不再采集」名单 */
  forgot: boolean
  reason?: string
  /** 这次删掉了几条来源 / 几条岗位匹配（给界面显示，让人知道删了什么） */
  removedSources?: number
  removedMatches?: number
}

// ------------------------------------------------------------
// 采集开关与手动保存（扩展侧）
// ------------------------------------------------------------

/**
 * 采集模式。用一个枚举而不是两个布尔开关 ——
 * 「自动采集」和「保存前询问」做成两个独立开关会产生 `两个都开` 这种
 * 语义冲突的非法组合，一个枚举天然排除了这种状态。
 */
export type CaptureMode =
  | 'auto'      // 识别到就静默入库
  | 'off'       // 完全不采集（页面上零打扰，手动保存仍可用）
  | 'confirm'   // 识别到先在页面上问一下，不点不存（默认）

/** 扩展设置（存 chrome.storage.local 的 capture_settings） */
export interface CaptureSettings {
  mode: CaptureMode
  /** auto 模式下是否在页面上留一个收起的状态小圆点 */
  showStatusChip: boolean
  /** 页内卡片被拖到哪儿了（记住位置） */
  cardPos?: { right: number; bottom: number }
  /** 「本页都不再问」：站点路径 → 过期时间戳（毫秒）。见过期即自动恢复，不会永久静默 */
  pausedPaths: Record<string, number>
  /** 列表页（如猎聘 /recommend 人才推荐）遇到时怎么办 */
  listPagePolicy: 'skip' | 'manual' | 'normal'
  /**
   * 上次保存时选的岗位。
   * 同一批简历往往属于同一个岗位，每次都要重选会很烦 ——
   * 所以记住上次的选择，卡片默认就选中它。
   */
  lastPositionId?: string
}

/**
 * 默认值。mode 特意选 'confirm' 而不是 'auto'：
 * 简历是个人信息，默认「每一份都由人点头才入库」，比默认无感采集更稳妥。
 * 想要无感的人可以在 popup 里一步切到「自动」。
 */
export const DEFAULT_CAPTURE_SETTINGS: CaptureSettings = {
  mode: 'confirm',
  showStatusChip: true,
  pausedPaths: {},
  listPagePolicy: 'manual',
}

export const CAPTURE_MODE_LABEL: Record<CaptureMode, string> = {
  auto: '自动',
  confirm: '保存前询问',
  off: '关闭',
}

/** content → background 的采集应答（手动保存必须给用户真实回执，不能发射后不管） */
export interface CaptureAck {
  /** 是否已被接受（入队即算接受） */
  saved: boolean
  /** 已进入本地队列（后端没起时也是 true，等恢复后补传） */
  queued: boolean
  candidateId?: string
  duplicated?: boolean
  method: CaptureMethod
  reason?: 'disabled' | 'needs-confirm' | 'already-seen' | 'ignored'
  /** 实际挂上的岗位（用户选的，或规则挂的） */
  matched?: { positionId: string; title: string; score: number; assignedBy: MatchAssignedBy } | null
  /** 规则原本推荐谁 —— 用户选岗时用来提示「规则原本推荐 X」并支持一键也挂上 */
  ruleSuggested?: { positionId: string; title: string; score: number } | null
}

/** 一次采集决策的留痕（popup 的「最近决策」列表用，回答「我刚才到底存没存」） */
export interface CaptureLogEntry {
  at: string
  platform: Platform
  platformCandidateId: string
  name: string
  chars: number
  action: 'saved' | 'duplicated' | 'queued' | 'skipped' | 'rejected'
  method: CaptureMethod
  reason?: string
}

/** 用户对某一份简历的「跳过」范围 */
export type SkipScope = 'once' | 'path'

/** 扩展 → 后端 的统一响应 */
export interface ApiResult<T = unknown> {
  ok: boolean
  data?: T
  error?: string
}

// ------------------------------------------------------------
// 常量与标签
// ------------------------------------------------------------

export const PLATFORM_LABEL: Record<Platform, string> = {
  boss: 'BOSS直聘',
  liepin: '猎聘',
  offline: '离线简历',
  other: '其他',
}

export const STATUS_LABEL: Record<ApplicationStatus, string> = {
  new: '待沟通',
  contacted: '已沟通',
  screening: '筛选中',
  interview: '面试中',
  offer: '已发 Offer',
  rejected: '淘汰',
  hired: '已入职',
}

/** 进度推进的先后顺序，用于漏斗排序 */
export const STATUS_ORDER: ApplicationStatus[] = [
  'new',
  'contacted',
  'screening',
  'interview',
  'offer',
  'hired',
  'rejected',
]

/** 各进度状态在界面上的配色（浅色主题） */
export const STATUS_COLOR: Record<ApplicationStatus, { bg: string; fg: string }> = {
  new: { bg: '#eef1fd', fg: '#3b5bdb' },
  contacted: { bg: '#e8f4fd', fg: '#1c7ed6' },
  screening: { bg: '#fff4e6', fg: '#e8590c' },
  interview: { bg: '#f3e8ff', fg: '#7048e8' },
  offer: { bg: '#e6fcf5', fg: '#0ca678' },
  hired: { bg: '#ebfbee', fg: '#2b8a3e' },
  rejected: { bg: '#f1f3f5', fg: '#868e96' },
}
