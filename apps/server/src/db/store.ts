// ============================================================
// 数据层：本地文件库（JsonStore）
// ------------------------------------------------------------
// 设计原则：
//   1. 仓储与存储介质解耦 —— 上层只依赖下面这组方法，将来换成云数据库
//      （cloud-service / Postgres）只需新增一个同接口的实现，业务代码不动。
//   2. 落盘在「数据目录」而非源码仓库 —— 数据是运行时产物，不入 git。
//   3. 原子写盘 —— 先写 .tmp 再 rename，避免掉电/中断产生半个文件。
//
// 数据目录解析优先级：
//   a) 环境变量 DATA_DIR（部署时显式指定）
//   b) 启动目录向上逐级查找已存在的 招聘agent-data/
//   c) path.resolve(__dirname, '../../招聘agent-data')（产物运行形态：
//      招聘agent-build/server/index.js → 招聘agent-build/../招聘agent-data）
// ============================================================
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type {
  ApplicationStatus,
  AskAnswer,
  BriefCandidate,
  Candidate,
  CandidateDetail,
  CandidateQuery,
  CandidateRow,
  CandidateSource,
  CaptureMethod,
  CapturePayload,
  CaptureResult,
  DailyReport,
  DeleteResult,
  DistItem,
  FollowUp,
  IgnoredCandidate,
  Match,
  MatchAssignedBy,
  Paged,
  PipelineData,
  PipelineRow,
  Platform,
  Position,
  PositionInput,
  PriorityLevel,
  RevisionInfo,
  Stats,
  TalentMapData,
  TodoData,
} from '@ria/shared'
import {
  PLATFORM_LABEL,
  STATUS_LABEL,
  STATUS_ORDER,
  extractResumeNo,
  isVolatileLine,
  parseResumeSections,
  parseResumeText,
  stripResumeChrome,
} from '@ria/shared'
import { buildRuleMatch, rankPositions, scoreAgainst } from './match-rule.ts'
import { buildSeedDatabase, type SeedDatabase } from './seed-data.ts'

/** 表名 → 文件名（与未来云端表名一一对应） */
const TABLES = ['candidates', 'positions', 'matches', 'sources'] as const
type TableName = (typeof TABLES)[number]

const DATA_DIR_NAME = '招聘agent-data'

/**
 * 解析数据目录。返回绝对路径（目录可能尚不存在，调用方负责创建）。
 *
 * @param startDir 启动目录，用于「向上查找 / 产物形态」两种兜底
 * @param baseDir  DATA_DIR 为相对路径时的基准目录。
 *                 约定：.env 里的相对路径一律相对「仓库根」解释，
 *                 而不是相对进程 cwd —— 否则 `npm run dev:server`（cwd=apps/server）
 *                 与 `npm run start`（cwd=仓库根）会落到两个不同的地方。
 */
export function resolveDataDir(startDir: string, baseDir?: string): string {
  // a) 显式配置优先
  const env = process.env.DATA_DIR
  if (env && env.trim()) {
    const value = env.trim()
    return path.isAbsolute(value) ? value : path.resolve(baseDir ?? process.cwd(), value)
  }

  // b) 向上查找已存在的数据目录（兼容「源码直接跑 TS」的形态）
  let dir = startDir
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, DATA_DIR_NAME)
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  // c) 产物运行形态：.../招聘agent-build/server → .../招聘agent-data
  return path.resolve(startDir, '..', '..', DATA_DIR_NAME)
}

