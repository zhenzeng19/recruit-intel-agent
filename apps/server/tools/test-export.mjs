// ============================================================
// 零依赖 xlsx 导出 —— 自检
// ------------------------------------------------------------
// 为什么**必须**用 Python openpyxl 反向验证：
//   一个手写的 .xlsx 最容易出的问题不是「字节少了」，而是「ZIP 结构对、XML 也像那么
//   回事，但 Excel 打开报『文件已损坏』」。只断言 "PK\x03\x04" 头或数一数 part 数量，
//   对这类问题**一个都抓不到**。所以这里把产物交给一个真正独立的实现去解析，
//   再由 Node 侧断言它的解析结果（值 / 类型 / 冻结 / 筛选 / 加粗 / 列宽）。
//
// 两个容易踩的坑，已经处理：
//   1) PYTHONIOENCODING=utf-8 —— Windows 控制台默认 GBK，中文会变成乱码，
//      Node 侧拿到的 JSON 就是错的（不是"看起来乱"，是解析出来的字符真的不对）。
//   2) 用 spawnSync + encoding:'utf8' 取 stdout，而不是继承管道自己读。
//
// 跑法：node apps/server/tools/test-export.mjs
// ============================================================
import esbuild from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../..')

/** 本机已装 openpyxl 3.1.5 的 Python（与项目其它自检脚本同一份运行时） */
const PYTHON = 'C:\\Users\\1\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe'

// ---------------------------------------------------------- 断言工具（沿用 test-print.mjs 的形态）
let pass = 0
let fail = 0
const failures = []

function ok(cond, label) {
  if (cond) {
    pass++
    console.log(`  ✓  ${label}`)
  } else {
    fail++
    failures.push(label)
    console.log(`  ✗  ${label}`)
  }
}
function eq(actual, expected, label) {
  if (actual === expected) {
    pass++
    console.log(`  ✓  ${label}`)
  } else {
    fail++
    failures.push(label)
    console.log(`  ✗  ${label}`)
    console.log(`       期望 ${JSON.stringify(expected)}`)
    console.log(`       实际 ${JSON.stringify(actual)}`)
  }
}
const section = (t) => console.log(`\n${t}`)

// ---------------------------------------------------------- 临时目录
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ria-xlsx-'))
const bundleFile = path.join(tmpDir, 'export-build.mjs')
/**
 * ⚠️ 脚本名**不能**叫 inspect.py：Python 会把脚本所在目录放进 sys.path[0]，
 *    于是 `from inspect import isgenerator`（openpyxl.worksheet.worksheet 里那一行）
 *    会命中我们自己的文件，报 "cannot import name 'isgenerator' from 'inspect'"。
 *    同理也别叫 json.py / types.py / zipfile.py —— 一律带前缀。
 */
const pyFile = path.join(tmpDir, 'ria_inspect_xlsx.py')

