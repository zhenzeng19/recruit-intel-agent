// ============================================================
// 零依赖 .xlsx 写入器
// ------------------------------------------------------------
// 为什么自己写、不引 exceljs / sheetjs：
//   1) 导出名单是一个**纯数据变换**（数组 → 字节流），不需要读取、公式、
//      图表、样式引擎；引一个几百 KB 的库只为了拼 6 个 XML，不划算。
//   2) 服务端产物要能离线跑（内网 / 跳板机），依赖越少越不容易在部署时炸。
//
// 实现要点（都是踩过的坑，改之前先读）：
//   * .xlsx = ZIP + 一小撮 XML。这里用 **method 0（store，不压缩）**：
//     deflate 得引 zlib 并且要自己算压缩后的长度，而名单 xlsx 通常只有几百 KB，
//     省下的那点体积不值得多一份「压缩流写错」的风险。
//   * 时间戳**固定**成 1980-01-01（DOS 值 date=0x21, time=0）：同样的输入必须
//     产出**逐字节相同**的文件，否则「导出两次结果不一致」这种问题永远查不清。
//   * 字符串一律写 `t="inlineStr"` + `<is><t>`，不建 sharedStrings 表：
//     少一个 part、少一层索引，且对「只写不读」的场景没有任何损失。
//   * **空值整个 `<c>` 都不输出**（不是输出空标签）：Excel 里才能选中区域做
//     平均值 / 计数；写了空 `<is><t></t>` 反而会被当成"有值的空字符串"。
//   * 数字只认 `typeof v === 'number' && Number.isFinite(v)`。
//     字符串即使长得像数字也当**文本**：`6-7k×13`、`2024.08`、`007` 这类值
//     一旦被 Excel 当数字/日期，HR 看到的就和你导出时看到的不是一回事。
// ============================================================

/** 一个单元格：字符串走文本，数字走数字（Excel 里能排序 / 求平均） */
export type CellValue = string | number | null | undefined

export interface SheetSpec {
  /** sheet 名（Excel 限制 31 字符、不能含 \ / ? * [ ] :） */
  name: string
  /** 第一行是表头（会被加粗） */
  rows: CellValue[][]
  /** 每列宽度（字符数），长度应等于列数；缺省用默认宽度 */
  widths?: number[]
  /** 是否冻结首行 + 加自动筛选（默认 true） */
  freezeAndFilter?: boolean
}

export interface WorkbookSpec {
  sheets: SheetSpec[]
}

// ------------------------------------------------------------ CRC32（ZIP 每个条目都要）

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(b: Buffer): number {
  let c = -1
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

// ------------------------------------------------------------ ZIP（store，不压缩）

interface ZipEntry {
  name: string
  data: string
}

/** DOS 时间戳：1980-01-01 00:00（刻意固定，保证产物可复现） */
const DOS_DATE = 0x21
const DOS_TIME = 0

/**
 * 打一个 ZIP（全部 store 存储）。名字按 UTF-8 编码，并把通用位标记的
 * bit 11（0x0800）置上，Excel 才会按 UTF-8 解中文 part 名与 sheet 名。
 */
function zip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const data = Buffer.from(e.data, 'utf8')
    const crc = crc32(data)

    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0) // 本地文件头签名
    lh.writeUInt16LE(20, 4) // 解压所需版本 2.0
    lh.writeUInt16LE(0x0800, 6) // bit 11 = 文件名为 UTF-8
    lh.writeUInt16LE(0, 8) // method 0 = store
    lh.writeUInt16LE(DOS_TIME, 10)
    lh.writeUInt16LE(DOS_DATE, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(data.length, 18) // 压缩后大小 = 原始大小
    lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(name.length, 26)
    lh.writeUInt16LE(0, 28) // 无扩展字段
    parts.push(lh, name, data)

    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0) // 中央目录头签名
    ch.writeUInt16LE(20, 4) // 生成版本
    ch.writeUInt16LE(20, 6) // 解压所需版本
    ch.writeUInt16LE(0x0800, 8)
    ch.writeUInt16LE(0, 10)
    ch.writeUInt16LE(DOS_TIME, 12)
    ch.writeUInt16LE(DOS_DATE, 14)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(data.length, 20)
    ch.writeUInt32LE(data.length, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt32LE(offset, 42) // 本地文件头在本文件中的偏移
    central.push(ch, name)

    offset += lh.length + name.length + data.length
  }

  const cd = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8) // 本盘条目数
  eocd.writeUInt16LE(entries.length, 10) // 总条目数
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16) // 中央目录起始偏移
  return Buffer.concat([...parts, cd, eocd])
}

// ------------------------------------------------------------ XML 助手