function nowIso(): string {
  return new Date().toISOString()
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`
}

/** 保留一位小数 */
function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/** 取字符 2-gram（用于把口语化提问对上岗位标题） */
function bigrams(s: string): string[] {
  const chars = Array.from(s.replace(/\s/g, ''))
  const out: string[] = []
  for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1])
  return out
}

/** 把分布数据按出现次数排序（次数相同按名称） */
function toDist(values: Array<string | undefined>): DistItem[] {
  const m = new Map<string, number>()
  for (const v of values) {
    const k = (v ?? '').trim()
    if (!k) continue
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  return [...m.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

const PRIORITY_WEIGHT: Record<PriorityLevel, number> = { high: 0, mid: 1, low: 2 }

/** 问答里可识别的城市 */
const ASK_CITIES = [
  '深圳', '上海', '北京', '杭州', '广州', '苏州', '成都',
  '武汉', '南京', '西安', '东莞', '无锡', '合肥', '长沙',
]

/** 问答里可识别的进度词 */
const ASK_STATUS_WORDS: Array<[string, ApplicationStatus]> = [
  ['待沟通', 'new'], ['未沟通', 'new'], ['没沟通', 'new'], ['没联系', 'new'], ['还没联系', 'new'],
  ['已沟通', 'contacted'], ['联系过', 'contacted'],
  ['筛选', 'screening'],
  ['面试', 'interview'],
  ['offer', 'offer'], ['Offer', 'offer'], ['录用', 'offer'],
  ['淘汰', 'rejected'], ['被拒', 'rejected'], ['不合适', 'rejected'],
  ['入职', 'hired'],
]

/** 问答里可识别的平台词 */
const ASK_PLATFORM_WORDS: Array<[string, Platform]> = [
  ['boss', 'boss'], ['BOSS', 'boss'], ['直聘', 'boss'],
  ['猎聘', 'liepin'],
  ['离线', 'offline'],
]

/** 本地日期（YYYY-MM-DD），用于「今日新增」统计 */
function localDate(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 候选人全文检索用的归一化文本。
 * 不引入搜索引擎：库规模在数万条以内时，子串匹配足够快且零依赖。
 * 上云后换成 Postgres 的 tsvector / 简易倒排。
 */
function searchTextOf(c: Candidate): string {
  return [
    c.name,
    c.currentCompany,
    c.currentTitle,
    c.school,
    c.major,
    c.city,
    c.degree,
    // 「统招」这类学历性质要能被搜到 —— HR 常直接搜「统招」
    c.educationMode,
    c.educationEvidence,
    c.schoolTier,
    c.recommendedPosition,
    c.expectedSalary,
    c.intention,
    c.languages?.join(' '),
    c.intentionCities?.join(' '),
    c.summary,
    c.skills.join(' '),
    c.resumeText?.slice(0, 4000),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

/**
 * 导出 Excel 用的一行。
 * 字段名与 `apps/server/src/export-build.ts` 的 `ExportRow` **刻意保持一致** ——
 * 靠结构化类型直接传过去，避免 db 层 import 渲染层。
 */
export interface CandidateExportRow {
  name?: string
  gender?: string
  age?: number
  degree?: string
  educationMode?: string
  school?: string
  schoolTier?: string
  major?: string
  yearsOfExperience?: number
  /** 已经拼好的「经历」字符串 */
  experience?: string
  expectedSalary?: string
  city?: string
  languages?: string[]
  currentCompany?: string
  currentTitle?: string
  intentionPositions?: string[]
  intentionCities?: string[]
  skills?: string[]
  matchPositionTitle?: string
  matchScore?: number
  platform?: string
  capturedAt?: string
  resumeNo?: string
  resumeUrl?: string
}

/**
 * 把一段原文收拾成能放进单元格的短摘录。
 *
 * 结构化的「工作经历」认不出来时用它兜底。三件事：
 *  ① 去掉行首的项目符号编号（`1. ` / `•` / `（2）`）—— 单元格里带着编号很难看
 *  ② 优先在第一个句读处收尾（`。` / `；`），而不是从句子中间切断
 *  ③ 实在没有句读时才硬截，并补省略号（让人知道这句话没说完）
 */
function tidyExcerpt(line: string, max = 80): string {
  const t = line
    .trim()
    .replace(/^(\d+\s*[.、)）]|[•·\-*]|\(\d+\)|（\d+）)\s*/, '')
    .trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max)
  const stop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('；'), cut.lastIndexOf(';'))
  if (stop >= 20) return cut.slice(0, stop + 1)
  return `${cut}…`
}

/**
 * 数据目录写不进去时，给出一段**能照着做**的中文提示。
 *
 * 为什么值得单独写这个：便携包的目标用户是「在另一台电脑上双击一下就要用的人」，
 * 真实第一次踩到的坑就是 `EPERM: operation not permitted, open 'D:\...\data\candidates.json.tmp'` ——
 * 原始堆栈对这种情况毫无帮助，用户只能来问「启动报错看看」。
 * 把「最可能的四个原因 + 每个原因的解法」直接打出来，比任何日志都好用。
 */
function writeFailureHint(file: string, err: NodeJS.ErrnoException): Error {
  const code = err.code ?? '未知错误'
  const dir = path.dirname(file)
  const lines = [
    `无法写入数据目录（${code}）`,
    `  目录：${dir}`,
    `  文件：${file}`,
    '',
    '这不是程序缺陷，通常是下面四种情况之一 —— 按顺序试：',
    '',
    '  1) 文件夹带「只读」属性（从压缩包解压出来常会这样）',
    '     · 右键该文件夹 → 属性 → 取消勾选「只读」→ 确定时选「应用到子文件夹」',
    `     · 或者在本文件夹开命令行执行：  attrib -R "${dir}\\*" /S /D`,
    '',
    '  2) 杀毒软件 / Windows「受控文件夹访问」拦住了写入',
    '     · 把该文件夹加入杀毒软件白名单；',
    '     · 或「Windows 安全中心 → 病毒和威胁防护 → 勒索软件防护 → 受控文件夹访问」里放行 node.exe',
    '',
    '  3) 已经有一个实例在运行、占着数据文件（重复双击了启动器）',
    '     · 先双击「停止看板.bat」，再重新启动',
    '',
    '  4) 所在磁盘不允许写入（只读介质 / U 盘写保护 / 公司策略限制）',
    '     · 把整个文件夹移到   C:\\Users\\<你的用户名>\\   下面再启动',
    '     · 不要放在 C:\\Program Files 这类受保护目录',
  ]
  return new Error(lines.join('\n'))
}

export class JsonStore {
  readonly dataDir: string
  private db: SeedDatabase
  private searchCache = new Map<string, string>()
  private dirty = false

  /**
   * 「不再采集」名单。
   *
   * 为什么**不放进 `this.db`**：它不是种子数据库的一部分（示例数据里没有这个概念），
   * 而是纯用户状态。单独一个 `ignored.json` 就不用动 `SeedDatabase` 类型、
   * 也不会被「重置为示例数据」冲掉 —— 那正是我们想要的：重置数据不该让
   * 「别再把这个人采回来」的意愿失效。
   */
  private ignored: IgnoredCandidate[] = []

  /**
   * 数据版本号：任何一次落盘都会 +1。
   * 看板靠轮询 /api/revision 感知「扩展刚推了新简历」，从而自动刷新 ——
   * 比让前端每隔几秒全量重拉一次便宜得多（这个接口不碰数据、不算派生视图）。
   */
  private revision = 0
  private revisionAt = new Date().toISOString()

  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.db = this.load()
    this.ignored = this.loadIgnored()
  }

  // ---------------- 「不再采集」名单 ----------------

  private ignoredFile(): string {
    return path.join(this.dataDir, 'ignored.json')
  }

  private loadIgnored(): IgnoredCandidate[] {
    const file = this.ignoredFile()
    if (!fs.existsSync(file)) return []
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      return Array.isArray(parsed) ? (parsed as IgnoredCandidate[]) : []
    } catch (err) {
      console.error('[store] 读取 ignored.json 失败，已按空名单处理：', (err as Error).message)
      return []
    }
  }

  private persistIgnored(): void {
    const target = this.ignoredFile()
    const tmp = `${target}.${process.pid}.tmp`
    try {
      fs.mkdirSync(this.dataDir, { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify(this.ignored, null, 2), 'utf8')
      fs.renameSync(tmp, target)
    } catch (err) {
      try {
        fs.unlinkSync(tmp)
      } catch {
        /* ignore */
      }
      throw writeFailureHint(tmp, err as NodeJS.ErrnoException)
    }
  }

  /** 这个人是否在「不再采集」名单里 */
  isIgnored(platform: string, platformCandidateId: string): boolean {
    return this.ignored.some(
      (i) => i.platform === platform && i.platformCandidateId === platformCandidateId
    )
  }

  listIgnored(): IgnoredCandidate[] {
    // 最近加入的排前面
    return [...this.ignored].sort((a, b) => (a.ignoredAt < b.ignoredAt ? 1 : -1))
  }

  /** 移出名单（恢复采集） */
  removeIgnored(id: string): boolean {
    const before = this.ignored.length
    this.ignored = this.ignored.filter((i) => i.id !== id)
    if (this.ignored.length === before) return false
    this.persistIgnored()
    return true
  }

  private addIgnored(candidate: Candidate, source?: CandidateSource): boolean {
    if (this.isIgnored(source?.platform ?? 'liepin', source?.platformCandidateId ?? candidate.id)) {
      return false
    }
    const platforms = this.db.sources.filter((s) => s.candidateId === candidate.id)
    const added: IgnoredCandidate[] = []
    const related = source ? [source] : platforms
    for (const s of related) {
      if (this.isIgnored(s.platform, s.platformCandidateId)) continue
      if (added.some((a) => a.platform === s.platform && a.platformCandidateId === s.platformCandidateId)) {
        continue
      }
      added.push({
        id: newId('ign'),
        platform: s.platform,
        platformCandidateId: s.platformCandidateId,
        name: candidate.name,
        resumeUrl: s.resumeUrl,
        ignoredAt: nowIso(),
      })
    }
    if (added.length === 0) return false
    this.ignored.push(...added)
    this.persistIgnored()
    return true
  }

  // ---------------- 删除候选人 ----------------

  /**
   * 删除一位候选人（级联删掉他的全部来源与岗位匹配）。
   *
   * 两件必须做的事：
   *  ① **删前归档**到 `_deleted/<时间戳>/<候选人id>.json` —— 和 `_backup/` 一个思路，
   *     误删能手工捞回来，而不是彻底没了。
   *  ② `forget` 时把 `(平台, 平台内ID)` 加进「不再采集」名单 —— 否则他下次被
   *     重新打开时扩展会再采一次，「删了又回来」是必然会发生的困惑。
   */
  deleteCandidate(id: string, forget = false): DeleteResult {
    const idx = this.db.candidates.findIndex((c) => c.id === id)
    if (idx < 0) return { deleted: false, forgot: false, reason: '候选人不存在' }
    const candidate = this.db.candidates[idx]
    const srcs = this.db.sources.filter((s) => s.candidateId === id)
    const mts = this.db.matches.filter((m) => m.candidateId === id)

    this.archiveDeleted({
      candidate,
      sources: srcs,
      matches: mts,
      deletedAt: nowIso(),
    })

    const forgot = forget ? this.addIgnored(candidate, srcs[0] as CandidateSource | undefined) : false

    this.db.candidates.splice(idx, 1)
    this.db.sources = this.db.sources.filter((s) => s.candidateId !== id)
    this.db.matches = this.db.matches.filter((m) => m.candidateId !== id)
    this.searchCache.delete(id)
    this.persist()

    return {
      deleted: true,
      forgot,
      removedSources: srcs.length,
      removedMatches: mts.length,
    }
  }

  /** 批量删除（界面上「删除选中」用） */
  deleteCandidates(ids: string[], forget = false): { deleted: number; forgot: number } {
    let deleted = 0
    let forgot = 0
    for (const id of ids) {
      const r = this.deleteCandidate(id, forget)
      if (r.deleted) deleted++
      if (r.forgot) forgot++
    }
    return { deleted, forgot }
  }

  // ---------------- 导出 Excel ----------------

  /**
   * 按查询条件取**全部**匹配的候选人并整理成导出行（**忽略分页**）。
   *
   * 字段名刻意与 `apps/server/src/export-build.ts` 的 `ExportRow` 对齐 ——
   * 结构化类型让路由可以直接把结果传进去，不必让 db 层反向依赖渲染层。
   */
  exportRows(
    query: CandidateQuery,
    limit = 5000
  ): { rows: CandidateExportRow[]; total: number; truncated: boolean } {
    const page = this.query({ ...query, limit, offset: 0 })
    const rows = page.items.map((r) => this.toExportRow(r))
    return { rows, total: page.total, truncated: page.total > rows.length }
  }

  private toExportRow(r: CandidateRow): CandidateExportRow {
    const c = r.candidate
    // 「经历」一列：用结构化分节拼成 `公司·职位(起止)`，多段用 `；` 连接。
    // 比往单元格里塞 6000 字原文有用得多（那样 Excel 里根本没法看）。
    const sec = parseResumeSections(c.resumeText ?? '')
    const parts = sec.experiences.slice(0, 8).map((e) => {
      const who = [e.company, e.title].filter(Boolean).join('·')
      return e.period ? `${who}(${e.period})` : who
    })
    let exp = parts.filter(Boolean).join('；')
    if (!exp) {
      // 结构化认不出来时（非结构化的「工作经历」常常只是一串编号条目），
      // 退一步给该章节的第一句 —— 空着比给一句真话更没用。
      const block = sec.blocks.find((b) => b.title === '工作经历' || b.title === '工作经验')
      const raw = (block?.lines ?? []).find((l) => l.trim().length >= 8)
      if (raw) exp = tidyExcerpt(raw)
    }

    return {
      name: c.name,
      gender: c.gender,
      age: c.age,
      degree: c.degree,
      educationMode: c.educationMode,
      school: c.school,
      schoolTier: c.schoolTier,
      major: c.major,
      yearsOfExperience: c.yearsOfExperience,
      experience: exp || undefined,
      expectedSalary: c.expectedSalary,
      city: c.city,
      languages: c.languages,
      currentCompany: c.currentCompany,
      currentTitle: c.currentTitle,
      intentionPositions: c.intention
        ? c.intention
            .split(/\s*[/·]\s*/)
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
      intentionCities: c.intentionCities,
      skills: c.skills,
      matchPositionTitle: r.positionTitle,
      matchScore: r.score,
      platform: r.platform,
      capturedAt: r.capturedAt,
      resumeNo: c.resumeNo,
      resumeUrl: r.resumeUrl,
    }
  }

  /** 把删掉的整条记录写到 `_deleted/<时间戳>/<id>.json`（可手工恢复） */
  private archiveDeleted(payload: {
    candidate: Candidate
    sources: CandidateSource[]
    matches: Match[]
    deletedAt: string
  }): void {
    try {
      const stamp = payload.deletedAt.replace(/[:.]/g, '-')
      const dir = path.join(this.dataDir, '_deleted', stamp)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, `${payload.candidate.id}.json`),
        JSON.stringify(payload, null, 2),
        'utf8'
      )
    } catch (err) {
      // 归档失败不能挡住删除本身，但必须出声 —— 否则用户以为还能恢复
      console.error(`[store] 归档已删除的候选人失败（${payload.candidate.id}）：`, (err as Error).message)
    }
  }

  /** 当前数据版本（写操作后必然变化） */
  revisionInfo(): RevisionInfo {
    return { revision: this.revision, updatedAt: this.revisionAt }
  }

  // ---------------- 读写盘 ----------------

  private fileOf(table: TableName): string {
    return path.join(this.dataDir, `${table}.json`)
  }

  private empty(): SeedDatabase {
    return { version: 1, candidates: [], positions: [], matches: [], sources: [] }
  }

  private load(): SeedDatabase {
    const db = this.empty()
    if (!fs.existsSync(this.dataDir)) return db
    for (const table of TABLES) {
      const file = this.fileOf(table)
      if (!fs.existsSync(file)) continue
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (Array.isArray(parsed)) (db as unknown as Record<TableName, unknown[]>)[table] = parsed
      } catch (err) {
        console.error(`[store] 读取 ${table}.json 失败，已按空表处理：`, (err as Error).message)
      }
    }
    return db
  }

  /** 原子写盘：tmp → rename，避免出现半个文件 */
  private persist(): void {
    this.writeTables()
    this.dirty = false
    // 落盘即视为数据变了 —— 看板轮询到新 revision 就会自己刷新
    this.revision++
    this.revisionAt = nowIso()
  }

  /**
   * 真正落盘的那一段（四个表逐个原子替换）。
   *
   * 两个刻意的设计：
   *  ① **tmp 文件名带进程号** —— 两个实例同时跑（比如重复双击了启动器）时
   *     不会去抢同一个 `candidates.json.tmp`，否则后启动的那个必然 EPERM/EBUSY。
   *  ② 写失败时**抛一段人能看懂的中文**，而不是把 `EPERM ... .tmp` 的原始堆栈
   *     丢给一个「另一台电脑上、只想双击一下就用的」用户。
   */
  private writeTables(): void {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true })
    } catch (err) {
      throw writeFailureHint(path.join(this.dataDir, 'candidates.json'), err as NodeJS.ErrnoException)
    }
    for (const table of TABLES) {
      const target = this.fileOf(table)
      const tmp = `${target}.${process.pid}.tmp`
      const payload = (this.db as unknown as Record<TableName, unknown[]>)[table]
      const json = JSON.stringify(payload, null, 2)
      try {
        fs.writeFileSync(tmp, json, 'utf8')
        fs.renameSync(tmp, target)
      } catch (err) {
        // 退一步：直接写目标文件（放弃「原子替换」这一点）。
        // 为什么值得退：有些环境（杀软的文件钩子、特殊文件系统、目标文件带只读属性）
        // 不允许 rename 覆盖已有文件，但**允许直接写** —— 实测的 EPERM 就属于这一类，
        // 而用户要的是「能用」，不是「写入过程必须原子」。
        // 只有直接写也失败，才真的报错，并且这次报的是**目标文件**的错，
        // 定位比含糊地指向 .tmp 准确得多。
        try {
          fs.writeFileSync(target, json, 'utf8')
        } catch (err2) {
          throw writeFailureHint(target, err2 as NodeJS.ErrnoException)
        } finally {
          try {
            fs.unlinkSync(tmp)
          } catch {
            /* 清理失败就算了，别盖住真正的原因 */
          }
        }
      }
    }
  }

  save(): void {
    this.persist()
  }

  /** 库是否为空（用于首次启动自动灌入示例数据） */
  isEmpty(): boolean {
    return this.db.candidates.length === 0
  }

  /** 写入示例数据（覆盖式），返回写入的候选人条数 */
  seed(): number {
    this.db = buildSeedDatabase()
    this.searchCache.clear()
    this.persist()
    return this.db.candidates.length
  }

  // ---------------- 基础查询 ----------------

  private st(c: Candidate): string {
    let cached = this.searchCache.get(c.id)
    if (cached === undefined) {
      cached = searchTextOf(c)
      this.searchCache.set(c.id, cached)
    }
    return cached
  }

  private candidateById(id: string): Candidate | undefined {
    return this.db.candidates.find((c) => c.id === id)
  }

  private matchesOfCandidate(candidateId: string): Match[] {
    return this.db.matches.filter((m) => m.candidateId === candidateId)
  }

  private sourcesOfCandidate(candidateId: string): CandidateSource[] {
    return this.db.sources.filter((s) => s.candidateId === candidateId)
  }

  private positionById(id: string): Position | undefined {
    return this.db.positions.find((p) => p.id === id)
  }

  /**
   * 选出「主岗位匹配」：指定岗位时取该岗位的匹配，否则取分数最高的一条。
   */
  private primaryMatch(candidateId: string, positionId?: string): Match | undefined {
    const list = this.matchesOfCandidate(candidateId)
    if (list.length === 0) return undefined
    if (positionId) return list.find((m) => m.positionId === positionId)
    return [...list].sort((a, b) => b.score - a.score)[0]
  }

  /** 组装列表行 */
  private toRow(c: Candidate, positionId?: string): CandidateRow {
    const match = this.primaryMatch(c.id, positionId)
    const sources = this.sourcesOfCandidate(c.id).sort((a, b) =>
      b.capturedAt.localeCompare(a.capturedAt)
    )
    const latest = sources[0]
    return {
      candidate: c,
      positionId: match?.positionId,
      positionTitle: match ? this.positionById(match.positionId)?.title : undefined,
      score: match?.score,
      status: match?.status,
      hitPoints: match?.hitPoints ?? [],
      missPoints: match?.missPoints ?? [],
      platform: latest?.platform,
      resumeUrl: latest?.resumeUrl,
      capturedAt: latest?.capturedAt,
      matchCount: this.matchesOfCandidate(c.id).length,
    }
  }

  // ---------------- 对外 API ----------------

  /** 按条件检索候选人 */
  query(q: CandidateQuery = {}): Paged<CandidateRow> {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 500)
    const offset = Math.max(q.offset ?? 0, 0)

    const terms = (q.q ?? '')
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean)

    const rows: CandidateRow[] = []

    for (const c of this.db.candidates) {
      // 关键词：所有词都必须命中（AND 语义，符合 HR 逐词收窄的习惯）
      if (terms.length > 0) {
        const hay = this.st(c)
        if (!terms.every((t) => hay.includes(t))) continue
      }

      // 来源平台
      if (q.platform) {
        const hit = this.sourcesOfCandidate(c.id).some((s) => s.platform === q.platform)
        if (!hit) continue
      }

      // 岗位
      if (q.positionId && !this.matchesOfCandidate(c.id).some((m) => m.positionId === q.positionId)) {
        continue
      }

      // 进度状态
      if (q.status) {
        const hit = this.matchesOfCandidate(c.id).some(
          (m) => m.status === q.status && (!q.positionId || m.positionId === q.positionId)
        )
        if (!hit) continue
      }

      const row = this.toRow(c, q.positionId)

      // 只看「还没归到任何岗位」的（新采集、规则匹配也没命中）——
      // 这类候选人 score 为空，默认按分数排序时会被压到列表最底，
      // 单给一个视图入口，避免刚采集进来的简历石沉大海。
      if (q.unmatched && row.matchCount > 0) continue

      // 匹配度下限
      if (q.minScore !== undefined && (row.score ?? -1) < q.minScore) continue

      rows.push(row)
    }

    // 排序
    const sort = q.sort ?? 'score'
    rows.sort((a, b) => {
      if (sort === 'name') return a.candidate.name.localeCompare(b.candidate.name, 'zh-Hans-CN')
      if (sort === 'updated') return b.candidate.updatedAt.localeCompare(a.candidate.updatedAt)
      // recent：按最近一次采集时间倒序 —— 扩展刚推的简历一定在第一屏
      if (sort === 'recent') {
        const ca = a.capturedAt ?? a.candidate.updatedAt
        const cb = b.capturedAt ?? b.candidate.updatedAt
        if (cb !== ca) return cb.localeCompare(ca)
        return b.candidate.updatedAt.localeCompare(a.candidate.updatedAt)
      }
      // score：无分数的排最后
      const sa = a.score ?? -1
      const sb = b.score ?? -1
      if (sb !== sa) return sb - sa
      return b.candidate.updatedAt.localeCompare(a.candidate.updatedAt)
    })

    return { items: rows.slice(offset, offset + limit), total: rows.length, offset, limit }
  }

  /** 候选人详情 */
  detail(id: string): CandidateDetail | undefined {
    const candidate = this.candidateById(id)
    if (!candidate) return undefined
    return {
      candidate,
      matches: this.matchesOfCandidate(id)
        .map((m) => ({ ...m, positionTitle: this.positionById(m.positionId)?.title ?? '（岗位已删除）' }))
        .sort((a, b) => b.score - a.score),
      sources: this.sourcesOfCandidate(id).sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)),
    }
  }

  listPositions(): Array<Position & { candidateCount: number }> {
    return this.db.positions
      .map((p) => ({
        ...p,
        candidateCount: this.db.matches.filter((m) => m.positionId === p.id).length,
      }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  stats(): Stats {
    const byStatus = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) as Record<
      ApplicationStatus,
      number
    >
    let scoreSum = 0
    let scoreCount = 0
    for (const m of this.db.matches) {
      byStatus[m.status] = (byStatus[m.status] ?? 0) + 1
      scoreSum += m.score
      scoreCount++
    }

    const platformCount = new Map<Platform, number>()
    const methodCount = { auto: 0, manual: 0 }
    for (const s of this.db.sources) {
      platformCount.set(s.platform, (platformCount.get(s.platform) ?? 0) + 1)
      // 老数据没有 captureMethod，一律算作自动采集
      if (s.captureMethod === 'manual') methodCount.manual++
      else methodCount.auto++
    }

    const today = localDate()
    const newToday = this.db.candidates.filter(
      (c) => localDate(new Date(c.createdAt)) === today
    ).length

    // 「今天推了几份」按 sources 的采集时间算：重复采集同一人时不重复计数，
    // 但扩展每次真的抓进来一份都能看出来（newToday 只看档案创建时间，会漏掉更新型采集）
    const capturedToday = this.db.sources.filter(
      (s) => localDate(new Date(s.capturedAt)) === today
    ).length

    // 还没有任何岗位匹配的候选人 —— 新采集进来、规则匹配也没命中的那些。
    // 单独统计出来，看板上给一个可点击入口，避免它们「隐形地沉在列表底部」。
    const matchedIds = new Set(this.db.matches.map((m) => m.candidateId))
    const unmatchedCount = this.db.candidates.filter((c) => !matchedIds.has(c.id)).length

    const topPositions = this.db.positions
      .map((p) => {
        const ms = this.db.matches.filter((m) => m.positionId === p.id)
        const avg = ms.length ? ms.reduce((s, m) => s + m.score, 0) / ms.length : 0
        return {
          positionId: p.id,
          title: p.title,
          count: ms.length,
          avgScore: Math.round(avg * 10) / 10,
        }
      })
      .sort((a, b) => b.count - a.count)

    return {
      candidateCount: this.db.candidates.length,
      positionCount: this.db.positions.length,
      matchCount: this.db.matches.length,
      avgScore: scoreCount ? Math.round((scoreSum / scoreCount) * 10) / 10 : 0,
      newToday,
      capturedToday,
      unmatchedCount,
      capturedByMethod: methodCount,
      byStatus,
      byPlatform: [...platformCount.entries()].map(([platform, count]) => ({ platform, count })),
      topPositions,
    }
  }

  // ---------------- 派生视图：漏斗 / 简报 / 人才地图 / 待办 ----------------

  /** 距今天数（用于「多久没动」判断） */
  private daysSince(iso: string): number {
    const t = new Date(iso).getTime()
    if (Number.isNaN(t)) return 0
    return Math.max(0, Math.floor((Date.now() - t) / 86400000))
  }

  /** Match → 简报用的候选人摘要 */
  private toBrief(m: Match): BriefCandidate {
    const c = this.candidateById(m.candidateId)
    const latest = this.sourcesOfCandidate(m.candidateId).sort((a, b) =>
      b.capturedAt.localeCompare(a.capturedAt)
    )[0]
    return {
      candidateId: m.candidateId,
      name: c?.name ?? '未知姓名',
      positionId: m.positionId,
      positionTitle: this.positionById(m.positionId)?.title ?? '（岗位已删除）',
      score: m.score,
      status: m.status,
      platform: latest?.platform,
    }
  }

  /**
   * 需要跟进的候选人（简报与待办中心共用同一套规则）。
   * 规则偏保守：只在「确实卡住了」或「高分却没人管」时才提醒，避免变成噪音。
   */
  private buildFollowUps(limit = 8): FollowUp[] {
    const out: FollowUp[] = []

    for (const m of this.db.matches) {
      const days = this.daysSince(m.updatedAt)
      let priority: PriorityLevel | null = null
      let reason = ''

      if (m.status === 'interview' && days >= 5) {
        priority = 'high'
        reason = `面试中 ${days} 天未更新，该找面试官要反馈了`
      } else if (m.status === 'offer' && days >= 3) {
        priority = 'high'
        reason = `已发 Offer ${days} 天未更新，跟进接受意向与入职时间`
      } else if (m.status === 'new' && m.score >= 85 && days >= 2) {
        priority = 'high'
        reason = `${m.score} 分强推但 ${days} 天没联系，建议今天就触达`
      } else if (m.status === 'screening' && days >= 7) {
        priority = 'mid'
        reason = `筛选中 ${days} 天没推进，别在池子里放凉了`
      } else if (m.status === 'contacted' && days >= 7) {
        priority = 'mid'
        reason = `已沟通 ${days} 天无进展，建议二次触达`
      } else if (m.status === 'new' && days >= 5) {
        priority = 'mid'
        reason = `待沟通 ${days} 天未处理`
      } else if (m.status === 'new' && m.score >= 70 && days >= 3) {
        priority = 'low'
        reason = `${m.score} 分候选人排队中，有空可以看看`
      }

      if (!priority) continue
      out.push({ ...this.toBrief(m), daysSinceUpdate: days, reason, priority })
    }

    out.sort(
      (a, b) =>
        PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority] ||
        b.daysSinceUpdate - a.daysSinceUpdate ||
        b.score - a.score
    )
    return limit > 0 ? out.slice(0, limit) : out
  }

  /** 岗位漏斗：#/pipeline */
  pipeline(): PipelineData {
    const totals = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) as Record<
      ApplicationStatus,
      number
    >

    const rows: PipelineRow[] = this.listPositions().map((p) => {
      const ms = this.db.matches.filter((m) => m.positionId === p.id)
      const stages = STATUS_ORDER.map((s) => {
        const count = ms.filter((m) => m.status === s).length
        totals[s] += count
        return { status: s, count }
      })
      const sum = ms.reduce((n, m) => n + m.score, 0)
      return {
        positionId: p.id,
        title: p.title,
        city: p.city,
        department: p.department,
        headcount: p.headcount,
        positionStatus: p.status,
        total: ms.length,
        avgScore: ms.length ? round1(sum / ms.length) : 0,
        strongCount: ms.filter((m) => m.score >= 85).length,
        stages,
      }
    })

    return {
      positions: rows,
      totals: STATUS_ORDER.map((s) => ({ status: s, count: totals[s] })),
      totalCandidates: this.db.candidates.length,
    }
  }

  /** 每日简报：#/daily */
  dailyReport(): DailyReport {
    const today = localDate()
    const all = this.db.matches

    // 今日新增：候选人 created 落在今天，取他在各自库里分最高的一条匹配作展示
    const newCandidates: BriefCandidate[] = this.db.candidates
      .filter((c) => localDate(new Date(c.createdAt)) === today)
      .map((c) => this.matchesOfCandidate(c.id).sort((a, b) => b.score - a.score)[0])
      .filter((m): m is Match => Boolean(m))
      .map((m) => this.toBrief(m))
      .sort((a, b) => b.score - a.score)

    // 今日推荐：≥85 分且还没进入正式流程的
    const recommended = all
      .filter((m) => m.score >= 85 && (m.status === 'new' || m.status === 'contacted'))
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((m) => this.toBrief(m))

    // 待跟进：卡住不动的
    const followUps = this.buildFollowUps(8)

    const byPosition = this.listPositions()
      .map((p) => {
        const pm = all.filter((m) => m.positionId === p.id)
        const sum = pm.reduce((n, m) => n + m.score, 0)
        return {
          positionId: p.id,
          title: p.title,
          count: pm.length,
          avgScore: pm.length ? round1(sum / pm.length) : 0,
          strongCount: pm.filter((m) => m.score >= 85).length,
          interviewCount: pm.filter((m) => m.status === 'interview').length,
          offerCount: pm.filter((m) => m.status === 'offer' || m.status === 'hired').length,
        }
      })
      .filter((x) => x.count > 0)

    const bits: string[] = [`今日新增 ${newCandidates.length} 份简历`]
    if (recommended.length) bits.push(`${recommended.length} 位高分候选人等你去联系`)
    if (followUps.length) bits.push(`${followUps.length} 位卡住需要跟进`)
    const best = [...byPosition].sort((a, b) => b.offerCount * 100 + b.interviewCount - (a.offerCount * 100 + a.interviewCount))[0]
    if (best && (best.interviewCount || best.offerCount)) {
      bits.push(`推进最顺的是「${best.title}」（面试中 ${best.interviewCount}、Offer ${best.offerCount}）`)
    }

    return {
      date: today,
      headline: `${bits.join('；')}。`,
      newToday: newCandidates.length,
      newCandidates,
      recommended,
      followUps,
      byPosition,
    }
  }

  /** 人才地图：#/talentmap */
  talentMap(): TalentMapData {
    const cs = this.db.candidates

    const byExperience = (() => {
      const buckets = ['3 年以下', '3–5 年', '5–8 年', '8 年以上']
      const counts = [0, 0, 0, 0]
      for (const c of cs) {
        const y = c.yearsOfExperience
        if (y === undefined) continue
        if (y < 3) counts[0]++
        else if (y < 5) counts[1]++
        else if (y < 8) counts[2]++
        else counts[3]++
      }
      return buckets.map((name, i) => ({ name, count: counts[i] }))
    })()

    const skillsOfPosition = (positionId: string) => {
      const ids = this.db.matches.filter((m) => m.positionId === positionId).map((m) => m.candidateId)
      return toDist(ids.flatMap((id) => this.candidateById(id)?.skills ?? [])).slice(0, 8)
    }

    const byCity = toDist(cs.map((c) => c.city))
    const byCompany = toDist(cs.map((c) => c.currentCompany))
    const bySchool = toDist(cs.map((c) => c.school))

    return {
      byCity,
      byCompany,
      bySchool,
      byDegree: toDist(cs.map((c) => c.degree)),
      bySkill: toDist(cs.flatMap((c) => c.skills)),
      byExperience,
      positionSkills: this.listPositions()
        .map((p) => ({
          positionId: p.id,
          title: p.title,
          skills: skillsOfPosition(p.id),
        }))
        .filter((x) => x.skills.length > 0),
      coverage: {
        cityCount: byCity.length,
        companyCount: byCompany.length,
        schoolCount: bySchool.length,
      },
    }
  }

  /** 待办中心：#/todos */
  todos(): TodoData {
    const items = this.buildFollowUps(0).map((f) => ({
      id: `todo_${f.candidateId}_${f.positionId}`,
      candidateId: f.candidateId,
      candidateName: f.name,
      positionId: f.positionId,
      positionTitle: f.positionTitle,
      score: f.score,
      status: f.status,
      priority: f.priority,
      reason: f.reason,
      daysSinceUpdate: f.daysSinceUpdate,
    }))

    const counts: Record<PriorityLevel, number> = { high: 0, mid: 0, low: 0 }
    for (const it of items) counts[it.priority]++

    return { items, counts, updatedAt: nowIso() }
  }

  // ---------------- 智能问答 ----------------

  /** 猜你想问 */
  private askSuggestions(): string[] {
    const out = ['匹配度最高的人有哪些？', '面试中的候选人有哪些？', '深圳有哪些 85 分以上的候选人？']
    const top = [...this.listPositions()].sort((a, b) => b.candidateCount - a.candidateCount)[0]
    if (top) out.unshift(`${top.title} 招得怎么样？`)
    return out.slice(0, 4)
  }

  /**
   * 规则版智能问答。
   * 先做意图解析（岗位 / 城市 / 学历 / 进度 / 来源 / 分数 / 排序），
   * 再走既有检索，最后用规则拼出结论。
   * 接入大模型后：解析与成文交给模型，检索仍走这里（保证结果是真实数据，不是幻觉）。
   */
  ask(question: string): AskAnswer {
    const q = (question ?? '').trim()
    const engine = 'rule-v1（规则解析 + 库内检索；接入大模型后升级为语义问答）'
    const suggestions = this.askSuggestions()
    const filters: CandidateQuery = { sort: 'score', limit: 30 }
    const labels: string[] = []

    if (!q) {
      return {
        question: q,
        understood: false,
        filters,
        filterLabels: [],
        answer: '想查什么直接说，比如「视觉算法岗 85 分以上有哪些人」。',
        total: 0,
        candidates: [],
        suggestions,
        engine,
      }
    }

    // 岗位：标题切成 2-gram 去对提问，命中 ≥2 个才认
    const positions = this.listPositions()
    let matchedPos: (typeof positions)[number] | null = null
    let bestHit = 0
    for (const p of positions) {
      let hit = 0
      for (const g of bigrams(p.title)) if (q.includes(g)) hit++
      if (hit >= 2 && hit > bestHit) {
        matchedPos = p
        bestHit = hit
      }
    }
    if (matchedPos) {
      filters.positionId = matchedPos.id
      labels.push(`岗位：${matchedPos.title}`)
    }

    // 城市 / 学历（检索层不支持，后续做二次过滤）
    const city = ASK_CITIES.find((c) => q.includes(c))
    if (city) labels.push(`城市：${city}`)
    const degree = ['博士', '硕士', '本科', '大专'].find((d) => q.includes(d))
    if (degree) labels.push(`学历：${degree}`)

    // 进度
    const statusHit = ASK_STATUS_WORDS.find(([w]) => q.includes(w))
    if (statusHit) {
      filters.status = statusHit[1]
      labels.push(`进度：${STATUS_LABEL[statusHit[1]]}`)
    }

    // 来源
    const platHit = ASK_PLATFORM_WORDS.find(([w]) => q.includes(w))
    if (platHit) {
      filters.platform = platHit[1]
      labels.push(`来源：${PLATFORM_LABEL[platHit[1]]}`)
    }

    // 分数
    const scoreNum = /(\d{2,3})\s*分/.exec(q)
    if (scoreNum && Number(scoreNum[1]) <= 100) {
      filters.minScore = Number(scoreNum[1])
      labels.push(`匹配度 ≥ ${filters.minScore} 分`)
    } else if (/强推|高分|最匹配|匹配度最高|最合适/.test(q)) {
      filters.minScore = 85
      labels.push('匹配度 ≥ 85 分（强推）')
    } else if (/可看/.test(q)) {
      filters.minScore = 70
      labels.push('匹配度 ≥ 70 分')
    }

    // 排序
    if (/最近|最新|刚采集|新采集/.test(q)) filters.sort = 'updated'

    // 什么都没识别出来 → 退化为全文检索（姓名 / 公司 / 技能都走这里）
    let understood = labels.length > 0
    if (!understood) {
      const kw = q.replace(/[？?，,。.！!、：:]/g, ' ').trim()
      if (kw) {
        filters.q = kw
        labels.push(`全文检索：${kw}`)
        understood = true
      }
    }

    // 检索（上限放宽，城市/学历在这里做二次过滤）
    const base = this.query({ ...filters, limit: 500 })
    let items = base.items
    if (city) items = items.filter((r) => (r.candidate.city ?? '').includes(city))
    if (degree) items = items.filter((r) => (r.candidate.degree ?? '').includes(degree))

    const candidates = items.slice(0, filters.limit ?? 30)

    return {
      question: q,
      understood,
      filters,
      filterLabels: labels,
      answer: this.composeAnswer(labels, items, candidates),
      total: items.length,
      candidates,
      suggestions,
      engine,
    }
  }

  /** 把检索结果写成一段人话 */
  private composeAnswer(labels: string[], all: CandidateRow[], top: CandidateRow[]): string {
    if (all.length === 0) {
      return labels.length
        ? `按条件「${labels.join(' · ')}」没有命中候选人。可以放宽条件，或换个说法再试。`
        : '没有找到相关候选人。'
    }

    const scores = all.map((r) => r.score ?? 0).filter((s) => s > 0)
    const avg = scores.length ? round1(scores.reduce((a, b) => a + b, 0) / scores.length) : 0
    const strong = all.filter((r) => (r.score ?? 0) >= 85).length

    const byStatus = new Map<ApplicationStatus, number>()
    for (const r of all) if (r.status) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1)

    const lines: string[] = []
    lines.push(
      `命中 ${all.length} 位候选人${scores.length ? `，平均 ${avg} 分` : ''}` +
        `${strong ? `，其中 ${strong} 位 ≥85 分可直接强推` : ''}。`
    )

    const statusText = STATUS_ORDER.filter((s) => byStatus.get(s))
      .map((s) => `${STATUS_LABEL[s]} ${byStatus.get(s)} 人`)
      .join('、')
    if (statusText) lines.push(`进度分布：${statusText}。`)

    const topText = top
      .slice(0, 3)
      .map((r) => {
        const parts = [`${r.candidate.name}（${r.score ?? '—'} 分`]
        if (r.positionTitle) parts.push(`，${r.positionTitle}`)
        if (r.status) parts.push(`，${STATUS_LABEL[r.status]}`)
        return `${parts.join('')}）`
      })
      .join('、')
    if (topText) lines.push(`匹配度最高的：${topText}。`)

    // 没指定岗位时，补一句岗位维度的分布，方便判断该往哪投人
    if (!labels.some((l) => l.startsWith('岗位：'))) {
      const perPos = new Map<string, { title: string; n: number; sum: number }>()
      for (const r of all) {
        if (!r.positionId || !r.positionTitle) continue
        const cur = perPos.get(r.positionId) ?? { title: r.positionTitle, n: 0, sum: 0 }
        cur.n++
        cur.sum += r.score ?? 0
        perPos.set(r.positionId, cur)
      }
      const arr = [...perPos.values()].sort((a, b) => b.n - a.n).slice(0, 3)
      if (arr.length > 1) {
        lines.push(
          `岗位分布：${arr.map((x) => `${x.title} ${x.n} 人（均 ${round1(x.sum / x.n)} 分）`).join('；')}。`
        )
      }
    }

    return lines.join('\n')
  }

  /** 更新候选人某岗位下的推进进度 */
  updateMatchStatus(candidateId: string, positionId: string, status: ApplicationStatus): Match | undefined {
    const match = this.db.matches.find(
      (m) => m.candidateId === candidateId && m.positionId === positionId
    )
    if (!match) return undefined
    match.status = status
    match.updatedAt = nowIso()
    const c = this.candidateById(candidateId)
    if (c) c.updatedAt = match.updatedAt
    this.persist()
    return match
  }

  // ---------------- 采集入库 ----------------

  /** 找到某候选人在某岗位下的匹配 */
  private matchOf(candidateId: string, positionId: string): Match | undefined {
    return this.db.matches.find((m) => m.candidateId === candidateId && m.positionId === positionId)
  }

  /**
   * 把候选人挂到指定岗位（幂等：已挂则返回现有的）。
   * 分数用该岗位的规则分算出来（即使岗位已停用也能算），
   * 这样看板排序仍然有依据；归属来源记在 assignedBy 里。
   */
  private attach(candidate: Candidate, positionId: string, assignedBy: MatchAssignedBy): Match | null {
    const pos = this.positionById(positionId)
    if (!pos) return null
    const exists = this.matchOf(candidate.id, positionId)
    if (exists) return exists

    const rs = scoreAgainst(pos, candidate.resumeText ?? '', candidate)
    const match = buildRuleMatch(candidate.id, rs, () => newId('match'), () => nowIso())
    match.assignedBy = assignedBy
    if (assignedBy === 'manual') match.note = '用户在采集时手动指定了岗位'
    this.db.matches.push(match)
    return match
  }

  /**
   * 用「平台推荐的职位」去命中用户自己的岗位。
   * 复用智能问答那套 2-gram（命中 ≥2 个才算），避免「工程师」这种通用词乱命中。
   */
  private findPositionByText(text: string): Position | undefined {
    const q = (text || '').trim()
    if (q.length < 2) return undefined
    let best: Position | undefined
    let bestHit = 0
    for (const p of this.db.positions) {
      if (p.status !== 'open') continue
      let hit = 0
      for (const g of bigrams(p.title)) if (q.includes(g)) hit++
      if (hit >= 2 && hit > bestHit) {
        best = p
        bestHit = hit
      }
    }
    return best
  }

  /**
   * 规则原本推荐谁（排除掉用户已经选的那个岗位）。
   * 方案 C 的回执要用：「已挂到你选的 X。规则原本推荐 Y（N 分），[也挂上]」
   */
  private ruleSuggestion(
    candidateId: string,
    excludePositionId?: string
  ): { positionId: string; title: string; score: number } | null {
    const c = this.candidateById(candidateId)
    if (!c) return null
    const ranked = rankPositions(this.db.positions, c.resumeText ?? '', c)
    const top = ranked.find((r) => r.positionId !== excludePositionId)
    if (!top) return null
    return {
      positionId: top.positionId,
      title: this.positionById(top.positionId)?.title ?? '',
      score: top.score,
    }
  }

  /**
   * 接收扩展上报的简历。
   * 去重键：(platform, platformCandidateId)。同一来源重复采集 → 只刷新抓取时间。
   */
  ingestCapture(payload: CapturePayload): CaptureResult {
    // ① 先查「不再采集」名单 —— 必须放在最前面。
    //    用户删掉某人并勾了「不再采集」，那么即使以后又打开他的简历，
    //    这里也要直接忽略：不建档、不更新、**不排队重试**
    //    （重试会让扩展一直以为没存成功，反而制造困惑）。
    if (this.isIgnored(payload.platform, payload.platformCandidateId)) {
      return {
        received: true,
        candidateId: '',
        duplicated: false,
        action: 'updated',
        ignored: true,
      }
    }

    const existingSource = this.db.sources.find(
      (s) => s.platform === payload.platform && s.platformCandidateId === payload.platformCandidateId
    )
    const ts = nowIso()
    const method: CaptureMethod = payload.source ?? 'auto'

    if (existingSource) {
      existingSource.capturedAt = payload.capturedAt || ts
      // 来源 URL 用「这份简历自己的链接」优先（采集端会去 DOM 里找详情页链接）；
      // 只有当前这次拿不到详情链接时才用旧值，避免把已经修好的来源又覆盖回列表页
      if (payload.resumeUrl) {
        const isDetail = /resume\/detail|[?&](resIdEncode|resumeId)=/.test(payload.resumeUrl)
        const existingIsDetail = /resume\/detail|[?&](resIdEncode|resumeId)=/.test(
          existingSource.resumeUrl ?? ''
        )
        if (isDetail || !existingIsDetail) existingSource.resumeUrl = payload.resumeUrl
      }
      if (payload.capturedUrl) existingSource.capturedUrl = payload.capturedUrl
      // 采集方式只在首次建档时定性，之后不来回翻 ——
      // 一份自动采集的简历后来又被人手动存了一次，它的「来源方式」仍应是自动，
      // 否则「手动补采了多少份」这个统计会随着重复保存而漂移。
      if (!existingSource.captureMethod) existingSource.captureMethod = method

      const c = this.candidateById(existingSource.candidateId)
      if (c) {
        c.updatedAt = ts
        if (payload.rawText) c.resumeText = payload.rawText
        if (payload.positionId) {
          // 用户这次明确选了岗位 → 补挂（幂等，重复保存不会挂两遍）
          this.attach(c, payload.positionId, 'manual')
        } else if (this.matchesOfCandidate(c.id).length === 0) {
          // 之前没挂上任何岗位（首采时正文太短 / 在招岗位都不匹配）→
          // 用这次更完整的正文补一次，否则它会一直躺在「待匹配」里
          this.autoMatch(c)
        }
        this.searchCache.delete(c.id)
      }
      this.persist()
      return {
        received: true,
        candidateId: existingSource.candidateId,
        duplicated: true,
        action: 'updated',
        captureMethod: existingSource.captureMethod ?? method,
        ruleSuggested: this.ruleSuggestion(existingSource.candidateId, payload.positionId),
      }
    }

    // ---- 首次建档：字段提取（含统招/学校/专业/技能标签等）
    const parsed = parseResumeText(payload.rawText)
    const candidate: Candidate = {
      id: newId('cand'),
      ...parsed,
      skills: parsed.skills ?? [],
      resumeText: payload.rawText,
      parseState: 'raw',
      summary: '待大模型结构化（P1）：当前为采集原文，字段由规则粗提取。',
      createdAt: ts,
      updatedAt: ts,
    }

    this.db.candidates.push(candidate)
    this.db.sources.push({
      id: newId('src'),
      candidateId: candidate.id,
      platform: payload.platform,
      platformCandidateId: payload.platformCandidateId,
      resumeUrl: payload.resumeUrl,
      // 实际发生采集的那个页面（列表页/IM 页/详情页）—— 与 resumeUrl 区分，排查用
      capturedUrl: payload.capturedUrl,
      capturedAt: payload.capturedAt || ts,
      // 缺省视为自动采集（兼容 0.4.0 之前的老扩展版本）
      captureMethod: method,
      lowConfidence: payload.lowConfidence,
    })
    this.searchCache.set(candidate.id, searchTextOf(candidate))

    // ---- 岗位归属。优先级：用户选的 > 平台推荐职位命中 > 规则分最高
    // 只挂一个：看板列表按「主岗位匹配」展示，挂一堆低分岗位只会污染岗位漏斗。
    let match: Match | null = null
    if (payload.positionId) {
      match = this.attach(candidate, payload.positionId, 'manual')
    }
    if (!match) match = this.autoMatch(candidate)

    this.persist()

    return {
      received: true,
      candidateId: candidate.id,
      duplicated: false,
      action: 'created',
      autoMatched: match ? { positionId: match.positionId, score: match.score } : null,
      captureMethod: method,
      assignedBy: match?.assignedBy,
      ruleSuggested: this.ruleSuggestion(candidate.id, payload.positionId),
    }
  }

  /**
   * 给「还没有任何岗位匹配」的候选人补一次匹配。
   *
   * 场景：新加了岗位、或者历史数据是在自动匹配上线之前采进来的 ——
   * 这些人的 score 为空，默认按匹配度排序会被压到列表最底，等于隐形。
   * 看板的「重跑匹配」按钮与维护脚本 scripts/repair-data.mjs 都会调用它。
   */
  rematchUnmatched(): { matched: number; skipped: number } {
    let matched = 0
    for (const c of this.db.candidates) {
      if (this.matchesOfCandidate(c.id).length > 0) continue
      if (this.autoMatch(c)) matched++
    }
    if (matched > 0) this.persist()
    return { matched, skipped: this.db.candidates.length - matched }
  }

  /**
   * 给候选人挂上「最合适的一个岗位」。
   *
   * 顺序很重要：
   *   ① **平台自己推荐的职位**（猎聘头部写着「推荐职位：项目经理」）——
   *      平台说的比我们猜的可信，能在用户岗位里命中就直接用；
   *   ② 退化为规则分最高者。
   * 只挂一个：看板列表按「主岗位匹配」展示，挂一堆低分岗位只会污染岗位漏斗。
   */
  private autoMatch(candidate: Candidate): Match | null {
    const byRecommend = this.findPositionByText(candidate.recommendedPosition ?? '')
    if (byRecommend) {
      const m = this.attach(candidate, byRecommend.id, 'pick-from-recommend')
      if (m) {
        if (m.note !== '用户在采集时手动指定了岗位') {
          m.note = `按平台推荐职位「${candidate.recommendedPosition}」挂靠`
        }
        return m
      }
    }
    const ranked = rankPositions(this.db.positions, candidate.resumeText ?? '', candidate)
    if (ranked.length === 0) return null
    return this.attach(candidate, ranked[0].positionId, 'rule')
  }

  // ---------------- 岗位管理 ----------------

  createPosition(input: PositionInput): Position {
    const title = (input.title || '').trim()
    if (!title) throw new Error('岗位标题不能为空')
    const pos: Position = {
      id: newId('pos'),
      title,
      department: input.department?.trim() || undefined,
      city: input.city?.trim() || undefined,
      headcount:
        typeof input.headcount === 'number' && input.headcount > 0 ? input.headcount : undefined,
      jdText: (input.jdText || '').trim(),
      hardRequirements: (input.hardRequirements ?? []).map((s) => s.trim()).filter(Boolean),
      niceToHave: (input.niceToHave ?? []).map((s) => s.trim()).filter(Boolean),
      status: input.status ?? 'open',
      createdAt: nowIso(),
    }
    this.db.positions.push(pos)
    this.persist()
    return pos
  }

  /** 编辑岗位（只覆盖传进来的字段） */
  updatePosition(id: string, patch: Partial<PositionInput>): Position | undefined {
    const pos = this.positionById(id)
    if (!pos) return undefined
    if (patch.title !== undefined) {
      const t = patch.title.trim()
      if (!t) throw new Error('岗位标题不能为空')
      pos.title = t
    }
    if (patch.department !== undefined) pos.department = patch.department.trim() || undefined
    if (patch.city !== undefined) pos.city = patch.city.trim() || undefined
    if (patch.headcount !== undefined) {
      pos.headcount = patch.headcount > 0 ? patch.headcount : undefined
    }
    if (patch.jdText !== undefined) pos.jdText = patch.jdText.trim()
    if (patch.hardRequirements !== undefined) {
      pos.hardRequirements = patch.hardRequirements.map((s) => s.trim()).filter(Boolean)
    }
    if (patch.niceToHave !== undefined) {
      pos.niceToHave = patch.niceToHave.map((s) => s.trim()).filter(Boolean)
    }
    if (patch.status !== undefined) pos.status = patch.status
    this.persist()
    return pos
  }

  matchCountOfPosition(positionId: string): number {
    return this.db.matches.filter((m) => m.positionId === positionId).length
  }

  /**
   * 删除岗位。
   *
   * ⚠️ 岗位下**还有候选人**时拒绝删除 —— 删了会让那些 matches 变成孤儿
   *    （界面上只能显示「（岗位已删除）」），属于静默的数据损坏。
   *    这种情况应该改为「停用」：停用后不再参与自动匹配，但历史匹配与看板展示都保留。
   */
  deletePosition(id: string): { deleted: boolean; matchCount: number; reason?: string } {
    const pos = this.positionById(id)
    if (!pos) return { deleted: false, matchCount: 0, reason: '岗位不存在' }
    const matchCount = this.matchCountOfPosition(id)
    if (matchCount > 0) {
      return {
        deleted: false,
        matchCount,
        reason: `该岗位下还有 ${matchCount} 位候选人。请改成「停用」而不是删除 —— 删除会让这些匹配变成孤儿数据（界面上只能显示「岗位已删除」）。`,
      }
    }
    this.db.positions = this.db.positions.filter((p) => p.id !== id)
    this.persist()
    return { deleted: true, matchCount: 0 }
  }

  // ---------------- 候选人 ↔ 岗位 挂靠 ----------------

  /** 手动把候选人挂到某岗位（已挂则原样返回，不重复建档） */
  addMatch(
    candidateId: string,
    positionId: string,
    assignedBy: MatchAssignedBy = 'manual'
  ): Match | undefined {
    const c = this.candidateById(candidateId)
    if (!c) return undefined
    const m = this.attach(c, positionId, assignedBy)
    if (m) this.persist()
    return m ?? undefined
  }

  /** 取消候选人在某岗位下的挂靠（连带该匹配一起删掉） */
  removeMatch(candidateId: string, positionId: string): boolean {
    const before = this.db.matches.length
    this.db.matches = this.db.matches.filter(
      (m) => !(m.candidateId === candidateId && m.positionId === positionId)
    )
    if (this.db.matches.length === before) return false
    this.persist()
    return true
  }
}

// ------------------------------------------------------------
// 简历原文的字段提取 —— 实现已移到 @ria/shared
// ------------------------------------------------------------
// 为什么搬走：它是纯文本处理（无 I/O），且要同时被「服务端落库」与
// 「扩展判重/诊断」使用。放共享包只维护一份，也便于在 Node 里单测。
//
// 这里**再导出一次**只是为了兼容既有调用方 —— 尤其是维护脚本
// scripts/repair-data.mjs 会从 store.ts 里 import 它。
export { parseResumeText }
// 供自检脚本与维护脚本使用（打印页排版、正文清洗、编号提取都在共享包里）
export { parseResumeSections, extractResumeNo, stripResumeChrome, isVolatileLine }
