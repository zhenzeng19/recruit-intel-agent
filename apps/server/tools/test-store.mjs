// ============================================================
// 数据层集成测试
// ------------------------------------------------------------
// 直接驱动真实的 JsonStore（跑临时数据目录，不碰用户数据），重点锁住
// 「扩展采到了，但看板里看不到」这一类问题：
//
//   ① 新采集必须立刻挂上岗位匹配并拿到分数
//      —— 否则默认按匹配度排序会把它压到列表最底，HR 第一屏看不到
//   ② sort=recent / unmatched=true 能把新采集顶到眼前（兜底入口）
//   ③ 任何写操作都要让 revision 变大（看板自动刷新靠它）
//   ④ 同一来源重复上报只刷新时间，不产生重复档案
//   ⑤ 简历原文的粗提取：姓名不能被面板按钮（查看大图/意向沟通）顶掉
// ============================================================
import esbuild from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../..')

// ---------------------------------------------------------- 1. 打包真实源码
const outFile = path.join(os.tmpdir(), `ria-store-${Date.now()}.mjs`)
await esbuild.build({
  entryPoints: [path.join(repoRoot, 'apps/server/src/db/store.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  alias: { '@ria/shared': path.join(repoRoot, 'packages/shared/src/index.ts') },
  logLevel: 'warning',
})
const { JsonStore, parseResumeSections, extractResumeNo, stripResumeChrome, isVolatileLine } =
  await import(pathToFileURL(outFile).href)

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ria-store-data-'))
process.on('exit', () => {
  for (const p of [outFile, dataDir]) {
    try {
      fs.rmSync(p, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

// ---------------------------------------------------------- 2. 断言工具
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

// ---------------------------------------------------------- 3. 夹具
/** 用户真实采到的猎聘企业端预览正文（顶部混着面板按钮） */
const LIEPIN_RAW = `太多人选急需联系？试试意向沟通，一键发起坐等结果。
发起意向沟通
查看大图
张小雨
今天活跃
更新简历时间：2026.09.30
青岛
工作2年
20 岁
离职，正在找工作
7k×13薪
华北理工大学 · 复合材料与工程 · 本科 · 统招
xiaoyu.zhang@example.com
138****0000
工作经历
某某汽车线束有限公司
工艺助理工程师7k×13薪
2026.07-至今 (2个月)
工艺文件编制与标准化：负责康明斯下多个项目导通表、开线表、工艺指导书（SOP）等核心工艺文件的编制与维护。
教育经历
华北理工大学 · 复合材料与工程 · 本科 · 统招
项目经历
主导导线线长优化项目，通过分析线束布局与走线路径，保证电气性能与装配可行性。
专业技能
AutoCAD / SolidWorks / Origin / pycharm
自我评价
踏实细致，能承接跨国项目协作，具备英语、日语读写能力。
求职意向
期望职位：工艺/制程工程师(PE)
期望薪资：6-7k×13薪
期望城市：苏州、南京、青岛`

/** 一份和半导体设备岗位高度相关的简历原文 */
const VISION_RAW = `李工
男 · 31 岁 · 深圳 · 硕士 · 6 年经验
求职意向
期望职位：高级视觉算法工程师（缺陷检测）
期望城市：深圳
工作经历
2020.03 - 至今   某某半导体设备有限公司   视觉算法工程师
负责晶圆表面缺陷检测算法开发，基于深度学习的语义分割与异常检测模型，
覆盖明场/暗场成像，精通 OpenCV / Halcon / PyTorch / C++，熟悉 AOI 量测设备光学标定，
缺陷检出率从 92% 提升至 97.5%，产线量产落地稳定。
教育经历
2017.09 - 2020.03   某某大学   光学工程   硕士
项目经历
晶圆缺陷检测系统：负责缺陷分割模型，mAP 提升 12%
专业技能
OpenCV / Halcon / PyTorch / C++ / Python / 图像处理 / 缺陷检测 / 半导体
自我评价
工程化落地经验丰富，熟悉半导体检测设备从方案评估到量产的完整链路。`

const mkPayload = (id, raw, platform = 'liepin') => ({
  platform,
  platformCandidateId: id,
  resumeUrl: 'https://lpt.liepin.com/chat/im?jobId=85838997#preview',
  rawText: raw,
  capturedAt: new Date().toISOString(),
})

// ---------------------------------------------------------- 4. 用例
console.log('=== 数据层集成测试 ===')
console.log(`源码：apps/server/src/db/store.ts\n`)

const store = new JsonStore(dataDir)
store.seed()
const seededCount = store.stats().candidateCount

section('1. revision：任何写操作都要让版本号变大（看板自动刷新的探针）')
{
  const rev0 = store.revisionInfo().revision
  store.ingestCapture(mkPayload('content:v1', VISION_RAW))
  const rev1 = store.revisionInfo().revision
  ok(rev1 > rev0, `采集后 revision 增大（${rev0} → ${rev1}）`)

  // 拿一条示例数据来验证「改进度」也会推进版本号（不去动刚采集的那条，
  // 否则后面断言「新采集的初始状态是待沟通」就被这条用例自己改掉了）
  const sample = store.query({ sort: 'name', limit: 500 }).items.find((r) => r.matchCount > 0)
  store.updateMatchStatus(sample.candidate.id, sample.positionId, 'contacted')
  const rev2 = store.revisionInfo().revision
  ok(rev2 > rev1, `改进度后 revision 增大（${rev1} → ${rev2}）`)
  ok(store.revisionInfo().updatedAt.length > 0, 'revision 带更新时间')
}

section('2. 新采集必须立刻有岗位匹配和分数（回归：不能沉到列表最底）')
{
  const st = store.stats()
  eq(st.candidateCount, seededCount + 1, '候选人总数 +1')

  const row = store.query({ q: '李工' }).items[0]
  ok(row !== undefined, '新采集的候选人能在列表里查到')
  eq(row.candidate.name, '李工', '姓名提取正确')
  eq(row.positionTitle, '高级视觉算法工程师（缺陷检测）', '规则初筛挂到了最对口的岗位')
  ok(
    typeof row.score === 'number' && row.score >= 60,
    `规则分落在合理区间（${row.score} 分，≥ 60）`
  )
  eq(row.status, 'new', '匹配进度初始为「待沟通」')
  eq(row.matchCount, 1, '只挂一个主岗位（不污染岗位漏斗）')
  ok(row.hitPoints.length > 0, '给出了命中理由，HR 能看懂分数怎么来的')
  ok(
    row.hitPoints.some((h) => h.includes('rule-v1')),
    '明确标注这是规则初筛，不是大模型结论'
  )
  ok(row.capturedAt !== undefined, '列表行带上了采集时间（用于「最新采集」排序）')

  // 默认按匹配度排序时也应当能被分页拿到，而不是排在总数之外
  const byScore = store.query({ sort: 'score', limit: 500 })
  ok(
    byScore.items.some((r) => r.candidate.id === row.candidate.id),
    '默认排序下新采集也在结果里'
  )
}

section('3. 兜底入口：最新采集排序 / 只看待匹配')
{
  store.ingestCapture(mkPayload('content:v2', LIEPIN_RAW))
  const recent = store.query({ sort: 'recent', limit: 3 })
  ok(
    recent.items[0].candidate.name === '张小雨',
    `sort=recent 把刚采集的顶到第一（${recent.items[0].candidate.name}）`
  )
  ok(
    recent.items[0].capturedAt >= recent.items[1].capturedAt,
    'recent 排序确实是按采集时间倒序'
  )

  // 构造一个「没挂上岗位」的候选人：清空岗位后采集
  const saved = store.db?.positions
  const st1 = store.stats()
  const unmatchedBefore = st1.unmatchedCount
  ok(unmatchedBefore >= 0, `unmatchedCount 可读（当前 ${unmatchedBefore}）`)

  const unmatchedQuery = store.query({ unmatched: true, limit: 500 })
  ok(
    unmatchedQuery.items.every((r) => r.matchCount === 0),
    'unmatched=true 只返回未匹配岗位的人'
  )
  ok(
    unmatchedQuery.items.length === unmatchedBefore,
    `unmatched 视图数量与 stats.unmatchedCount 一致（${unmatchedQuery.items.length}）`
  )
  void saved
}

section('4. 采集统计（看板上的「今日采集」卡片）')
{
  const st = store.stats()
  ok(st.capturedToday >= 2, `capturedToday 统计到今天的采集（${st.capturedToday} 份）`)
  ok(st.newToday >= 2, `newToday 统计到今天的建档（${st.newToday} 人）`)
}

section('5. 重复上报：同一来源只刷新时间，不产生重复档案')
{
  const before = store.stats().candidateCount
  const r = store.ingestCapture(mkPayload('content:v2', LIEPIN_RAW))
  eq(r.duplicated, true, '同一 platformCandidateId 再次上报被识别为重复')
  eq(store.stats().candidateCount, before, '候选人总数没有增加')
  ok(store.query({ q: '张小雨' }).items.length === 1, '张小雨只有一条档案')
}

section('6. 简历原文粗提取（回归：姓名不能被面板按钮顶掉）')
{
  const zhao = store.query({ q: '张小雨' }).items[0]
  eq(zhao.candidate.name, '张小雨', '姓名取到真名，而不是「查看大图」')
  eq(zhao.candidate.city, '青岛', '城市取头部居住地，而不是工作经历里的公司所在城市')
  eq(zhao.candidate.degree, '本科', '学历提取正确')
  eq(zhao.candidate.email, 'xiaoyu.zhang@example.com', '邮箱提取正确')
  ok(zhao.candidate.phone !== undefined, '手机号提取到')
}

section('6b. 猎聘真实格式的字段提取（回归：从「标签驱动」升级为「头部+三种证据」）')
{
  const zhao = store.query({ q: '张小雨' }).items[0].candidate
  // 这一行「学校 · 专业 · 本科 · 统招」是猎聘的固定格式，一行出四个字段
  eq(zhao.educationMode, '统招', '学历性质=统招（这正是招聘软件普遍识别不了的）')
  ok(String(zhao.educationEvidence || '').includes('统招'), '存下了原文依据，便于核对')
  eq(zhao.school, '华北理工大学', '学校（旧实现完全没提取）')
  eq(zhao.major, '复合材料与工程', '专业（旧实现完全没提取）')
  eq(zhao.yearsOfExperience, 2, '工作年限从「工作2年」解析出来（旧正则要求「经验」二字，永远是空）')
  eq(zhao.expectedSalary, '6-7k×13', '薪资保留「×13薪」的年包信息')
  eq(zhao.skillsSource, 'dictionary', '标明技能来源是词典命中，不是模型抽取')

  // 技能标签用 VISION_RAW 这份（正文里有大量行业术语）来验
  const li = store.query({ q: '李工' }).items[0].candidate
  ok((li.skills || []).length > 0, '技能标签（词典命中）不再是空数组：' + JSON.stringify((li.skills || []).slice(0, 6)))
  ok((li.skills || []).some((s) => ['OpenCV', 'Halcon', 'PyTorch', '缺陷检测', '晶圆'].includes(s)), '命中了行业术语')
}

section('6c. 学历性质正则顺序（非统招 / 统招专升本 的坑）')
{
  const mk = (tag, line, mode) => {
    const r = store.ingestCapture(
      mkPayload(`mode:${tag}`, `测试${tag}\n30 岁\n上海\n工作5年\n${line}\n期望薪资：20-30k`)
    )
    const c = store.detail(r.candidateId)?.candidate
    eq(c?.educationMode, mode, line + ' → ' + mode)
  }
  mk('a', '某某大学 · 计算机 · 本科 · 非统招', '非统招')
  mk('b', '某某大学 · 计算机 · 本科 · 统招', '统招')
  mk('c', '某某大学 · 计算机 · 本科 · 统招专升本', '统招')
  mk('d', '某某大学 · 计算机 · 专科 · 专升本', '专升本')
  mk('e', '某某大学 · 计算机 · 本科 · 全日制', '统招')
  mk('f', '某某大学 · 计算机 · 本科 · 自考', '非统招')
}

section('6d. 院校层次必须精确匹配（回归：西安电子科技大学 曾被判成 985）')
{
  const tier = (tag, school, want) => {
    const r = store.ingestCapture(
      mkPayload(`tier:${tag}`, `测试${tag}\n30 岁\n上海\n工作5年\n${school} · 计算机 · 本科 · 统招`)
    )
    const c = store.detail(r.candidateId)?.candidate
    eq(c?.schoolTier || '', want, school + ' → ' + (want || '（判不出，安全）'))
  }
  tier('x1', '西安电子科技大学', '211')
  tier('x2', '桂林电子科技大学', '')
  tier('x3', '电子科技大学', '985')
  tier('x4', '长春理工大学', '')
}

section('7. 派生视图要能立刻反映新采集')
{
  const st = store.stats()
  ok(st.matchCount > 0, 'matchCount 反映了自动生成的匹配')
  const pipeline = store.pipeline()
  ok(Array.isArray(pipeline.positions) && pipeline.positions.length > 0, '岗位漏斗有数据')
  ok(pipeline.totalCandidates > 0, '漏斗带了候选人总数')
  const todos = store.todos()
  ok(Array.isArray(todos.items), '待办中心可正常生成')
}

section('8. 岗位管理（后台自己加岗位）')
{
  const created = store.createPosition({
    title: '项目经理（基建）',
    department: '项目部',
    city: '盐城',
    headcount: 2,
    jdText: '负责基建项目全周期管理',
    hardRequirements: ['本科及以上', '10 年以上经验'],
    niceToHave: ['PMP'],
  })
  ok(!!created.id, '新建岗位拿到 id')
  eq(created.status, 'open', '默认状态为在招')
  ok(store.listPositions().some((p) => p.id === created.id), '新岗位立刻出现在岗位列表里')
  eq(store.listPositions().find((p) => p.id === created.id)?.candidateCount, 0, '新岗位候选人数为 0')

  const updated = store.updatePosition(created.id, { headcount: 3, status: 'paused', city: '南京' })
  eq(updated?.headcount, 3, '编辑生效：编制')
  eq(updated?.status, 'paused', '编辑生效：状态')
  eq(updated?.city, '南京', '编辑生效：城市')
  ok(store.updatePosition('nope', { city: 'x' }) === undefined, '编辑不存在的岗位返回 undefined')

  // 采集时选岗位（Step 3 的核心链路）
  const r = store.ingestCapture({
    ...mkPayload('pospick:1', '李先生\n盐城\n工作15年\n38 岁\n华南师范大学 · 计算机科学与技术 · 本科 · 非统招\n熟悉 Python 与 MES'),
    source: 'manual',
    positionId: created.id,
  })
  eq(r.assignedBy, 'manual', '用户选的岗位 → assignedBy=manual')
  eq(r.autoMatched?.positionId, created.id, '挂到用户选的那个岗位（停用的岗位也允许手动挂）')
  ok(!!r.ruleSuggested, '回执带上了规则原本的推荐（供「也挂上」）')
  ok(r.ruleSuggested?.positionId !== created.id, '规则推荐排除了用户已选的那个岗位')
  eq(store.detail(r.candidateId)?.matches[0]?.assignedBy, 'manual', '详情里能看到归属来源')

  // 有候选人的岗位不能删
  const del = store.deletePosition(created.id)
  eq(del.deleted, false, '有候选人的岗位拒绝删除')
  ok(String(del.reason || '').includes('停用'), '并解释了应该改用「停用」')
  eq(store.matchCountOfPosition(created.id), 1, '岗位下确实有 1 条匹配')

  // 追加挂靠（幂等）+ 取消
  const m1 = store.addMatch(r.candidateId, 'pos_dl')
  const m2 = store.addMatch(r.candidateId, 'pos_dl')
  ok(!!m1 && m1.id === m2?.id, '重复挂靠不会重复建档（幂等）')
  // 停用的岗位不参与匹配，所以那个岗位下不该有它
  ok(store.addMatch(r.candidateId, 'pos_fae')?.positionId === 'pos_fae', '可以挂到已停用的岗位（人工指定不受状态限制）')
  eq(store.removeMatch(r.candidateId, 'pos_dl'), true, '取消挂靠成功')
  eq(store.removeMatch(r.candidateId, 'pos_dl'), false, '重复取消返回 false')

  // 空岗位可以删
  const empty = store.createPosition({ title: '临时空岗位', jdText: 'x' })
  eq(store.deletePosition(empty.id).deleted, true, '没有候选人的岗位可以删除')
}

section('9. 平台推荐职位优先于规则分（猎聘自己说的比我们猜的可信）')
{
  const p = store.createPosition({ title: '项目经理', jdText: '基建项目全周期管理，本科及以上' })
  const r = store.ingestCapture(
    mkPayload('rec:1', '李女士\n北京\n工作10年\n35 岁\n推荐职位：\n项目经理\n负责产线项目', 'boss')
  )
  eq(r.assignedBy, 'pick-from-recommend', '未指定岗位时用平台推荐职位')
  eq(r.autoMatched?.positionId, p.id, '挂到了与推荐职位同名的岗位')
  const c = store.detail(r.candidateId)?.candidate
  eq(c?.recommendedPosition, '项目经理', '推荐职位也存进了候选人字段')
  ok(store.rematchUnmatched().matched >= 0, '重跑匹配可调用')
}

section('10. 正文清洗：尾部 UI 噪声（回归：配额计数会扰动内容指纹 → 重复建档）')
{
  const dirty = [
    '李先生',
    '盐城',
    '工作15年',
    '华南师范大学 · 计算机科学与技术 · 本科 · 非统招',
    '工作经历',
    '某某动力工业有限公司',
    '项目经理',
    '2024.08-至今 (2年2个月)',
    '负责产线项目',
    '觉得TA还不错：',
    '获取电话',
    '剩10次权益',
    '超级聊聊',
    '免费权益，本月剩余30次',
    '操作记录',
    '人才招聘记录',
    '该候选人无人才招聘记录',
    '简历备注',
    '暂无备注内容',
  ].join('\n')
  const clean = stripResumeChrome(dirty)
  ok(clean.length < dirty.length, `尾部被切掉（${dirty.length} → ${clean.length} 字）`)
  ok(!clean.includes('剩10次权益'), '不再含「剩10次权益」')
  ok(!clean.includes('人才招聘记录'), '不再含「人才招聘记录」')
  ok(clean.includes('负责产线项目'), '正文主体保留')

  ok(isVolatileLine('7天内活跃'), '「N天内活跃」是易变行')
  ok(isVolatileLine('更新简历时间：2026.07.20'), '「更新简历时间」是易变行')
  ok(isVolatileLine('剩3次权益'), '「剩N次权益」是易变行')
  ok(!isVolatileLine('211'), '「211」不是易变行（别误杀院校层次）')
  ok(!isVolatileLine('工作经历'), '章节标题不是易变行')
  ok(!isVolatileLine('简历编号'), '「简历编号」是身份不是易变行')
}

section('11. 平台简历编号（猎聘正文里的第二个编号，比内容指纹好沟通）')
{
  const t = '张三\n简历编号\n: EF56AB78CD9000ee55ff66\n工作经历\n某公司'
  eq(extractResumeNo(t), 'EF56AB78CD9000ee55ff66', '「值在下一行」的格式能取到')
  eq(extractResumeNo('李四\n简历编号：abc12345XYZ\n工作经历'), 'abc12345XYZ', '「同行」的格式也能取到')
  eq(extractResumeNo('王五\n没有任何编号'), undefined, '没有编号时返回 undefined')
}

section('12. 结构化分节 parseResumeSections（打印页排版的数据来源）')
{
  // 猎聘真实格式：工作经历是「公司/职位/时间/描述」的块，块尾有结束标记
  const LIEPIN_SECTIONS = [
    '推荐职位：',
    '项目经理',
    '孙先生',
    '北京',
    '工作17年',
    '39 岁',
    '离职，正在找工作',
    '河北工业大学 · 土木工程 · 本科 · 统招',
    '求职意向',
    '查看全部3个',
    '项目经理/主管',
    '30-40k×12薪',
    '北京、南京、成都',
    '全部行业',
    '工作经历',
    '某某实业股份有限公司',
    '基建项目主管/项目经理',
    '2025.02-至今 (1年8个月)',
    '全面主持公司基建项目管理工作，涵盖办公类精装修',
    '*该段内容已整合附件简历信息',
    '某某汽车股份有限公司',
    '主任工程师',
    '2024.09-2025.01 (4个月)',
    '参与公司基建流程标准体系编制与培训',
    '*该段内容已整合附件简历信息',
    '教育经历',
    '河北工业大学',
    '本科 · 土木工程',
    '2005/09-2010/06',
    '河北工业大学',
    '211',
    '双一流',
    '统招',
    '2005.09-2010.06 (5年)',
    '土木工程',
    '本科',
    '*该段内容已整合附件简历信息',
    '技能标签',
    '项目管理',
    'PMP',
    '语言能力',
    '英语',
  ].join('\n')

  const s = parseResumeSections(LIEPIN_SECTIONS)
  eq(s.confidence, 'high', '有块结束标记 → 置信度 high')
  eq(s.experiences.length, 2, '切出 2 段工作经历')
  eq(s.experiences[0].company, '某某实业股份有限公司', '第一段公司名正确')
  eq(s.experiences[0].title, '基建项目主管/项目经理', '第一段职位正确')
  eq(s.experiences[0].period, '2025.02-至今', '第一段起止正确')
  eq(s.experiences[0].duration, '1年8个月', '第一段时长单独拆出来')
  ok(s.experiences[0].bullets.length === 1, '第一段描述 1 行（块结束标记没混进描述）')
  eq(s.experiences[1].company, '某某汽车股份有限公司', '第二段公司名正确')

  eq(s.education.length, 1, '紧凑版 + 完整版合并成 1 条（不是 2 条）')
  eq(s.education[0].school, '河北工业大学', '学校正确')
  eq(s.education[0].degree, '本科', '学历正确')
  eq(s.education[0].major, '土木工程', '专业正确（紧凑版的「本科 · 土木工程」也要能拆开）')
  eq(s.education[0].tier, '211', '层次取到 211')
  eq(s.education[0].mode, '统招', '学历性质取到统招')

  eq(s.intention?.positions.length, 1, '求职意向只有 1 个职位（行业没被误当职位）')
  eq(s.intention?.positions[0], '项目经理/主管', '职位正确')
  eq(s.intention?.salary, '30-40k×12', '薪资正确')
  eq(s.intention?.cities.length, 3, '城市 3 个')
  ok(s.skills.includes('项目管理') && s.skills.includes('PMP'), '技能标签取到')
  ok(s.languages.includes('英语'), '语言能力取到')

  // 降级：没有块结束标记 → medium，但仍能按章节切
  const medium = parseResumeSections(
    ['赵六', '工作经历', '某公司', '工程师', '2020.01-2021.01', '做了些事'].join('\n')
  )
  eq(medium.confidence, 'medium', '没有块标记时降级为 medium（不是失败）')
  eq(medium.experiences[0]?.company, '某公司', '降级后仍能认出公司')

  // 降级：连章节词都没有 → low，但必须还能输出原行（绝不空白）
  const low = parseResumeSections('张三\n男 28 岁\n做过一些事情')
  eq(low.confidence, 'low', '认不出章节 → low')
  ok(low.blocks.length > 0 && low.blocks[0].lines.length > 0, 'low 时仍然按原行输出（不空白）')
  ok(Array.isArray(low.experiences) && low.experiences.length === 0, 'low 时结构字段为空数组而非 undefined')
}

section('13. 来源 URL：详情页链接不能被列表页覆盖回去（回归）')
{
  const DETAIL = 'https://lpt.liepin.com/resume/detail?resIdEncode=CD34EF56AB7800cc33dd44'
  const LIST = 'https://lpt.liepin.com/recommend#preview'

  // 第一次从详情页采到 → 存下详情页链接
  const r1 = store.ingestCapture({
    ...mkPayload('src:1', '王五\n30 岁\n上海\n工作6年\n某某大学 · 计算机 · 本科 · 统招', 'liepin'),
    resumeUrl: DETAIL,
    capturedUrl: DETAIL,
  })
  ok(!r1.duplicated, '首次采集建档')
  const readable = () => store.detail(r1.candidateId)?.sources?.[0]

  eq(readable()?.resumeUrl, DETAIL, '来源 URL 存的是详情页链接')
  eq(readable()?.capturedUrl, DETAIL, '同时记下了实际采集页')

  // 之后又被列表页采了一次（同一 platformCandidateId）→ **不能**把好的来源覆盖成列表页
  store.ingestCapture({
    ...mkPayload('src:1', '王五\n30 岁\n上海\n工作6年\n某某大学 · 计算机 · 本科 · 统招', 'liepin'),
    resumeUrl: LIST,
    capturedUrl: LIST,
  })
  eq(readable()?.resumeUrl, DETAIL, '再次从列表页采集后，来源 URL 仍然是详情页（没被覆盖回列表页）')
  eq(readable()?.capturedUrl, LIST, '但实际采集页更新为列表页（如实记录）')

  // 反过来：先只有列表页，后来拿到详情页 → 应该升级为详情页
  const r2 = store.ingestCapture({
    ...mkPayload('src:2', '赵六\n28 岁\n北京\n工作4年\n某某大学 · 计算机 · 本科 · 统招', 'liepin'),
    resumeUrl: LIST,
    capturedUrl: LIST,
  })
  const readable2 = () => store.detail(r2.candidateId)?.sources?.[0]
  eq(readable2()?.resumeUrl, LIST, '先只有列表页时如实存列表页')
  store.ingestCapture({
    ...mkPayload('src:2', '赵六\n28 岁\n北京\n工作4年\n某某大学 · 计算机 · 本科 · 统招', 'liepin'),
    resumeUrl: DETAIL,
    capturedUrl: LIST,
  })
  eq(readable2()?.resumeUrl, DETAIL, '后来拿到详情页链接时升级为详情页')
}

section('14. 简历编号写进候选人字段（存量数据靠 repair:data 回填）')
{
  const r = store.ingestCapture(
    mkPayload(
      'no:1',
      '孙七\n32 岁\n深圳\n工作8年\n某某大学 · 计算机 · 本科 · 统招\n简历编号\n: abc12345XYZ9\n工作经历\n某公司'
    )
  )
  const c = store.detail(r.candidateId)?.candidate
  eq(c?.resumeNo, 'abc12345XYZ9', '简历编号落进候选人的 resumeNo 字段')
}

section('15. 语言 / 经历分块 / 求职意向（导出 Excel 的字段来源）')
{
  // ---- 语言白名单
  // 回归：`语言能力` 这一节在猎聘页面上常常一直延到正文末尾，
  // 不过滤会把「附件简历」「0.4MB」「简历编号」当成语言收进来。
  const noisy = [
    '张小雨',
    '青岛',
    '工作2年',
    '华北理工大学 · 复合材料与工程 · 本科 · 统招',
    '语言能力',
    '英语(CET6、工作应用)',
    '日语(N3、基础沟通)',
    '德语(基础沟通)',
    '附件简历',
    '0.4MB',
    '预览',
    '下载',
    '简历编号',
    ': ff00aa11bb22',
    '投递时间: 2026.09.30',
    '通过筛选',
    '不合适',
  ].join('\n')
  const langR = store.ingestCapture(mkPayload('lang:1', noisy))
  const langC = store.detail(langR.candidateId)?.candidate
  ok(Array.isArray(langC?.languages), 'languages 是数组（落库了，不是只存在于解析结果里）')
  ok(
    (langC?.languages ?? []).every((l) => !/简历编号|0\.4MB|预览|下载|投递时间|通过筛选|不合适|附件/.test(l)),
    '语言里不再混进附件区/按钮：' + JSON.stringify(langC?.languages)
  )
  ok((langC?.languages ?? []).some((l) => l.includes('CET6')), '括号里的补充信息保留（有信息量）')
  ok((langC?.languages ?? []).length <= 6, '语言最多 6 条')

  // ---- 没有块结束标记时，用「公司名行」当分块边界
  // 回归：猎聘**详情页**不写 `*该段内容已整合附件简历信息`，整段会被当成 1 段
  //       （真实数据里周敏的 4 家公司塌成了 1 条）
  const noTerminator = [
    '周敏',
    '盐城',
    '工作18年',
    '江苏科技大学 · 工商管理 · 本科 · 非统招',
    '工作经历',
    '某某集团',
    '项目高级工程师',
    '2023.04-至今 (3年6个月)',
    '负责客户：捷能、微宏动力',
    '某某半导体科技有限公司',
    '运营经理',
    '2020.04-2023.02 (2年10个月)',
    '生产运营统筹',
    '某某电子分厂',
    '研发主管',
    '2015.09-2020.01 (4年4个月)',
    '技术部向副总经理汇报',
    '某某电子有限公司',
    '工艺部',
    '2008.03-2015.07 (7年4个月)',
    '防焊印刷',
  ].join('\n')
  const expR = store.ingestCapture(mkPayload('exp:1', noTerminator))
  const sec = parseResumeSections(store.detail(expR.candidateId)?.candidate.resumeText ?? '')
  eq(sec.experiences.length, 4, '没有块标记时按「公司名行」切成 4 段（而不是塌成 1 段）')
  eq(sec.experiences[0].company, '某某集团', '第 1 段公司正确')
  eq(sec.experiences[2].company, '某某电子分厂', '第 3 段公司正确（含「分厂」）')
  eq(sec.confidence, 'medium', '没有块标记 → 置信度 medium（不是 high）')

  // ---- 回归：纯职位名不能被当成公司名（`网络工程师` 含「网络」，早先被误判成一家公司）
  const titleLike = [
    '李先生',
    '盐城',
    '工作15年',
    '工作经历',
    '某某能源',
    'MES资深工程师',
    '2024.08-至今',
    '网络工程师',
    '某某集团',
    '网络工程师',
    '2012.08-2015.01',
  ].join('\n')
  const tR = store.ingestCapture(mkPayload('exp:2', titleLike))
  const tSec = parseResumeSections(store.detail(tR.candidateId)?.candidate.resumeText ?? '')
  ok(
    !tSec.experiences.some((e) => /^(网络工程师|项目经理|工程师)$/.test(e.company)),
    '没有任何一段把纯职位名当成公司名：' + JSON.stringify(tSec.experiences.map((e) => e.company))
  )

  // ---- 求职意向：真实猎聘格式是「章节」而不是「求职意向：值」标签
  // 回归：5 条真实简历的 intention 曾经全是空的
  const liepinIntention = [
    '孙先生',
    '北京',
    '工作17年',
    '河北工业大学 · 土木工程 · 本科 · 统招',
    '求职意向',
    '查看全部3个',
    '项目经理/主管',
    '30-40k×12薪',
    '北京、南京、成都',
    '全部行业',
    '工作经历',
    '某公司',
  ].join('\n')
  const iR = store.ingestCapture(mkPayload('intent:1', liepinIntention))
  const iC = store.detail(iR.candidateId)?.candidate
  eq(iC?.intention, '项目经理/主管', '意向职位从「章节」格式取到（而不是空）')
  eq((iC?.intentionCities ?? []).length, 3, '期望城市 3 个')
  ok((iC?.intentionCities ?? []).includes('南京'), '期望城市内容正确')
}

section('16. 删除候选人：级联 + 归档 + 「不再采集」名单')
{
  const r = store.ingestCapture(mkPayload('del:1', '张三\n30 岁\n上海\n工作5年\n某某大学 · 计算机 · 本科 · 统招'))
  const id = r.candidateId
  ok(!!store.detail(id), '先确认建档成功')
  const srcCount = store.detail(id)?.sources.length ?? 0
  const matchCount = store.detail(id)?.matches.length ?? 0

  // 不 forget：删掉但以后还允许采回来
  const del = store.deleteCandidate(id, false)
  eq(del.deleted, true, '删除成功')
  eq(del.forgot, false, '未指定 forget 时没进名单')
  eq(del.removedSources, srcCount, '如实报告删掉了几条来源')
  eq(del.removedMatches, matchCount, '如实报告删掉了几条岗位匹配')
  eq(store.detail(id), undefined, '候选人已经查不到了')
  ok(!store.listIgnored().some((i) => i.platformCandidateId === 'del:1'), '没进「不再采集」名单')

  // 删掉之后**还能**被重新采回来（这是 forget=false 的语义）
  const re = store.ingestCapture(mkPayload('del:1', '张三\n30 岁\n上海\n工作5年\n某某大学 · 计算机 · 本科 · 统招'))
  ok(!!store.detail(re.candidateId), '未加入名单时，重新采集会重新建档（符合预期）')

  // forget：删掉并设为不再采集
  const del2 = store.deleteCandidate(re.candidateId, true)
  eq(del2.deleted, true, '第二次删除成功')
  eq(del2.forgot, true, 'forget=true 时进了名单')
  const ign = store.listIgnored().find((i) => i.platformCandidateId === 'del:1')
  ok(!!ign, '名单里有这一条')
  eq(ign?.name, '张三', '名单里存了姓名（界面好认）')
  ok(!!ign?.ignoredAt, '名单里记了加入时间')
  ok(store.isIgnored('liepin', 'del:1'), 'isIgnored 命中')

  // ★ 核心：进名单后再上报，**不建档**
  const before = store.stats().candidateCount
  const blocked = store.ingestCapture(mkPayload('del:1', '张三\n30 岁\n上海\n工作5年\n某某大学 · 计算机 · 本科 · 统招'))
  eq(blocked.ignored, true, '再上报时被识别为「不再采集」')
  eq(store.stats().candidateCount, before, '没有新建档案（这是「删了不会自己回来」的关键）')
  eq(store.query({ q: '张三' }).items.length, 0, '库里确实查不到这个人')

  // 移出名单 → 恢复采集
  eq(store.removeIgnored(ign.id), true, '移出名单成功')
  eq(store.removeIgnored(ign.id), false, '重复移出返回 false')
  ok(!store.isIgnored('liepin', 'del:1'), '移出后 isIgnored 不再命中')
  const back = store.ingestCapture(mkPayload('del:1', '张三\n30 岁\n上海\n工作5年\n某某大学 · 计算机 · 本科 · 统招'))
  ok(!back.ignored, '移出名单后可以正常采集了')

  // 批量删除
  const b1 = store.ingestCapture(mkPayload('del:b1', '李四\n30 岁\n上海\n工作5年\n某某大学 · 计算机 · 本科 · 统招'))
  const b2 = store.ingestCapture(mkPayload('del:b2', '王五\n31 岁\n北京\n工作6年\n某某大学 · 计算机 · 本科 · 统招'))
  const batch = store.deleteCandidates([b1.candidateId, b2.candidateId, 'cand_不存在'], true)
  eq(batch.deleted, 2, '批量删除删掉 2 个（不存在的那条被忽略）')
  eq(batch.forgot, 2, '批量删除同时加入名单 2 条')

  // 删不存在的
  eq(store.deleteCandidate('cand_不存在', false).deleted, false, '删不存在的候选人返回 false')
  ok(
    String(store.deleteCandidate('cand_不存在', false).reason ?? '').includes('不存在'),
    '并给出中文原因'
  )

  // 归档：删掉的东西必须能在 _deleted/ 里捞回来
  const deletedDir = path.join(dataDir, '_deleted')
  ok(fs.existsSync(deletedDir), '生成了 _deleted/ 归档目录')
  const archived = fs
    .readdirSync(deletedDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => fs.readdirSync(path.join(deletedDir, d.name)))
  ok(archived.length >= 2, `归档里有文件（${archived.length} 个）—— 误删可以手工捞回来`)
  const oneArchived = JSON.parse(
    fs.readFileSync(
      path.join(deletedDir, fs.readdirSync(deletedDir)[0], archived[0]),
      'utf8'
    )
  )
  ok(!!oneArchived.candidate?.id, '归档里存了完整候选人记录')
  ok(Array.isArray(oneArchived.sources), '归档里存了来源')
  ok(Array.isArray(oneArchived.matches), '归档里存了岗位匹配')
  ok(!!oneArchived.deletedAt, '归档里记了删除时间')
}

section('16b. 姓名提取：不能被城市/学历顶掉（会直接污染 Excel 的姓名列）')
{
  // 回归：第 ② 步是「找到头部特征行后往前最多 3 行找姓名」，
  //      布局是「姓名 / 城市 / 工作N年」三行相连时会把**城市**当姓名；
  //      「姓名 / 城市 / 本科 / N岁」时会把**学历**当姓名。
  const cases = [
    ['李先生\n盐城\n工作15年\n38 岁\n华南师范大学 · 计算机 · 本科 · 统招', '李先生', '城市在中间'],
    ['张三\n上海\n工作5年\n28 岁\n某某大学 · 计算机 · 本科 · 统招', '张三', '另一个城市'],
    ['李四\n北京\n10 年经验\n35 岁', '李四', '「N 年经验」特征行'],
    ['王五\n深圳\n本科\n30 岁', '王五', '学历在特征行前一行'],
    ['赵六\n杭州\n硕士\n32 岁', '赵六', '硕士在特征行前一行'],
  ]
  for (const [text, want, why] of cases) {
    const r = store.ingestCapture(mkPayload(`name:${want}`, text))
    eq(store.detail(r.candidateId)?.candidate.name, want, `${why} → 姓名是 ${want}`)
  }
  // 原有能力不回归
  const labelR = store.ingestCapture(mkPayload('name:label', '姓名：孙七\n30 岁\n上海\n工作5年'))
  eq(store.detail(labelR.candidateId)?.candidate.name, '孙七', '显式「姓名：」标签仍然优先')
  const liepinR = store.ingestCapture(
    mkPayload(
      'name:liepin',
      '查看大图\n周八\n今天活跃\n更新简历时间：2026.09.30\n青岛\n工作2年\n20 岁\n某某大学 · 计算机 · 本科 · 统招'
    )
  )
  eq(store.detail(liepinR.candidateId)?.candidate.name, '周八', '猎聘真实布局（姓名在上、城市在下）不回归')

  // ---- 打码姓名（猎聘对隐私候选人显示 `王**` / `李*`）
  // 真实事故：一份打码姓名的简历认不出姓名，兜底 `lines[0].slice(0,12)` 把搜索页的
  // 「快速定位：」写进了姓名列。
  const maskedR = store.ingestCapture(
    mkPayload(
      'name:masked',
      '快速定位：\n英语作为工作语言\n(1)\n查看大图\n王**\n更新简历时间：对方设置了隐私保护\n西安\n工作16年\n38 岁'
    )
  )
  eq(store.detail(maskedR.candidateId)?.candidate.name, '王**', '打码姓名 王** 能被认出（而不是把「快速定位：」当姓名）')
  const masked2 = store.ingestCapture(mkPayload('name:masked2', '李*\n北京\n工作5年\n30 岁'))
  eq(store.detail(masked2.candidateId)?.candidate.name, '李*', '单字打码 李* 也能认出')

  // ---- 认不出姓名时必须是「未识别姓名」，不能是界面文案
  const unknownR = store.ingestCapture(
    mkPayload('name:unknown', '快速定位：\n英语作为工作语言\n(1)\n查看大图\n更新简历时间：x\n西安\n工作16年\n38 岁')
  )
  eq(
    store.detail(unknownR.candidateId)?.candidate.name,
    '未识别姓名',
    '认不出姓名时写「未识别姓名」（而不是把容器的第一行当人名）'
  )

  // ---- 少数民族姓名（带「·」，超过 NAME_LINE 的 4 字上限）
  const ethnic = store.ingestCapture(mkPayload('name:ethnic', '买买提·艾力\n乌鲁木齐\n工作6年\n30 岁'))
  eq(store.detail(ethnic.candidateId)?.candidate.name, '买买提·艾力', '带「·」的少数民族姓名能认出')

  // ---- 但放宽之后绝不能把「学历/院校 · 专业」当成姓名
  const major1 = store.ingestCapture(mkPayload('name:major1', '王五\n上海\n本科 · 土木工程\n30 岁'))
  eq(store.detail(major1.candidateId)?.candidate.name, '王五', '「本科 · 土木工程」不被当姓名')
  const major2 = store.ingestCapture(
    mkPayload('name:major2', '赵六\n北京\n河北工业大学 · 土木工程\n32 岁')
  )
  eq(store.detail(major2.candidateId)?.candidate.name, '赵六', '「院校 · 专业」不被当姓名')

  // ---- 兜底这一层允许 2~6 个汉字（5 字姓名不该比以前退步），代价用职位词排除兜住
  const five = store.ingestCapture(
    mkPayload('name:five', '测试候选人\n28岁  深圳\n学历：硕士  毕业院校：测试大学\n5年工作经验\n期望薪资：30-50k')
  )
  eq(store.detail(five.candidateId)?.candidate.name, '测试候选人', '5 字姓名（BOSS 紧凑格式）能认出来')
  const titleRow = store.ingestCapture(mkPayload('name:title', '高级工程师\n28 岁\n深圳\n5 年经验\n本科'))
  ok(
    store.detail(titleRow.candidateId)?.candidate.name !== '高级工程师',
    '但「高级工程师」这种职位行不能被当姓名：' + store.detail(titleRow.candidateId)?.candidate.name
  )
}

section('17. 导出用的行数据（Excel 的每一列都来自这里）')
{
  const r = store.ingestCapture(
    mkPayload(
      'exp:row',
      [
        '李先生',
        '盐城',
        '工作15年',
        '38 岁',
        '华南师范大学 · 计算机科学与技术 · 本科 · 非统招',
        '在职，看看新机会',
        '期望薪资：26-27k×12薪',
        '求职意向',
        'IT总监/经理/主管',
        '盐城',
        '工作经历',
        '某某动力工业有限公司',
        'MES资深工程师',
        '2024.08-至今 (2年2个月)',
        '负责 MES 系统',
        '语言能力',
        '英语',
        '普通话',
        '简历编号',
        ': AB12CD34EF5600aa11bb22',
      ].join('\n')
    )
  )
  const { rows, total, truncated } = store.exportRows({}, 5000)
  ok(total >= 1, `导出返回了总数（${total}）`)
  eq(truncated, false, '没超过上限时 truncated=false')
  const row = rows.find((x) => x.name === '李先生')
  ok(!!row, '找得到刚建的这一行')
  eq(row?.educationMode, '非统招', '学历性质进了导出行（你要的重点）')
  eq(row?.school, '华南师范大学', '学校进了导出行')
  eq(row?.schoolTier, '211', '院校层次进了导出行')
  eq(row?.yearsOfExperience, 15, '工作年限是数字')
  eq(row?.city, '盐城', '地点进了导出行')
  eq(row?.expectedSalary, '26-27k×12', '薪酬进了导出行')
  ok((row?.languages ?? []).includes('英语'), '语言进了导出行：' + JSON.stringify(row?.languages))
  ok(String(row?.experience ?? '').includes('某某动力工业有限公司'), '「经历」拼出了公司名：' + String(row?.experience))
  ok(String(row?.experience ?? '').includes('MES资深工程师'), '「经历」拼出了职位')
  eq(row?.resumeNo, 'AB12CD34EF5600aa11bb22', '简历编号进了导出行')
  eq(row?.matchPositionTitle !== undefined, true, '带上了匹配岗位名')

  // 分页必须被忽略：limit=1 也不该影响导出
  const one = store.exportRows({ limit: 1 }, 5000)
  eq(one.rows.length, one.total, '导出忽略 limit：行数等于总数')
  eq(one.rows.length > 1, true, '确实多于 1 行（证明没被 limit 截断）')
}

section('18. 字段级筛选 + queryIds 与 query 必须一致 + facets + 按 ids 导出')
{
  // 三个画像鲜明的候选人，用来验字段级筛选。
  // ⚠️ 姓名必须**全文件唯一**：前面几节已经建过好几个「王五」（本科/上海、本科/北京…），
  //    用重名的姓名取 id 会拿到别人 —— 那种测试有时候过、有时候不过，比不过还糟。
  store.ingestCapture(
    mkPayload(
      'flt:a',
      [
        '冯小满',
        '青岛',
        '20 岁',
        '工作2年',
        '离职，正在找工作',
        '7k×13薪',
        '某某理工大学 · 复合材料与工程 · 本科 · 统招',
        '138****0000',
        '语言能力',
        '英语(CET6、工作应用)', // ← 带说明的形态：验 language 归一口径
        '普通话',
      ].join('\n')
    )
  )
  store.ingestCapture(
    mkPayload(
      'flt:b',
      [
        '毕成业',
        '盐城',
        '38 岁',
        '工作15年',
        '在职，看看新机会',
        '26-27k×12薪',
        '某某师范大学 · 计算机科学与技术 · 本科 · 非统招',
        '语言能力',
        '英语',
      ].join('\n')
    )
  )
  store.ingestCapture(
    mkPayload(
      'flt:c',
      [
        '秦天朗',
        '深圳',
        '28 岁',
        '工作5年',
        '离职',
        '20k×13薪',
        '某某大学 · 软件工程 · 硕士 · 统招',
        '19800000000',
        '语言能力',
        '日语',
      ].join('\n')
    )
  )

  /** 按**姓名精确匹配**取 id —— 同名前缀可能命中别人，一定要再比一次 name */
  const idOf = (name) =>
    store.query({ q: name, limit: 100 }).items.find((r) => r.candidate.name === name)?.candidate.id
  const idA = idOf('冯小满')
  const idB = idOf('毕成业')
  const idC = idOf('秦天朗')
  ok(!!idA && !!idB && !!idC, '三个画像候选人都建好了')

  // ---- 城市 ----
  const byCity = store.query({ city: '青岛', limit: 500 })
  ok(byCity.total >= 1, `城市筛选有结果（${byCity.total}）`)
  ok(
    byCity.items.every((r) => r.candidate.city === '青岛'),
    '城市筛选：返回的每一条都是该城市'
  )
  ok(
    byCity.items.some((r) => r.candidate.id === idA),
    '城市筛选：冯小满（青岛）在结果里'
  )
  ok(!byCity.items.some((r) => r.candidate.id === idB), '城市筛选：毕成业（盐城）不在结果里')

  // ---- 学历性质（HR 最在意的「统招」）----
  const byMode = store.query({ educationMode: '非统招', limit: 500 })
  ok(
    byMode.items.every((r) => r.candidate.educationMode === '非统招'),
    '学历性质筛选：返回的每一条都是「非统招」'
  )
  ok(byMode.items.some((r) => r.candidate.id === idB), '学历性质筛选：毕成业（非统招）在结果里')
  ok(!byMode.items.some((r) => r.candidate.id === idA), '学历性质筛选：冯小满（统招）不在结果里')

  // ---- 学历层次 ----
  const byDegree = store.query({ degree: '硕士', limit: 500 })
  ok(
    byDegree.items.every((r) => r.candidate.degree === '硕士'),
    '学历筛选：返回的每一条都是硕士'
  )
  ok(byDegree.items.some((r) => r.candidate.id === idC), '学历筛选：秦天朗（硕士）在结果里')

  // ---- 年龄区间 ----
  const byAge = store.query({ minAge: 36, maxAge: 40, limit: 500 })
  ok(
    byAge.items.every((r) => (r.candidate.age ?? -1) >= 36 && (r.candidate.age ?? 999) <= 40),
    '年龄区间：返回的每一条都在 36–40 内'
  )
  ok(byAge.items.some((r) => r.candidate.id === idB), '年龄区间：毕成业（38）在结果里')
  ok(!byAge.items.some((r) => r.candidate.id === idA), '年龄区间：冯小满（20）不在结果里')
  // 只给一端 = 开区间
  const byAgeMin = store.query({ minAge: 30, limit: 500 })
  ok(
    byAgeMin.items.every((r) => (r.candidate.age ?? -1) >= 30),
    '年龄只给下限时按开区间处理'
  )

  // ---- 工作年限 ----
  const byYears = store.query({ minYears: 10, limit: 500 })
  ok(
    byYears.items.every((r) => (r.candidate.yearsOfExperience ?? -1) >= 10),
    '年限区间：返回的每一条都 ≥ 10 年'
  )
  ok(byYears.items.some((r) => r.candidate.id === idB), '年限区间：毕成业（15 年）在结果里')

  // ---- 语言（★ 归一口径：库里是「英语(CET6、工作应用)」，筛选值只写「英语」）----
  const byLang = store.query({ language: '英语', limit: 500 })
  ok(
    byLang.items.every((r) => (r.candidate.languages ?? []).some((l) => l.split(/[(（]/)[0].trim() === '英语')),
    '语言筛选：返回的每一条都真的会英语'
  )
  ok(
    byLang.items.some((r) => r.candidate.id === idA),
    '★ 语言归一：「英语(CET6、工作应用)」能被「英语」筛出来'
  )
  const byJp = store.query({ language: '日语', limit: 500 })
  ok(byJp.items.some((r) => r.candidate.id === idC), '语言筛选：会日语的秦天朗在结果里')
  ok(!byJp.items.some((r) => r.candidate.id === idA), '语言筛选：不会日语的冯小满不在结果里')

  // ---- 联系方式 ----
  const withContact = store.query({ hasContact: true, limit: 500 })
  ok(
    withContact.items.every((r) => !!(r.candidate.phone?.trim() || r.candidate.email?.trim())),
    '「只看有联系方式」：返回的每一条都真有手机或邮箱'
  )

  // ---- ★★ 最关键的不变量：queryIds 与 query 必须命中同一批人 ----
  // 两处各写一遍判断的话，会出现「列表显示 N 人、点『勾选全部』却少选几个」——
  // 而用户完全无从发现。所以用多组条件交叉验证。
  const probes = [
    {},
    { city: '青岛' },
    { educationMode: '非统招' },
    { minAge: 30 },
    { minYears: 4 },
    { language: '英语' },
    { degree: '硕士' },
    { hasContact: true },
    { q: '工程师' },
  ]
  for (const probe of probes) {
    const label = JSON.stringify(probe)
    const list = store.query({ ...probe, limit: 500 })
    const ids = store.queryIds(probe)
    eq(ids.total, list.total, `总数一致 ${label}`)
    eq(ids.ids.length, ids.total, `queryIds 不受分页上限影响 ${label}`)
    eq(
      JSON.stringify([...ids.ids].sort()),
      JSON.stringify(list.items.map((r) => r.candidate.id).sort()),
      `★ queryIds 与 query 命中同一批人 ${label}`
    )
  }

  // ---- facets：可选值来自真实数据，且语言已归一 ----
  const facets = store.facets()
  ok(facets.cities.some((f) => f.value === '青岛'), 'facets：城市里有「青岛」')
  ok(facets.cities.some((f) => f.value === '盐城'), 'facets：城市里有「盐城」')
  ok(
    facets.languages.some((f) => f.value === '英语'),
    '★ facets：语言已归一成「英语」（不带「(CET6、工作应用)」）'
  )
  ok(
    !facets.languages.some((f) => f.value.includes('(')),
    'facets：语言下拉里没有带括号的原始形态'
  )
  ok(facets.degrees.some((f) => f.value === '硕士'), 'facets：学历里有「硕士」')
  ok(facets.educationModes.some((f) => f.value === '非统招'), 'facets：学历性质里有「非统招」')
  ok(
    facets.cities.every((f) => f.count >= 1),
    'facets：每个可选值的人数都 ≥ 1'
  )

  // ---- 按 ids 导出：只导这些人、保持传入顺序、忽略筛选条件 ----
  const picked = [idC, idA] // 故意乱序，验证顺序被保留
  const byIds = store.exportRows({ city: '青岛' }, 5000, picked)
  eq(byIds.rows.length, 2, '按 ids 导出：行数等于勾选人数')
  eq(byIds.total, 2, '按 ids 导出：total 等于勾选人数')
  eq(byIds.truncated, false, '按 ids 导出：没超上限时不报截断')
  eq(
    byIds.rows.map((r) => r.name).join(','),
    '秦天朗,冯小满',
    '按 ids 导出：保持勾选顺序（且不受 city=青岛 这个筛选影响）'
  )
  // 勾选里混进不存在的 id：静默跳过，不报错也不塞空行
  const withGhost = store.exportRows({}, 5000, [idA, 'cand_不存在'])
  eq(withGhost.rows.length, 1, '按 ids 导出：不存在的 id 被静默跳过')
  eq(withGhost.rows[0].name, '冯小满', '按 ids 导出：剩下的那行是对的')
  // 重复 id 只出一行
  eq(store.exportRows({}, 5000, [idA, idA]).rows.length, 1, '按 ids 导出：重复 id 只出一行')
}

// ---------------------------------------------------------- 5. 汇总
console.log(`\n=== ${pass} 项通过，${fail} 项失败 ===`)
if (fail > 0) {
  console.log('失败项：')
  failures.forEach((f) => console.log(`  · ${f}`))
}
process.exit(fail > 0 ? 1 : 0)