/**
 * XML 转义 —— 数据侧字符串进 XML 的唯一入口。
 *
 * `&` 必须**第一个**换，否则会把后面生成的 `&lt;` 再转成 `&amp;lt;`（二次转义）。
 * 简历正文里出现 `<script>` 或引号是家常便饭，漏一处整份 xlsx 就打不开了
 * （XML 解析失败 → Excel 直接报「文件已损坏」）。
 */
function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 控制字符在 XML 1.0 里非法，必须剔除，否则整份文件报废 */
// eslint-disable-next-line no-control-regex
const ILLEGAL_XML_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g

/**
 * 真正写进 `<t>` 的文本：
 * - 非法控制字符剔除（制表 / 换行 / 回车是合法的，保留）；
 * - **尾随空格 / 换行必须靠 `xml:space="preserve"` 保住**，调用侧统一加上。
 *
 * ⚠️ 已知取舍：OOXML 规定 ST_Xstring 里字面出现的 `_xHHHH_` 应写成 `_x005F_xHHHH_`，
 *    否则读的一方可能把它当字符码位（`_x0041_` → `A`）。这里**故意不转义**：
 *    本机唯一的独立验证器 openpyxl 并不实现这层解码，一旦转义，它读回来的是
 *    `_x005F_x0041_` —— 也就是「为了防一种理论上的损坏，换来一种可复现的损坏」。
 *    简历正文里字面出现 `_xHHHH_` 的概率极低（实测夹具里的 `AI_x_2024`、
 *    `项目_a` 都原样往返），因此按原型的做法直写，并用自检把「原样往返」钉住。
 */
function text(v: string): string {
  return esc(v.replace(ILLEGAL_XML_CHARS, ''))
}

/**
 * 0 → A、25 → Z、26 → AA、701 → ZZ、702 → AAA…
 * 必须支持超过 26 列（full preset 已经 25 列，多选几个字段就破 26 了）。
 */
