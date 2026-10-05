// ============================================================
// 候选人名单 → 表格行（导出 xlsx 的数据层）
// ------------------------------------------------------------
// 分层：本文件**只做「数据 → 表格行」的映射**，字节流交给 xlsx.ts 的 buildXlsx。
//   路由层：查库 → 拼 ExportRow（含 formatExperience 的「经历」字符串）→ 调这里
//   本文件：列定义 / 显示标签 / 类型归一 → CellValue[][]
//   xlsx.ts：CellValue[][] → .xlsx 字节
// 这样拆的好处是「哪些列、叫什么、多少宽」可以单独被路由和前端复用
// （前端要显示"将导出 N 列"），也不用为了测列映射去解 ZIP。
//
// ★ 类型规则（HR 拿过去要能直接排序 / 筛选，所以不能一律当文本）：
//   年龄 / 工作年限 / 匹配度 → 数字；其余（含"6-7k×13""2024.08""007"）→ 文本。
//   字符串**绝不**在导出时被转成数字，否则 Excel 会按自己的理解改掉原值。
// ============================================================
import { buildXlsx, type CellValue } from './xlsx.ts'

/** 传给 buildXlsx 的表格行；由调用方（路由）提供数据 */
export interface ExportRow {
  name?: string
  gender?: string
  age?: number
  degree?: string
  educationMode?: string
  school?: string
  schoolTier?: string
  major?: string
  yearsOfExperience?: number
  /** 「经历」一列：由调用方用 formatExperience() 生成 */
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

export type ExportPreset = 'brief' | 'full'

/** 一列的元信息。key 与 ExportRow 的字段名对齐，便于路由 / 前端做"按列取数" */
export interface ExportColumn {
  key: string
  label: string
  width: number
}

/**
 * 列定义（供路由与自检复用，也便于前端显示「将导出 N 列」）。
 *
 * 宽度是"中文经验值"：一个字约等于 2 个宽度单位，所以 12 能放下 6 个汉字；
 * 「经历」整段是长文本给 60，「原始简历链接」给 50。
 * 「序号」不在 ExportRow 里 —— 它是按最终导出顺序生成的，由 buildCandidateWorkbook 填。
 */
export const PRESET_COLUMNS: Record<ExportPreset, ExportColumn[]> = {
  // 快速筛选用：看经历 / 学历性质 / 院校层次就能定要不要联系，一屏放得下
  brief: [
    { key: 'index', label: '序号', width: 6 },
    { key: 'name', label: '姓名', width: 12 },
    { key: 'gender', label: '性别', width: 8 },
    { key: 'age', label: '年龄', width: 8 },
    { key: 'degree', label: '学历', width: 10 },
    { key: 'educationMode', label: '学历性质', width: 12 },
    { key: 'school', label: '毕业院校', width: 22 },
    { key: 'schoolTier', label: '院校层次', width: 12 },
    { key: 'major', label: '专业', width: 18 },
    { key: 'yearsOfExperience', label: '工作年限', width: 10 },
    { key: 'experience', label: '经历', width: 60 },
    { key: 'expectedSalary', label: '薪酬', width: 16 },
    { key: 'city', label: '所在城市', width: 12 },
    { key: 'languages', label: '语言', width: 16 },
  ],
  // 完整归档用：追加归属岗位、意向、技能、采集溯源
  full: [
    { key: 'index', label: '序号', width: 6 },
    { key: 'name', label: '姓名', width: 12 },
    { key: 'gender', label: '性别', width: 8 },
    { key: 'age', label: '年龄', width: 8 },
    { key: 'degree', label: '学历', width: 10 },
    { key: 'educationMode', label: '学历性质', width: 12 },
    { key: 'school', label: '毕业院校', width: 22 },
    { key: 'schoolTier', label: '院校层次', width: 12 },
    { key: 'major', label: '专业', width: 18 },
    { key: 'yearsOfExperience', label: '工作年限', width: 10 },
    { key: 'experience', label: '经历', width: 60 },
    { key: 'expectedSalary', label: '薪酬', width: 16 },
    { key: 'city', label: '所在城市', width: 12 },
    { key: 'languages', label: '语言', width: 16 },
    { key: 'currentCompany', label: '当前公司', width: 24 },
    { key: 'currentTitle', label: '当前职位', width: 18 },
    { key: 'intentionPositions', label: '意向职位', width: 20 },
    { key: 'intentionCities', label: '期望城市', width: 14 },
    { key: 'skills', label: '技能标签', width: 24 },
    { key: 'matchPositionTitle', label: '匹配岗位', width: 18 },
    { key: 'matchScore', label: '匹配度', width: 10 },
    { key: 'platform', label: '采集来源', width: 12 },
    { key: 'capturedAt', label: '采集时间', width: 20 },
    { key: 'resumeNo', label: '简历编号', width: 24 },
    { key: 'resumeUrl', label: '原始简历链接', width: 50 },
  ],
}

const PRESET_LABEL: Record<ExportPreset, string> = {
  brief: '精简（推荐名单）',
  full: '完整（含意向 / 技能 / 溯源）',
}

/**
 * 平台 → 中文标签。
 *
 * 刻意不 import `@ria/shared` 的 PLATFORM_LABEL：本文件被 esbuild 单独打包做自检，
 * 少一个外部模块就少一处 alias / 解析出问题的可能；而且这份表是**导出用的展示文案**，
 * 与看板上的措辞未必永远一致（比如离线简历在导出里叫「线下导入」）。
 */
const PLATFORM_TEXT: Record<string, string> = {
  boss: 'BOSS直聘',
  liepin: '猎聘',
  offline: '线下导入',
  other: '其他',
}

const ARRAY_SEP = '、'

/** 数组用「、」连接；空数组 / 全空项 → undefined（= 空单元格，而不是空字符串行） */
function joinList(v: string[] | undefined | null): string | undefined {
  if (!Array.isArray(v)) return undefined
  const items = v.map((x) => String(x ?? '').trim()).filter((x) => x !== '')
  return items.length > 0 ? items.join(ARRAY_SEP) : undefined
}

/**
 * 性别：`M` → 男、`F` → 女，其它（含 unknown / 空 / 乱值）→ 留空。
 * 「判不出来就不猜」—— 猜错一个性别比留空尴尬得多。
 */
function genderText(v: string | undefined): string | undefined {
  const s = String(v ?? '').trim().toUpperCase()
  if (s === 'M' || s === 'MALE' || s === '男') return '男'
  if (s === 'F' || s === 'FEMALE' || s === '女') return '女'
  return undefined
}

/** 数字列：只有有限数字才写进去，其余留空（写 0 会被误读成"年龄 0 岁"） */
function num(v: number | undefined | null): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** 文本列：trim 后为空 → undefined（trim 掉平台抓来的首尾空白与换行） */
function str(v: string | undefined | null): string | undefined {
  const s = String(v ?? '').trim()
  return s === '' ? undefined : s
}

/** 导出时间：本地时间 YYYY-MM-DD HH:mm（给 HR 看的，不写 ISO 的 T/Z） */
function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`
  )
}

/**
 * 一行数据 → 一行单元格。
 * 未知 key（以后加列时忘了同步这里）返回 undefined → 空单元格，**不会**抛错中断整次导出。
 */
function cellOf(key: string, row: ExportRow, index: number): CellValue {
  switch (key) {
    case 'index':
      return index + 1
    case 'name':
      return str(row.name)
    case 'gender':
      return genderText(row.gender)
    case 'age':
      return num(row.age)
    case 'degree':
      return str(row.degree)
    case 'educationMode':
      return str(row.educationMode)
    case 'school':
      return str(row.school)
    case 'schoolTier':
      return str(row.schoolTier)
    case 'major':
      return str(row.major)
    case 'yearsOfExperience':
      return num(row.yearsOfExperience)
    case 'experience':
      return str(row.experience)
    case 'expectedSalary':
      return str(row.expectedSalary)
    case 'city':
      return str(row.city)
    case 'languages':
      return joinList(row.languages)
    case 'currentCompany':
      return str(row.currentCompany)
    case 'currentTitle':
      return str(row.currentTitle)
    case 'intentionPositions':
      return joinList(row.intentionPositions)
    case 'intentionCities':
      return joinList(row.intentionCities)
    case 'skills':
      return joinList(row.skills)
    case 'matchPositionTitle':
      return str(row.matchPositionTitle)
    case 'matchScore':
      return num(row.matchScore)
    case 'platform': {
      const p = str(row.platform)?.toLowerCase()
      return p ? (PLATFORM_TEXT[p] ?? str(row.platform)) : undefined
    }
    case 'capturedAt':
      return str(row.capturedAt)
    case 'resumeNo':
      return str(row.resumeNo)
    case 'resumeUrl':
      return str(row.resumeUrl)
    default:
      return undefined
  }
}

/** 候选人名单 → 表头行 + 数据行 */
function candidateRows(rows: ExportRow[], cols: ExportColumn[]): CellValue[][] {
  const header: CellValue[] = cols.map((c) => c.label)
  const body = rows.map((row, i) => cols.map((c) => cellOf(c.key, row, i)))
  return [header, ...body]
}

/**
 * 「导出信息」sheet：导出这件事本身的元数据。
 *
 * 为什么值得单独一个 sheet：这份表会被转发（钉钉 / 邮件 / U 盘），
 * 拿到的人必须先知道"这是哪个岗位、什么条件筛出来的、有多少人被截断了"，
 * 否则一张没有出处的名单比没有名单更危险。
 */
function infoRows(opts: {
  positionTitle?: string
  filterNote?: string
  truncated?: boolean
  total?: number
  count: number
  now: Date
  preset: ExportPreset
}): CellValue[][] {
  const { positionTitle, filterNote, truncated, total, count, now, preset } = opts
  const totalText = typeof total === 'number' && Number.isFinite(total) ? String(total) : String(count)
  const countText = truncated
    ? `${count} 条（导出上限 ${count} 条，共命中 ${totalText} 条，其余未导出）`
    : `${count} 条`

  return [
    ['项目', '值'],
    ['导出岗位', str(positionTitle) ?? '全部（未指定岗位）'],
    ['筛选条件', str(filterNote) ?? '无'],
    ['人数', countText],
    ['导出时间', stamp(now)],
    ['列预设', PRESET_LABEL[preset]],
    ['说明', '由招聘捕手从猎聘/BOSS直聘采集的在线简历文本生成'],
  ]
}

/**
 * 候选人名单 → .xlsx 字节。两个 sheet：['推荐名单', '导出信息']。
 *
 * @param now 注入时间，便于测试与"补导一份历史的"场景；缺省取当前时间
 */
export function buildCandidateWorkbook(
  rows: ExportRow[],
  opts: {
    preset: ExportPreset
    positionTitle?: string
    filterNote?: string
    truncated?: boolean
    total?: number
    /** 仅测试用：固定导出时间，保证产物可复现 */
    now?: Date
  }
): Buffer {
  const list = Array.isArray(rows) ? rows : []
  // 调用方永远会给 opts，但导出接口是"用户一点就走"的路径，
  // 传参写错时宁可退化成 brief 出一份表，也不要 500 掉整次导出
  const o = opts ?? ({} as { preset: ExportPreset })
  const preset: ExportPreset = o.preset === 'full' ? 'full' : 'brief'
  const cols = PRESET_COLUMNS[preset]

  return buildXlsx({
    sheets: [
      {
        name: '推荐名单',
        rows: candidateRows(list, cols),
        widths: cols.map((c) => c.width),
      },
      {
        // 元信息只有 7 行，冻结 / 自动筛选没有意义
        name: '导出信息',
        rows: infoRows({
          positionTitle: o.positionTitle,
          filterNote: o.filterNote,
          truncated: o.truncated,
          total: o.total,
          count: list.length,
          now: o.now ?? new Date(),
          preset,
        }),
        widths: [14, 56],
        freezeAndFilter: false,
      },
    ],
  })
}