function cleanup() {
  // KEEP_TMP=1 时保留临时目录，便于用 openpyxl 手工复核产物
  if (process.env.KEEP_TMP === '1') {
    console.log(`（KEEP_TMP=1：临时产物保留在 ${tmpDir}）`)
    return
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}
process.on('exit', cleanup)

if (!fs.existsSync(PYTHON)) {
  console.error(`✗ 找不到 Python：${PYTHON}`)
  console.error('  openpyxl 反向验证是本次自检的核心，缺它无法进行。')
  process.exit(1)
}

// ---------------------------------------------------------- Python 侧检查器
// 只负责「把解析结果如实打成 JSON」，判断全部放在 Node 侧 ——
// 这样断言逻辑与产物生成在同一处，改断言不用在两种语言间来回跳。
//
// 刻意写成「一行一个字符串」而不是一个大模板串：
//   * Python 代码里的缩进、换行、引号都不需要逃逸，改起来不用数反引号；
//   * 这份代码只是纯文本，不存在任何模板插值，写成模板串反而更容易被内容咬到。
const PY_LINES = [
  '# 由 tools/test-export.mjs 调用：python inspect.py <file.xlsx>',
  '# stdout 只输出一行 JSON；断言全部在 Node 侧做。',
  'import json, sys, warnings, zipfile',
  '',
  '# openpyxl 的告警（尤其 "Workbook contains no default style"）默认可能被吞掉。',
  '# 它是「styles.xml 少了 cellStyles」唯一的可观测信号，必须收集回传。',
  'warnings.simplefilter("always")',
  'warned = []',
  '',
  'def _showwarning(message, category, filename, lineno, file=None, line=None):',
  '    warned.append(category.__name__ + ": " + str(message))',
  '',
  'warnings.showwarning = _showwarning',
  '',
  'xlsx_path = sys.argv[1]',
  'report = {"ok": False}',
  '',
  'try:',
  '    import openpyxl',
  '    report["openpyxl"] = openpyxl.__version__',
  '',
  '    # 先让独立实现把 ZIP 解开：part 名与每个条目的 CRC 都会被校验',
  '    with zipfile.ZipFile(xlsx_path) as z:',
  '        report["zip_names"] = sorted(z.namelist())',
  '        report["zip_bad_entry"] = z.testzip()  # None = 所有条目 CRC 都对得上',
  '',
  '    wb = openpyxl.load_workbook(xlsx_path)',
  '    report["sheetnames"] = list(wb.sheetnames)',
  '',
  '    def val_of(cell):',
  '        # 刻意区分 int / float / str：',
  '        # 「年龄在 Excel 里是数字而不是文本」是本次导出最要紧的约束之一。',
  '        v = cell.value',
  '        if v is None:',
  '            return None, "NoneType"',
  '        if isinstance(v, bool):',
  '            return v, "bool"',
  '        if isinstance(v, float) and v.is_integer():',
  '            return v, "int"',
  '        if isinstance(v, int):',
  '            return v, "int"',
  '        if isinstance(v, float):',
  '            return v, "float"',
  '        if isinstance(v, str):',
  '            return v, "str"',
  '        return str(v), type(v).__name__',
  '',
  '    sheets = {}',
  '    for name in wb.sheetnames:',
  '        ws = wb[name]',
  '        freeze = ws.freeze_panes',
  '        hfont = ws.cell(row=1, column=1).font',
  '        vals, types = {}, {}',
  '        for row in ws.iter_rows():',
  '            for c in row:',
  '                v, t = val_of(c)',
  '                vals[c.coordinate] = v',
  '                types[c.coordinate] = t',
  '        widths = {}',
  '        for key, dim in ws.column_dimensions.items():',
  '            if dim.width is not None:',
  '                widths[key] = dim.width',
  '        sheets[name] = {',
  '            "max_row": ws.max_row,',
  '            "max_column": ws.max_column,',
  '            "freeze_panes": str(freeze) if freeze is not None else None,',
  '            "auto_filter": ws.auto_filter.ref,',
  '            "bold_a1": bool(hfont.bold),',
  '            "bold_a2": bool(ws.cell(row=2, column=1).font.bold) if ws.max_row >= 2 else None,',
  '            "font_name_a1": hfont.name,',
  '            "widths": widths,',
  '            "values": vals,',
  '            "types": types,',
  '        }',
  '    report["sheets"] = sheets',
  '    report["ok"] = True',
  '',
  'except Exception as e:  # 异常如实回传，由 Node 侧断言失败',
  '    import traceback',
  '    report["error"] = type(e).__name__ + ": " + str(e)',
  '    report["traceback"] = traceback.format_exc()',
  '',
  'finally:',
  '    report["warnings"] = warned',
  '    sys.stdout.write(json.dumps(report, ensure_ascii=False))',
  '',
]
fs.writeFileSync(pyFile, PY_LINES.join('\n'), 'utf8')

// ---------------------------------------------------------- 1. 打包被测模块
console.log('=== 零依赖 xlsx 导出 自检 ===\n')
console.log('正在打包 apps/server/src/export-build.ts …')
await esbuild.build({
  entryPoints: [path.join(repoRoot, 'apps/server/src/export-build.ts')],
  outfile: bundleFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'bundle',
  alias: { '@ria/shared': path.join(repoRoot, 'packages/shared/src/index.ts') },
  logLevel: 'warning',
})

const mod = await import(pathToFileURL(bundleFile).href)
const { buildCandidateWorkbook, PRESET_COLUMNS } = mod

// buildXlsx 没有被 export-build 转出，单独再打一次包（列名换算等底层用例要用）
const xlsxBundleFile = path.join(tmpDir, 'xlsx.mjs')
await esbuild.build({
  entryPoints: [path.join(repoRoot, 'apps/server/src/xlsx.ts')],
  outfile: xlsxBundleFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'warning',
})
const { buildXlsx } = await import(pathToFileURL(xlsxBundleFile).href)

// ---------------------------------------------------------- 2. 夹具
const LONG_EXPERIENCE = [
  '2019.03 - 至今 某某科技有限公司 · 高级前端工程师 · 负责招聘 SaaS 的简历解析与看板',
  '2016.07 - 2019.02 某某网络科技有限公司 · 前端工程师 · 负责运营后台',
  '2013.09 - 2016.06 某某信息技术有限公司 · 前端开发 · 负责企业官网',
].join('\n')

/** 一行的所有边界：中文 / 特殊字符 / 空值 / 长文本 / 像数字的字符串 / 全空行 */
const ROWS = [
  {
    name: '李先生',
    gender: 'M',
    age: 38,
    degree: '本科',
    educationMode: '统招',
    school: '南京大学',
    schoolTier: '985',
    major: '计算机科学与技术',
    yearsOfExperience: 15,
    experience: LONG_EXPERIENCE,
    expectedSalary: '6-7k×13',
    city: '盐城',
    languages: ['英语', '普通话'],
    currentCompany: '某某科技有限公司',
    currentTitle: '高级前端工程师',
    intentionPositions: ['前端工程师', 'Web 开发'],
    intentionCities: ['南京', '苏州'],
    skills: ['React', 'TypeScript', 'MySQL'],
    matchPositionTitle: '高级前端工程师（南京）',
    matchScore: 87,
    platform: 'liepin',
    capturedAt: '2026-02-11 10:30',
    resumeNo: 'EF56AB78CD9000ee55ff66',
    resumeUrl: 'https://www.liepin.com/resume/show?res_id=abc&from=search',
  },
  {
    name: 'A & B < C > D',
    gender: 'F',
    age: 30,
    degree: '硕士',
    educationMode: '非统招',
    school: '含特殊字符 <&"\'> 学院',
    schoolTier: '211',
    major: '软件工程',
    yearsOfExperience: 0,
    experience: '一句话经历',
    expectedSalary: '2024.08',
    city: '北京',
    languages: [],
    currentCompany: 'A & B 公司',
    currentTitle: '工程师',
    intentionPositions: [],
    intentionCities: ['北京'],
    skills: ['Go'],
    matchPositionTitle: '后端工程师',
    matchScore: 0,
    platform: 'boss',
    capturedAt: '',
    resumeNo: '007',
    resumeUrl: '',
  },
  {
    // 全空行：所有单元格都不输出，Python 侧应全是 None
    name: '',
    gender: 'unknown',
    age: undefined,
    degree: '',
    educationMode: '',
    school: '',
    schoolTier: '',
    major: '',
    yearsOfExperience: undefined,
    experience: '',
    expectedSalary: '',
    city: '',
    languages: [],
    currentCompany: '',
    currentTitle: '',
    intentionPositions: [],
    intentionCities: [],
    skills: [],
    matchPositionTitle: '',
    matchScore: undefined,
    platform: '',
    capturedAt: '',
    resumeNo: '',
    resumeUrl: '',
  },
]

const OPTIONS = {
  positionTitle: '高级前端工程师（南京）',
  filterNote: '本科及以上 · 5 年以上经验',
  truncated: true,
  total: 60,
  now: new Date(2026, 1, 11, 10, 30), // 固定时间，产物可复现
}

const briefPath = path.join(tmpDir, 'brief.xlsx')
const fullPath = path.join(tmpDir, 'full.xlsx')
fs.writeFileSync(briefPath, buildCandidateWorkbook(ROWS, { ...OPTIONS, preset: 'brief' }))
fs.writeFileSync(fullPath, buildCandidateWorkbook(ROWS, { ...OPTIONS, preset: 'full' }))
console.log(`已生成产物：${path.basename(briefPath)} / ${path.basename(fullPath)}（临时目录 ${tmpDir}）`)

// 手写一张 30 列的 sheet，验列名换算越过 Z 到 AA / AB…
const widePath = path.join(tmpDir, 'wide.xlsx')
fs.writeFileSync(
  widePath,
  buildXlsx({
    sheets: [
      {
        name: '30列验证',
        rows: [
          Array.from({ length: 30 }, (_, i) => `列${i + 1}`),
          Array.from({ length: 30 }, (_, i) => i + 1),
          Array.from({ length: 30 }, (_, i) => `值${i + 1}`),
        ],
        widths: Array.from({ length: 30 }, () => 9),
      },
    ],
  })
)

// sheet 名净化 / 重名 / 空名 / 超长的边界
const namesPath = path.join(tmpDir, 'names.xlsx')
fs.writeFileSync(
  namesPath,
  buildXlsx({
    sheets: [
      { name: 'a/b:c*d?e[f]g\\h', rows: [['x'], [1]] },
      { name: '推荐名单', rows: [['x'], [2]] },
      { name: '   ', rows: [['x'], [3]] },
      { name: '推荐名单', rows: [['x'], [4]] },
      { name: '这是一个特别特别特别长的中文sheet名字超过了三十一个字符的限制', rows: [['x'], [5]] },
    ],
  })
)

// ---------------------------------------------------------- 4. Python 反向验证
section('1. Python（openpyxl）能否真正打开这四份产物')

function inspect(file) {
  const r = spawnSync(PYTHON, [pyFile, file], {
    encoding: 'utf8',
    // ⚠️ 必须设：否则 Windows 控制台按 GBK 编码 stdout，中文全变乱码
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    maxBuffer: 64 * 1024 * 1024,
  })
  if (r.error) throw r.error
  if (r.status !== 0) {
    throw new Error(`Python 退出码 ${r.status}\nstderr: ${r.stderr}\nstdout: ${r.stdout}`)
  }
  const lines = (r.stdout ?? '').split('\n')
  const jsonLine = lines.find((l) => l.trim().startsWith('{')) ?? ''
  try {
    return JSON.parse(jsonLine)
  } catch (e) {
    throw new Error(`Python 输出不是合法 JSON：${e.message}\n--- stdout ---\n${r.stdout}`)
  }
}

const brief = inspect(briefPath)
const full = inspect(fullPath)
const wide = inspect(widePath)
const names = inspect(namesPath)

ok(brief.ok, `openpyxl ${brief.openpyxl} 成功打开 brief.xlsx`)
ok(full.ok, 'openpyxl 成功打开 full.xlsx')
ok(wide.ok, 'openpyxl 成功打开 wide.xlsx（30 列）')
ok(names.ok, 'openpyxl 成功打开 names.xlsx（sheet 名边界）')
for (const [label, rep] of [['brief', brief], ['full', full], ['wide', wide], ['names', names]]) {
  if (!rep.ok) console.log(`       ${label} 解析报错：${rep.error}\n${rep.traceback ?? ''}`)
}

// ZIP 层：交给独立的 zipfile 实现解，顺带校验每个条目的 CRC
ok(brief.zip_bad_entry === null, 'ZIP 内所有条目的 CRC 校验通过（zipfile.testzip()=None）')
ok(
  brief.zip_names.includes('xl/styles.xml') && brief.zip_names.includes('[Content_Types].xml'),
  `ZIP 里 part 齐全（共 ${brief.zip_names.length} 个）`
)

section('2. 不该出现的警告：默认样式缺失')
for (const [label, rep] of [['brief', brief], ['full', full]]) {
  const w = rep.warnings ?? []
  const noDefault = w.find((x) => x.includes('no default style'))
  ok(!noDefault, `${label}.xlsx 不再触发 "Workbook contains no default style"`)
  if (w.length > 0) console.log(`       实际警告：${w.join(' | ')}`)
}

const B = brief.sheets
const F = full.sheets

// ---------------------------------------------------------- 断言
section('3. sheet 名与顺序')
eq(brief.sheetnames.join(','), '推荐名单,导出信息', 'brief 两个 sheet 名与顺序正确')
eq(full.sheetnames.join(','), '推荐名单,导出信息', 'full 两个 sheet 名与顺序正确')
ok('推荐名单' in B && '推荐名单' in F, '中文 sheet 名「推荐名单」被 Python 原样读出')

section('4. 表头加粗 / 冻结首行 / 自动筛选 / 列宽')
{
  const s = B['推荐名单']
  eq(PRESET_COLUMNS.brief.length, 14, 'brief 列定义是 14 列（序号 + 点名的 13 项）')
  eq(s.max_row, 4, 'brief 推荐名单 max_row = 4（表头 + 3 行）')
  eq(s.max_column, PRESET_COLUMNS.brief.length, `brief 推荐名单 max_column = ${PRESET_COLUMNS.brief.length}`)
  eq(s.freeze_panes, 'A2', '冻结窗格是 A2（首行冻结）')
  eq(s.auto_filter, 'A1:N4', '自动筛选范围 = A1:N4')
  ok(s.bold_a1, '表头 A1「序号」字体为粗体')
  ok(s.bold_a2 === false, '数据行 A2 不加粗（只有表头加粗）')
  eq(s.font_name_a1, '等线', `表头字体是等线（实际 ${s.font_name_a1}）`)
  eq(s.widths.A, 6, '序号列宽 6')
  eq(s.widths.B, 12, '姓名列宽 12')
  eq(s.widths.K, 60, '经历列宽 60（长文本给足）')
  eq(s.widths.N, 16, '语言列宽 16')
}
{
  const s = F['推荐名单']
  eq(PRESET_COLUMNS.full.length, 25, 'full 列定义是 25 列（brief 14 + 追加 11 列）')
  eq(s.max_row, 4, 'full 推荐名单 max_row = 4')
  eq(s.max_column, PRESET_COLUMNS.full.length, `full 推荐名单 max_column = ${PRESET_COLUMNS.full.length}`)
  eq(s.freeze_panes, 'A2', 'full 冻结窗格是 A2')
  eq(s.auto_filter, 'A1:Y4', 'full 自动筛选范围 = A1:Y4（最后一列 Y）')
  eq(s.widths.Y, 50, '原始简历链接列（Y）宽 50')
}

section('5. 单元格的值与类型（HR 要能排序，所以数字必须真是数字）')
{
  const s = B['推荐名单']
  eq(s.values.A1, '序号', 'A1 表头 = 序号')
  eq(s.values.C1, '性别', 'C1 表头 = 性别')
  eq(s.values.F1, '学历性质', 'F1 表头 = 学历性质')
  eq(s.values.K1, '经历', 'K1 表头 = 经历')
  eq(s.values.N1, '语言', 'N1 表头 = 语言')

  eq(s.values.A2, 1, '序号是数字 1（不是 "1"）')
  eq(s.types.A2, 'int', '序号在 Python 里是 int')
  eq(s.values.B2, '李先生', 'B2 姓名 = 李先生')
  eq(s.types.B2, 'str', '姓名在 Python 里是 str')
  eq(s.values.C2, '男', 'C2 性别 M → 男')
  eq(s.values.D2, 38, 'D2 年龄 = 38')
  eq(s.types.D2, 'int', '年龄在 Python 里是 int（不是 str）')
  eq(s.values.J2, 15, 'J2 工作年限 = 15')
  eq(s.types.J2, 'int', '工作年限在 Python 里是 int')
  eq(s.values.L2, '6-7k×13', 'L2 薪酬 "6-7k×13" 原样保留')
  eq(s.types.L2, 'str', '"6-7k×13" 是 str（没被 Excel 当成数字/日期）')
  eq(s.values.M2, '盐城', 'M2 所在城市 = 盐城')
  eq(s.values.N2, '英语、普通话', 'N2 语言数组用「、」连接')
  ok(String(s.values.K2).includes('某某科技有限公司'), 'K2 经历长文本保留完整内容')
  eq(String(s.values.K2).split('\n').length, 3, 'K2 经历里的换行被保住（3 行）')
}

section('6. 转义：特殊字符 / 像数字的字符串必须原样还原')
{
  const s = B['推荐名单']
  eq(s.values.B3, 'A & B < C > D', 'B3 "A & B < C > D" 原样还原（& < > 转义正确）')
  eq(s.values.G3, '含特殊字符 <&"\'> 学院', 'G3 含 < & " \' > 的院校名原样还原')
  eq(s.types.G3, 'str', '特殊字符单元格是 str')
  eq(s.values.E3, '硕士', 'E3 学历 = 硕士')
  eq(s.values.F3, '非统招', 'F3 学历性质 = 非统招')
  eq(s.values.H3, '211', 'H3 院校层次 211 被当文本（不参与数值计算）')
  eq(s.values.C3, '女', 'C3 性别 F → 女')
  eq(s.values.D3, 30, 'D3 年龄 = 30（int）')
  eq(s.types.D3, 'int', '年龄仍是 int')
  eq(s.values.L3, '2024.08', 'L3 薪酬 "2024.08" 保持文本（没变成日期）')
  eq(s.types.L3, 'str', '"2024.08" 是 str')

  const f = F['推荐名单']
  eq(f.values.O3, 'A & B 公司', 'O3 当前公司里的 & 原样还原')
  eq(f.values.J3, 0, 'J3 工作年限 = 0 被保留（0 不等于空）')
  eq(f.values.U3, 0, 'U3 匹配度 = 0 被保留')
  eq(f.types.U3, 'int', '匹配度 0 是 int')
  eq(f.values.X3, '007', 'X3 简历编号 "007" 保持文本（前导零没丢）')
  eq(f.types.X3, 'str', '"007" 是 str')
}

section('7. 空值：整个 <c> 不输出，Python 侧读到 None')
{
  const s = B['推荐名单']
  eq(s.values.D4, null, 'D4 空年龄 = None')
  eq(s.values.L4, null, 'L4 空薪酬 = None')
  eq(s.values.N4, null, 'N4 空语言数组 = None')
  eq(s.types.D4, 'NoneType', '空值单元格类型是 NoneType')
  eq(s.values.C4, null, 'C4 性别 unknown → 留空（判不出就不猜）')
  eq(s.values.G4, null, 'G4 空院校 = None')
}
{
  const s = F['推荐名单']
  eq(s.values.O4, null, 'full 的空当前公司 = None')
  eq(s.values.U4, null, 'full 的空匹配度 = None')
  eq(s.values.AA4, undefined, '第 27 列（AA）在 25 列的表里确实不存在（openpyxl 报告里连 key 都没有）')
}

section('8. 「导出信息」sheet 的两列元数据')
{
  const s = B['导出信息']
  eq(s.max_column, 2, '导出信息是两列')
  eq(s.max_row, 7, '导出信息是 7 行（表头 + 6 项）')
  eq(s.values.A1, '项目', 'A1 = 项目')
  eq(s.values.B1, '值', 'B1 = 值')
  eq(s.values.A2, '导出岗位', '第 2 行是导出岗位')
  eq(s.values.B2, '高级前端工程师（南京）', '导出岗位值正确')
  eq(s.values.A3, '筛选条件', '第 3 行是筛选条件')
  eq(s.values.B3, '本科及以上 · 5 年以上经验', '筛选条件值正确')
  eq(s.values.A4, '人数', '第 4 行是人数')
  ok(String(s.values.B4).includes('3 条'), `人数含实际导出条数（实际 ${s.values.B4}）`)
  ok(String(s.values.B4).includes('60'), '截断时人数里写清「共命中多少条」')
  eq(s.values.A5, '导出时间', '第 5 行是导出时间')
  ok(/^2026-02-11 10:30$/.test(String(s.values.B5)), `导出时间格式 = YYYY-MM-DD HH:mm（实际 ${s.values.B5}）`)
  eq(s.values.A6, '列预设', '第 6 行是列预设')
  eq(s.values.B6, '精简（推荐名单）', 'brief 的列预设名正确')
  eq(s.values.A7, '说明', '第 7 行是说明')
  eq(s.values.B7, '由招聘捕手从猎聘/BOSS直聘采集的在线简历文本生成', '说明文案正确')
  eq(s.freeze_panes, null, '导出信息不冻结窗格')
  eq(s.auto_filter, null, '导出信息不加自动筛选')
  eq(s.widths.A, 14, '导出信息第 1 列宽 14')
  eq(s.widths.B, 56, '导出信息第 2 列宽 56')
}
{
  const s = F['导出信息']
  eq(s.values.B6, '完整（含意向 / 技能 / 溯源）', 'full 的列预设名正确')
}

section('9. full 追加的 11 列内容')
{
  const s = F['推荐名单']
  eq(s.values.O2, '某某科技有限公司', 'O2 当前公司')
  eq(s.values.P2, '高级前端工程师', 'P2 当前职位')
  eq(s.values.Q2, '前端工程师、Web 开发', 'Q2 意向职位用「、」连接')
  eq(s.values.R2, '南京、苏州', 'R2 期望城市用「、」连接')
  eq(s.values.S2, 'React、TypeScript、MySQL', 'S2 技能标签用「、」连接')
  eq(s.values.T2, '高级前端工程师（南京）', 'T2 匹配岗位')
  eq(s.values.U2, 87, 'U2 匹配度 = 87')
  eq(s.types.U2, 'int', '匹配度在 Python 里是 int')
  eq(s.values.V2, '猎聘', 'V2 采集来源 liepin → 猎聘')
  eq(s.values.W2, '2026-02-11 10:30', 'W2 采集时间原样')
  eq(s.values.X2, 'EF56AB78CD9000ee55ff66', 'X2 简历编号')
  eq(s.values.Y2, 'https://www.liepin.com/resume/show?res_id=abc&from=search', 'Y2 原始简历链接原样（& 未二次转义）')
  eq(s.values.V3, 'BOSS直聘', 'V3 采集来源 boss → BOSS直聘')
}

section('10. 超过 26 列：列名换算到 AA / AB…')
{
  const s = wide.sheets['30列验证']
  eq(s.max_row, 3, '30 列表的 max_row = 3')
  eq(s.max_column, 30, '30 列表的 max_column = 30')
  eq(s.values.Z1, '列26', '第 26 列是 Z1 = 列26')
  eq(s.values.AA1, '列27', '第 27 列是 AA1 = 列27（成功越过 Z）')
  eq(s.values.AB1, '列28', '第 28 列是 AB1 = 列28')
  eq(s.values.AD1, '列30', '第 30 列是 AD1 = 列30')
  eq(s.values.AA2, 27, 'AA2 的数字 27 正确')
  eq(s.auto_filter, 'A1:AD3', '自动筛选范围到 AD（列名换算正确）')
  eq(s.freeze_panes, 'A2', '30 列表同样冻结首行')
  eq(s.widths.AA, 9, 'AA 列宽 9（列宽映射也跟上了列名换算）')
}

section('11. sheet 名边界：非法字符 / 截断 / 重名 / 空名')
{
  const got = names.sheetnames
  eq(got.length, 5, '5 个 sheet 都在')
  eq(got[0], 'a-b-c-d-e-f-g-h', '非法字符 \\ / ? * [ ] : 全被替换成 -')
  eq(got[1], '推荐名单', '正常名单不动')
  eq(got[2], 'Sheet1', '空白名兜底成 Sheet1')
  eq(got[3], '推荐名单(2)', '重名自动加序号')
  eq(got[4].length, 31, `超长名被截断到 31 字符（实际 ${got[4].length}）`)
}

section('12. 纯函数：同样输入必须产出逐字节相同的字节')
{
  // ZIP 里如果写了当前时间戳，两次导出就会不一样 —— 那样「导出两次结果不同」
  // 这种问题永远查不清。这里用字节比较把它钉住。
  const a = buildCandidateWorkbook(ROWS, { ...OPTIONS, preset: 'full' })
  const b = buildCandidateWorkbook(ROWS, { ...OPTIONS, preset: 'full' })
  ok(Buffer.isBuffer(a), 'buildCandidateWorkbook 返回的是 Buffer')
  ok(a.equals(b), '两次调用产出完全相同的字节（时间戳固定、无随机序）')
  ok(a.length > 1000, `产物有实际体积（${a.length} 字节）`)
  eq(a.subarray(0, 2).toString('latin1'), 'PK', '产物以 ZIP 魔数 PK 开头')

  // 空名单也不能崩：表头还在，只是没有数据行
  const empty = buildCandidateWorkbook([], { preset: 'brief' })
  fs.writeFileSync(path.join(tmpDir, 'empty.xlsx'), empty)
  const rep = inspect(path.join(tmpDir, 'empty.xlsx'))
  ok(rep.ok, '空名单也能被 openpyxl 打开')
  eq(rep.sheets['推荐名单'].max_row, 1, '空名单时只剩表头一行')
  eq(rep.sheets['推荐名单'].max_column, 14, '空名单时列数不变')
  eq(rep.sheets['推荐名单'].auto_filter, null, '只有表头时不加自动筛选')
  ok(String(rep.sheets['导出信息'].values.B4).includes('0 条'), '空名单时人数写「0 条」')
}

section('13. 含下划线的文本原样往返（`_xHHHH_` 的取舍见 xlsx.ts 注释）')
{
  // 这里**不是**在验 OOXML 的 `_xHHHH_` 转义（那层 openpyxl 不实现，验不了）。
  // 验的是：带下划线的普通文本（`AI_x_2024`、`项目_a`）必须原样往返，
  // 也就是「我们没有任何"顺手把 _x 改掉"的逻辑」。
  const probePath = path.join(tmpDir, 'probe.xlsx')
  fs.writeFileSync(
    probePath,
    buildCandidateWorkbook(
      [{ name: 'AI_x_2024', school: '_x0041_ 大学', experience: '项目_a 与 项目_b' }],
      { preset: 'brief', positionTitle: '探针', now: new Date(2026, 1, 11, 10, 30) }
    )
  )
  const rep = inspect(probePath)
  ok(rep.ok, '探针产物能被 openpyxl 打开')
  const s = rep.sheets['推荐名单']
  eq(s.values.B2, 'AI_x_2024', 'AI_x_2024 原样往返')
  eq(s.values.G2, '_x0041_ 大学', '字面 "_x0041_" 原样往返（openpyxl 侧如此，已在 xlsx.ts 记下取舍）')
  eq(s.values.K2, '项目_a 与 项目_b', '经历里的 _a / _b 原样往返')
}

// ---------------------------------------------------------- 5. 汇总
console.log(`\n=== ${pass} 项通过，${fail} 项失败 ===`)
if (fail > 0) {
  console.log('失败项：')
  failures.forEach((f) => console.log(`  · ${f}`))
}
cleanup()
process.exit(fail > 0 ? 1 : 0)