function colName(index: number): string {
  let n = index + 1
  let s = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    s = String.fromCharCode(65 + rem) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/** A1 形式；row 是 0 基行号 */
function ref(col: number, row: number): string {
  return `${colName(col)}${row + 1}`
}

function cellXml(col: number, row: number, v: CellValue, isHeader: boolean): string {
  const r = ref(col, row)
  const style = isHeader ? ' s="1"' : ''

  if (typeof v === 'number' && Number.isFinite(v)) {
    // 数字：Excel 里可排序 / 求平均。整数不写小数点（openpyxl 读出来就是 int）
    return `<c r="${r}"${style}><v>${v}</v></c>`
  }
  if (typeof v === 'string') {
    if (v === '') return '' // 空字符串 = 无值，整个 <c> 不输出
    return `<c r="${r}"${style} t="inlineStr"><is><t xml:space="preserve">${text(v)}</t></is></c>`
  }
  return '' // null / undefined / NaN / Infinity：不输出空标签
}

// ------------------------------------------------------------ sheet 名净化

const BAD_SHEET_CHARS = /[\\/?*[\]:]/g
const SHEET_NAME_LIMIT = 31

/**
 * 净化 sheet 名：
 *   `\ / ? * [ ] :` → `-`（这些字符 Excel 直接拒绝打开）
 *   截断到 31 字符（Excel 上限）
 *   空 / 全空白 → Sheet1
 * 重名由调用方（buildXlsx）补序号，因为重名是"跨 sheet"才知道的事。
 */
function sanitizeSheetName(raw: string): string {
  let s = String(raw ?? '').replace(BAD_SHEET_CHARS, '-').trim()
  if (s === '') s = 'Sheet1'
  if (s.length > SHEET_NAME_LIMIT) s = s.slice(0, SHEET_NAME_LIMIT)
  return s
}

/** 重名去重：第二个「推荐名单」→「推荐名单(2)」，且补后缀后仍不能超 31 字符 */
function uniqueSheetNames(names: string[]): string[] {
  const used = new Set<string>()
  return names.map((raw) => {
    const base = sanitizeSheetName(raw)
    if (!used.has(base)) {
      used.add(base)
      return base
    }
    for (let i = 2; ; i++) {
      const suffix = `(${i})`
      const trimmed = base.slice(0, SHEET_NAME_LIMIT - suffix.length)
      const candidate = `${trimmed}${suffix}`
      if (!used.has(candidate)) {
        used.add(candidate)
        return candidate
      }
    }
  })
}

// ------------------------------------------------------------ 固定 XML part

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

/**
 * [Content_Types].xml
 * 每个 sheet 一份 Override；发布者用 workbook 的 rels 指过来。
 */
function contentTypesXml(sheetCount: number): string {
  const sheetOverrides = Array.from(
    { length: sheetCount },
    (_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  ).join('')
  return (
    XML_DECL +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    sheetOverrides +
    '</Types>'
  )
}

const ROOT_RELS =
  XML_DECL +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '</Relationships>'

/**
 * xl/styles.xml
 *
 * 三处是**硬性要求**，动之前先确认自己知道后果：
 *   1. `<fills>` 的前两个必须是 `none` + `gray125` —— Excel 会按固定下标取内置填充，
 *      顺序错了直接报「文件已损坏」。
 *   2. 必须补 `<cellStyles count="1"><cellStyle name="常规" xfId="0" builtinId="0"/></cellStyles>`，
 *      少了它 openpyxl 会警告 `Workbook contains no default style`（原型就是漏了这条）。
 *   3. `cellXfs` 的两个 xf 下标固定：0 = 普通、1 = 表头加粗（工作表里 `s="1"` 指的就是它）。
 */
const STYLES_XML =
  XML_DECL +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="2">' +
  '<font><sz val="11"/><color theme="1"/><name val="等线"/><family val="2"/><charset val="134"/></font>' +
  '<font><b/><sz val="11"/><color theme="1"/><name val="等线"/><family val="2"/><charset val="134"/></font>' +
  '</fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border/></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="2">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="常规" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>'

function workbookXml(names: string[]): string {
  const sheets = names
    .map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('')
  return (
    XML_DECL +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets>${sheets}</sheets>` +
    '</workbook>'
  )
}

/** sheet 的 rId1..rIdN，styles 拿最后那个（N+1） */
function workbookRelsXml(sheetCount: number): string {
  const rels = Array.from(
    { length: sheetCount },
    (_, i) =>
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
  ).join('')
  return (
    XML_DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    rels +
    `<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    '</Relationships>'
  )
}

// ------------------------------------------------------------ worksheet

/** 列宽：默认 12（够放中文 6 个字），夹到 Excel 的 [1, 255] */
const DEFAULT_COL_WIDTH = 12

function colsXml(widths: number[] | undefined, colCount: number): string {
  if (colCount === 0) return ''
  const parts: string[] = []
  for (let c = 0; c < colCount; c++) {
    const raw = widths?.[c]
    const w = typeof raw === 'number' && Number.isFinite(raw) ? Math.min(255, Math.max(1, raw)) : DEFAULT_COL_WIDTH
    parts.push(`<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`)
  }
  return `<cols>${parts.join('')}</cols>`
}

function worksheetXml(sheet: SheetSpec, freezeAndFilter: boolean): string {
  const rows = sheet.rows
  const colCount = rows.reduce((m, r) => Math.max(m, r.length), 0)
  const rowCount = rows.length
  // dimension / autoFilter 都用整块数据区的范围。dimension 写真实范围（而不是恒等 A1）
  // 能让 openpyxl 的 max_row / max_column 与肉眼看到的一致。
  const rangeRef = `A1:${ref(Math.max(0, colCount - 1), Math.max(0, rowCount - 1))}`

  const sheetData = rows
    .map((cells, r) => {
      const body = cells.map((v, c) => cellXml(c, r, v, r === 0)).join('')
      return body === '' ? '' : `<row r="${r + 1}">${body}</row>`
    })
    .join('')

  const hasData = rowCount > 0 && colCount > 0
  // pane 的属性顺序是 schema 规定的：先 activePane，再 state
  const sheetViews =
    freezeAndFilter && hasData
      ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
      : ''
  // 自动筛选至少要有一行数据才有意义（只有表头时 Excel 会把它当成空筛选）
  const autoFilter = freezeAndFilter && rowCount > 1 && colCount > 0 ? `<autoFilter ref="${rangeRef}"/>` : ''

  return (
    XML_DECL +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<dimension ref="${rangeRef}"/>` +
    sheetViews +
    colsXml(sheet.widths, colCount) +
    (sheetData === '' ? '<sheetData/>' : `<sheetData>${sheetData}</sheetData>`) +
    autoFilter +
    '</worksheet>'
  )
}

// ------------------------------------------------------------ 入口

/**
 * 生成 .xlsx 字节。纯函数：无 I/O、无第三方依赖、同样的输入产出逐字节相同的输出。
 *
 * @throws 没有 sheet 时抛错（xlsx 规范要求至少一个 sheet，硬造一个空表反而会让
 *         调用方误以为"导出成功但没数据"）
 */
export function buildXlsx(wb: WorkbookSpec): Buffer {
  const specs = wb?.sheets ?? []
  if (specs.length === 0) throw new Error('buildXlsx: 至少需要一个 sheet')

  const names = uniqueSheetNames(specs.map((s) => s.name))

  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: contentTypesXml(specs.length) },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'xl/workbook.xml', data: workbookXml(names) },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRelsXml(specs.length) },
    { name: 'xl/styles.xml', data: STYLES_XML },
  ]
  specs.forEach((s, i) => {
    entries.push({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: worksheetXml(s, s.freezeAndFilter !== false),
    })
  })

  return zip(entries)
}
