// ============================================================
// 提取逻辑单元测试
// 用极简假 DOM 驱动真实的 extract.ts（先 esbuild 打成 ESM 再 import），
// 不引入 jsdom，跑得飞快。
//
// 重点回归两个「静默失败」的 bug：
//   ① 同一 URL 下切换候选人必须被识别成新简历（旧实现拿 URL 当闸门，永久漏采）
//   ② 候选人 ID 绝不能取成路由词（旧实现会把猎聘 IM 页的 ID 取成 'im'，
//      导致同一职位下所有人撞成一个 ID 被全部判重丢弃）
// ============================================================
import esbuild from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../..')

// ---------------------------------------------------------- 1. 打包真实源码
const entry = path.join(repoRoot, 'apps/extension/src/extract.ts')
const outFile = path.join(os.tmpdir(), `ria-extract-${Date.now()}.mjs`)
await esbuild.build({
  entryPoints: [entry],
  outfile: outFile,
  bundle: true,
  platform: 'neutral',
  format: 'esm',
  target: 'node20',
  alias: { '@ria/shared': path.join(repoRoot, 'packages/shared/src/index.ts') },
  logLevel: 'warning',
})
const E = await import(pathToFileURL(outFile).href)
process.on('exit', () => {
  try {
    fs.rmSync(outFile, { force: true })
  } catch {
    /* ignore */
  }
})

// ---------------------------------------------------------- 2. 假 DOM
class FakeEl {
  constructor(tag, opts = {}) {
    this.tagName = tag.toUpperCase()
    this._attrs = { ...(opts.attrs || {}) }
    if (opts.cls) this._attrs.class = opts.cls
    if (opts.id) this._attrs.id = opts.id
    this._text = opts.text || ''
    this.children = []
    this.parentElement = null
    for (const c of opts.children || []) this.appendChild(c)
  }
  appendChild(c) {
    c.parentElement = this
    this.children.push(c)
    return c
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('\n')
  }
  get innerText() {
    return this.textContent
  }
  getAttribute(name) {
    return name in this._attrs ? this._attrs[name] : null
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null
  }
  querySelectorAll(sel) {
    return this.walk().filter((e) => matchSel(e, sel))
  }
  walk() {
    const out = []
    for (const c of this.children) out.push(c, ...c.walk())
    return out
  }
}

function matchOne(el, raw) {
  const s = raw.trim()
  if (!s) return false
  if (s.startsWith('.')) return (el.getAttribute('class') || '').split(/\s+/).includes(s.slice(1))
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1)
    if (inner.includes('*=')) return false // 属性子串匹配不在假实现范围
    return el.getAttribute(inner) != null
  }
  return el.tagName === s.toUpperCase()
}
function matchSel(el, sel) {
  return sel.split(',').some((one) => matchOne(el, one))
}
function fakeDoc(roots) {
  const root = new FakeEl('html', { children: roots })
  return {
    documentElement: root,
    querySelectorAll: (sel) => root.querySelectorAll(sel),
    querySelector: (sel) => root.querySelector(sel),
  }
}

// ---------------------------------------------------------- 3. 测试夹具
const RESUME = `张三
男 · 28岁 · 深圳 · 硕士 · 5年经验
求职意向
期望职位：高级视觉算法工程师
期望城市：深圳
工作经历
2021.07 - 至今   深圳某某科技有限公司   视觉算法工程师
负责半导体晶圆表面缺陷检测算法开发，基于深度学习的分割与分类模型
2019.07 - 2021.06   某某电子科技有限公司   算法工程师
教育经历
2016.09 - 2019.06   某某大学   计算机科学与技术   硕士
项目经历
晶圆表面缺陷检测系统：负责缺陷分割模型，mAP 提升 12%
专业技能
C++ / Python / PyTorch / OpenCV / Halcon
自我评价
踏实，工程落地能力强，熟悉 AOI 设备光学标定流程`

const NAV = '通讯录 消息列表 职位管理 候选人管理 人才库 我的猎聘 退出登录 账户设置 企业版'
const CHAT = '你好，方便聊聊吗？我们这边有个机会想和你沟通一下，方便的话留个电话'

/** 猎聘 IM 页的真实 URL 形态 —— 没有 id 参数，路径末段是路由词 im */
const LIEPIN_CHAT_LOC = {
  href: 'https://lpt.liepin.com/chat/im?jobId=85838997&jobKind=2&tab=message#preview',
  hostname: 'lpt.liepin.com',
  pathname: '/chat/im',
  search: '?jobId=85838997&jobKind=2&tab=message',
  hash: '#preview',
}

// ---------------------------------------------------------- 4. 断言工具
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
function section(t) {
  console.log(`\n${t}`)
}

// ---------------------------------------------------------- 5. 用例
console.log('=== 简历提取逻辑单元测试 ===')
console.log(`源码：${entry}\n`)

section('1. 站点识别（必须覆盖子域）')
eq(E.resolveSite('lpt.liepin.com')?.platform, 'liepin', '猎聘企业端 lpt.liepin.com → liepin')
eq(E.resolveSite('www.liepin.com')?.platform, 'liepin', '猎聘主站 www.liepin.com → liepin')
eq(E.resolveSite('www.zhipin.com')?.platform, 'boss', 'BOSS www.zhipin.com → boss')
eq(E.resolveSite('zhipin.com')?.platform, 'boss', 'BOSS 裸域 zhipin.com → boss')
eq(E.resolveSite('evil-liepin.com'), null, '相似域名 evil-liepin.com 不能误判')
eq(E.resolveSite('liepin.com.evil.com'), null, '后缀伪装 liepin.com.evil.com 不能误判')
eq(E.resolveSite('localhost'), null, '非目标站点返回 null')

section('2. 简历文本打分')
ok(E.scoreResumeText(RESUME) >= E.PASS_SCORE, `完整简历通过阈值（${E.scoreResumeText(RESUME)} ≥ ${E.PASS_SCORE}）`)
eq(E.scoreResumeText(CHAT), 0, '纯聊天文本得分 0（无章节词）')
eq(E.scoreResumeText(''), 0, '空文本得分 0')
eq(E.scoreResumeText('工作经历'), 0, '过短文本得分 0（未达最小长度）')
const shellScore = E.scoreResumeText(`${NAV}\n${RESUME}`)
ok(shellScore < E.PASS_SCORE, `夹带页面外壳的文本被压到阈值以下（${shellScore} < ${E.PASS_SCORE}）`)
ok(shellScore < E.scoreResumeText(RESUME), '外壳噪声确实降低了得分')

section('3. 容器定位（外层噪声容器 vs 内层简历容器）')
{
  const resumeBox = new FakeEl('div', { cls: 'candidate-profile-body', text: RESUME })
  const nav = new FakeEl('div', { cls: 'side-nav', text: NAV })
  const panel = new FakeEl('div', { cls: 'right-panel', children: [resumeBox] })
  const shell = new FakeEl('div', { cls: 'app-shell', children: [nav, panel] })
  const doc = fakeDoc([shell])

  const found = E.findResumeContainer(doc, E.SITE_LIEPIN)
  ok(found !== null, '能定位到简历容器')
  ok(found?.el === resumeBox, '选中的是最内层简历容器（而不是整页外壳）')
  eq(found?.via, 'heuristic', '未命中站点选择器时走启发式')

  const out = E.extractFrom(doc, LIEPIN_CHAT_LOC, E.SITE_LIEPIN)
  ok(out.ok, 'extractFrom 端到端成功')
  eq(out.payload?.platform, 'liepin', '平台标记为 liepin')
  ok(out.payload?.rawText.includes('工作经历'), '正文包含简历内容')
  ok(!(out.payload?.rawText || '').includes('职位管理'), '正文不夹带页面外壳文本')
}

section('4. 站点选择器优先')
{
  const box = new FakeEl('div', { cls: 'resume-detail', text: RESUME })
  const doc = fakeDoc([new FakeEl('div', { cls: 'app', children: [box] })])
  const found = E.findResumeContainer(doc, E.SITE_LIEPIN)
  eq(found?.via, 'selector', '命中 .resume-detail 时优先采信站点选择器')
  ok(found?.el === box, '选中的是站点选择器指向的容器')
}

section('5. 候选人 ID 提取（回归：不能取成路由词 im）')
{
  const root = new FakeEl('div', { cls: 'candidate-profile-body', text: RESUME })
  const id = E.pickCandidateId(fakeDoc([root]), LIEPIN_CHAT_LOC, E.SITE_LIEPIN, root, RESUME)

  ok(id !== 'im', 'ID 不能是路由词 im（旧实现的实际返回值）')
  ok(!/^(im|chat|message|preview)$/.test(id), 'ID 不能是任何路由词')
  ok(!id.includes('jobId'), '职位 ID 不能当候选人 ID')
  ok(id.startsWith('content:'), '无可用 ID 时退化为内容指纹')

  // jobId 不同但简历不同 → 必须得到不同的 ID
  const other = `${RESUME}\n补充：熟悉 HALCON 与 VisionPro`
  const id2 = E.pickCandidateId(fakeDoc([root]), LIEPIN_CHAT_LOC, E.SITE_LIEPIN, root, other)
  ok(id !== id2, '同一 URL 下不同候选人得到不同 ID')

  // 同一份简历重复提取必须稳定
  const id3 = E.pickCandidateId(fakeDoc([root]), LIEPIN_CHAT_LOC, E.SITE_LIEPIN, root, RESUME)
  eq(id3, id, '同一份简历重复提取 ID 稳定（保证去重生效）')
}

section('6. 候选人 ID 优先级')
{
  const root = new FakeEl('div', { cls: 'candidate-profile-body', text: RESUME })

  const q = { ...LIEPIN_CHAT_LOC, search: '?jobId=85838997&resumeId=abc123def' }
  eq(
    E.pickCandidateId(fakeDoc([root]), q, E.SITE_LIEPIN, root, RESUME),
    'resumeId:abc123def',
    'URL query 里的 resumeId 优先'
  )

  const h = { ...LIEPIN_CHAT_LOC, hash: '#preview?resumeId=xyz789' }
  eq(
    E.pickCandidateId(fakeDoc([root]), h, E.SITE_LIEPIN, root, RESUME),
    'resumeId:xyz789',
    'hash 里的 resumeId 也能取到'
  )

  const p = { ...LIEPIN_CHAT_LOC, pathname: '/resume/12345678', search: '', hash: '' }
  eq(
    E.pickCandidateId(fakeDoc([root]), p, E.SITE_LIEPIN, root, RESUME),
    'path:12345678',
    '路径末段是长数字时用作 ID'
  )

  const withAttr = new FakeEl('div', {
    cls: 'candidate-profile-body',
    attrs: { 'data-resumeid': 'R-998877' },
    text: RESUME,
  })
  eq(
    E.pickCandidateId(fakeDoc([withAttr]), LIEPIN_CHAT_LOC, E.SITE_LIEPIN, withAttr, RESUME),
    'data-resumeid:R-998877',
    'DOM 属性上的候选人 ID 兜底可用'
  )
}

section('7. 内容签名（回归：同 URL 切人必须算新简历）')
{
  const mk = (id, text) => ({
    platform: 'liepin',
    platformCandidateId: id,
    resumeUrl: LIEPIN_CHAT_LOC.href,
    rawText: text,
    capturedAt: '',
  })
  const a = mk('content:aaa', RESUME)
  const b = mk('content:bbb', RESUME)
  ok(E.signatureOf(a) !== E.signatureOf(b), '同一 URL 下的不同候选人 → 不同签名')
  ok(E.signatureOf(a) === E.signatureOf(mk('content:aaa', RESUME)), '同一候选人 → 相同签名（不重复上报）')
}

section('8. 诊断报告')
{
  const resumeBox = new FakeEl('div', { cls: 'candidate-profile-body', text: RESUME })
  const nav = new FakeEl('div', { cls: 'side-nav', text: NAV })
  const doc = fakeDoc([new FakeEl('div', { cls: 'app-shell', children: [nav, resumeBox] })])
  const r = E.diagnose(doc, LIEPIN_CHAT_LOC, E.SITE_LIEPIN)
  ok(r.containerFound, '诊断：能找到容器')
  eq(r.site, 'liepin', '诊断：站点正确')
  ok(r.verdict.length > 0, '诊断：给出人话结论')
  ok(Array.isArray(r.topCandidates), '诊断：候选列表是数组')
}
{
  const doc = fakeDoc([new FakeEl('div', { cls: 'chat', text: CHAT })])
  const r = E.diagnose(doc, LIEPIN_CHAT_LOC, E.SITE_LIEPIN)
  ok(!r.containerFound, '诊断：纯聊天页判定为未找到')
  ok(r.verdict.length > 0, '诊断：未找到时也有人话结论')
}

section('9. 姓名识别（回归：不能把面板按钮当成姓名）')
{
  // 用户真实采到的猎聘企业端预览正文：顶部混着一排操作按钮
  const withChrome = `太多人选急需联系？试试意向沟通，一键发起坐等结果。
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
复合材料与工程专业本科毕业，具备扎实的专业基础。
展开
求职意向
查看全部3个
工艺/制程工程师(PE)`
  eq(E.guessName(withChrome), '张小雨', '跳过「查看大图 / 意向沟通」，取到真名')
  eq(E.guessName('姓名：李四\n男 30岁 深圳'), '李四', '识别「姓名：X」显式标签')
  eq(E.guessName('查看大图\n意向沟通\n发起意向沟通\n展开\n收起'), '', '整块都是按钮时不硬编一个姓名')
  eq(E.guessName('工作经历\n教育经历\n求职意向'), '', '章节标签不能被当成姓名')
}

section('10. 去重稳定性（回归：同一份简历不能存成两条）')
{
  // 同一个人的两次抓取 —— 容器边界不同，第二次多带了手机号与两个按钮
  const captureA = `太多人选急需联系？试试意向沟通，一键发起坐等结果。
发起意向沟通
查看大图
张小雨
今天活跃
更新简历时间：2026.09.30
青岛
工作2年
20 岁
离职，正在找工作
华北理工大学 · 复合材料与工程 · 本科 · 统招
xiaoyu.zhang@example.com
工作经历
某某汽车线束有限公司
工艺助理工程师
工作描述
负责线束工艺文件编制与产线风险排查，主导导线线长优化项目。
教育经历
华北理工大学 · 复合材料与工程 · 本科
专业技能
AutoCAD / SolidWorks / Origin
自我评价
踏实细致，能承接跨国项目协作。`

  const captureB = `13800000000
意向沟通
继续沟通
${captureA}`

  ok(E.guessName(captureA) === E.guessName(captureB), '两次抓取识别出同一个姓名')
  eq(E.stableIdentity(captureA), 'email:xiaoyu.zhang@example.com', '辅助身份键：无手机号时命中邮箱')
  eq(E.stableIdentity(captureB), 'phone:138****0000', '辅助身份键：有手机号时优先手机号')
  eq(E.canonicalPhone('13800000000'), '138****0000', '完整手机号归一为「前3+后4」写法')
  eq(E.canonicalPhone('138****0000'), '138****0000', '脱敏手机号归一后与完整形态一致')
  eq(
    E.fingerprintText('联系我 13800000000'),
    E.fingerprintText('联系我 138****0000'),
    '内容指纹里，手机号的完整/脱敏形态算同一个'
  )

  const idA = E.pickCandidateId(fakeDoc([]), LIEPIN_CHAT_LOC, E.SITE_LIEPIN, new FakeEl('div'), captureA)
  const idB = E.pickCandidateId(fakeDoc([]), LIEPIN_CHAT_LOC, E.SITE_LIEPIN, new FakeEl('div'), captureB)
  eq(idA, idB, '同一份简历两次抓取 → 同一个候选人 ID（去重键稳定）')

  const mk = (id, text) => ({
    platform: 'liepin',
    platformCandidateId: id,
    resumeUrl: LIEPIN_CHAT_LOC.href,
    rawText: text,
    capturedAt: '',
  })
  eq(E.signatureOf(mk(idA, captureA)), E.signatureOf(mk(idB, captureB)), '内容签名忽略按钮/数字行的抖动')
  ok(
    E.signatureOf(mk(idA, captureA)) !== E.signatureOf(mk(idA, `${captureA}\n新增了一段工作经历描述`)),
    '简历正文真的变长时签名要变（允许重新上报）'
  )

  // 没有任何身份特征时的兜底：归一化内容指纹
  const anon = `${RESUME}\n展开\n查看大图`
  eq(
    E.pickCandidateId(fakeDoc([]), LIEPIN_CHAT_LOC, E.SITE_LIEPIN, new FakeEl('div'), anon),
    E.pickCandidateId(fakeDoc([]), LIEPIN_CHAT_LOC, E.SITE_LIEPIN, new FakeEl('div'), RESUME),
    '无手机号/邮箱时，归一化指纹也能抹平按钮差异'
  )
  ok(
    !E.pickCandidateId(fakeDoc([]), LIEPIN_CHAT_LOC, E.SITE_LIEPIN, new FakeEl('div'), RESUME).includes('im'),
    '候选人 ID 里不能出现路由词 im'
  )
}

section('11. 面板按钮词对容器打分的抑制')
{
  ok(E.UI_CHROME_WORDS.includes('查看大图'), '按钮词表包含「查看大图」')
  ok(E.looksLikeChromeOrJunk('查看大图'), '按钮行被判定为垃圾行')
  ok(E.looksLikeChromeOrJunk('12'), '纯数字行被判定为垃圾行')
  ok(!E.looksLikeChromeOrJunk('张小雨'), '正常姓名不被误杀')
}

section('12. 采集决策真值表（mode × 状态 × 列表页）')
{
  const base = {
    mode: 'auto',
    outcomeOk: true,
    signature: 'boss|abc|1200',
    lastSignature: '',
    askingSignature: '',
    dismissed: [],
    pathPaused: false,
    listPolicy: 'normal',
  }
  const D = (over) => E.decideCapture({ ...base, ...over })

  eq(D({ mode: 'off' }).action, 'ignore', 'off 模式：什么都不做')
  eq(D({ mode: 'off' }).reason, 'off', 'off 模式：原因是已关闭')
  eq(D({ mode: 'auto', outcomeOk: false }).reason, 'no-resume', '没提取到简历：忽略')
  eq(D({ pathPaused: true }).reason, 'path-paused', '本页已暂停：忽略（连自动采集也不做）')
  eq(D({ listPolicy: 'skip' }).reason, 'list-skip', '列表页策略 skip：完全不出卡')

  eq(D({ mode: 'auto' }).action, 'capture', 'auto 模式 + 普通页 → 直接上报')
  eq(D({ mode: 'auto' }).source, 'auto', '上报标记为自动采集')
  eq(D({ mode: 'confirm' }).action, 'ask', 'confirm 模式 → 先问用户')
  eq(D({ mode: 'confirm' }).listPage, undefined, '普通页的询问不带列表页标记')
  eq(D({ listPolicy: 'manual', mode: 'auto' }).action, 'ask', '列表页（manual）：即使 auto 模式也不自动采')
  eq(D({ listPolicy: 'manual', mode: 'auto' }).listPage, true, '列表页的询问带上列表页标记')

  eq(D({ lastSignature: base.signature }).reason, 'duplicate', '同一签名已上报过：不重复')
  eq(D({ askingSignature: base.signature }).reason, 'duplicate', '正在询问中的那一份：不重复弹卡')
  eq(D({ dismissed: [base.signature] }).reason, 'dismissed', '用户说过「这次不存」：不再问')
  eq(D({ dismissed: ['boss|other|9'] }).action, 'capture', '跳过的是别人，不影响这一份')
  eq(D({ signature: '' }).action, 'capture', '签名为空时不应被误判成重复')

  ok(
    E.decideCapture({ ...base, mode: 'off' }).action === 'ignore' &&
      E.decideCapture({ ...base, mode: 'off', outcomeOk: false }).reason === 'off',
    'off 优先级高于「没提取到简历」'
  )
  ok(
    E.decideCapture({ ...base, pathPaused: true, dismissed: [base.signature] }).reason === 'path-paused',
    '本页暂停优先级高于「这一份已跳过」'
  )
}

section('13. 列表页护栏（一屏多人的聚合容器必须被挡下）')
{
  const LIST_TEXT = Array.from({ length: 5 }, (_, i) =>
    [
      `候选人${i + 1}`,
      `${28 + i}岁  深圳`,
      '学历：硕士',
      `工作${3 + i}年`,
      '查看大图 意向沟通',
      '工作经历',
      '负责算法开发与落地',
      '教育经历',
      '某某大学 计算机',
    ].join('\n')
  ).join('\n')

  const listVerdict = E.looksLikeListContainer(LIST_TEXT)
  ok(listVerdict.isList, `聚合了 5 位候选人的容器被判为列表（${listVerdict.families.filter((f) => f.over).length} 种特征超标）`)
  ok(
    listVerdict.families.filter((f) => f.over).length >= E.LIST_FAMILIES_MIN,
    '要求「至少 2 种特征超标」而不是总数超标'
  )

  const oneVerdict = E.looksLikeListContainer(RESUME)
  ok(!oneVerdict.isList, '单份简历不会被误判成列表页')
  ok(E.looksLikeListContainer('').isList === false, '空文本不是列表页')

  eq(E.isListPage(E.SITE_LIEPIN, { pathname: '/recommend', hash: '', hostname: 'lpt.liepin.com' }), true, '猎聘 /recommend 命中列表页规则')
  eq(E.isListPage(E.SITE_LIEPIN, { pathname: '/talent/list', hash: '', hostname: 'lpt.liepin.com' }), true, '猎聘人才库路径命中')
  eq(E.isListPage(E.SITE_LIEPIN, LIEPIN_CHAT_LOC), false, '猎聘 IM 页不是列表页')
  eq(E.isListPage(E.SITE_LIEPIN, { pathname: '/resume/123456', hash: '', hostname: 'c.liepin.com' }), false, '简历详情页不是列表页')
  eq(E.isListPage(E.SITE_BOSS, { pathname: '/recommend', hash: '', hostname: 'www.zhipin.com' }), true, 'BOSS 推荐页命中')

  eq(E.pathKeyOf(LIEPIN_CHAT_LOC), 'lpt.liepin.com/chat/im', '路径键只到 pathname，不含 query（避免每个职位的 key 都不同）')
}

section('14. 手动强制保存（放宽门槛，但把不确定性标出来）')
{
  // 只有 1 个章节词的长文本：自动采集过不了 MIN_SECTION_HITS=2，手动保存应该能救
  const WEAK = `李四\n28岁 深圳\n学历：本科\n专业技能\n${'负责算法开发与现场调试，'.repeat(30)}`

  const weakBox = new FakeEl('div', { cls: 'preview-body', text: WEAK })
  const weakDoc = fakeDoc([weakBox])

  const auto = E.extractFrom(weakDoc, LIEPIN_CHAT_LOC, E.SITE_LIEPIN)
  ok(!auto.ok, '同一份文本：自动采集判定为「没找到简历」（这就是需要人工兜底的场景）')

  const forced = E.extractForced(weakDoc, LIEPIN_CHAT_LOC, E.SITE_LIEPIN)
  ok(forced.ok, '手动强制保存能拿到内容')
  eq(forced.payload?.source, 'manual', 'payload 标记为手动保存')
  eq(forced.belowThreshold, true, '如实标记「未达自动阈值」')
  eq(forced.lowConfidence, true, '低置信标记为 true')
  eq(forced.idFromContentHash, true, '没有平台 ID 时，标记 ID 来自内容指纹（可能重复建档）')
  ok((forced.payload?.rawText || '').includes('专业技能'), '正文内容正确')

  // 正常简历走手动保存：不该被标成低置信
  const goodBox = new FakeEl('div', {
    cls: 'resume-detail',
    text: RESUME,
    attrs: { 'data-resumeid': 'R-998877' },
  })
  const goodForced = E.extractForced(fakeDoc([goodBox]), LIEPIN_CHAT_LOC, E.SITE_LIEPIN)
  eq(goodForced.ok, true, '完整简历手动保存成功')
  eq(goodForced.lowConfidence, false, '完整简历不会被误标为低置信')
  eq(goodForced.via, 'selector', '站点选择器命中时优先采信')
  eq(goodForced.payload?.platformCandidateId, 'data-resumeid:R-998877', '能拿到平台 ID 时用平台 ID')
  ok(!goodForced.idFromContentHash, '有平台 ID 时不该退化成内容指纹')

  // 一个候选块都没有 → 退化成整页文本，必须打上 wholePage 标记（调用方据此做二次确认）
  const spanA = new FakeEl('span', { text: 'A'.repeat(200) })
  const spanB = new FakeEl('span', { text: 'B'.repeat(200) })
  const noBlock = E.extractForced(fakeDoc([spanA, spanB]), LIEPIN_CHAT_LOC, E.SITE_LIEPIN)
  eq(noBlock.wholePage, true, '没有任何候选块时退化为整页文本')
  eq(noBlock.lowConfidence, true, '整页兜底必然低置信')
  eq(noBlock.ok, true, '整页兜底仍然返回内容（由界面负责二次确认）')

  // 列表页整块：必须给出 listWarning，让界面去问「确定要存这一整块吗」
  const LIST_BLOCK = Array.from({ length: 5 }, (_, i) =>
    `候选人${i + 1}\n${28 + i}岁  深圳\n工作${3 + i}年\n查看大图 意向沟通\n工作经历\n负责算法\n教育经历\n某某大学`
  ).join('\n')
  const listForced = E.extractForced(fakeDoc([new FakeEl('div', { cls: 'recommend-list', text: LIST_BLOCK })]), {
    href: 'https://lpt.liepin.com/recommend',
    hostname: 'lpt.liepin.com',
    pathname: '/recommend',
    search: '',
    hash: '',
  }, E.SITE_LIEPIN)
  eq(listForced.listWarning?.isList, true, '整块列表页文本带出 listWarning（供界面二次确认）')

  // 短到没有意义的内容不该被保存
  const tiny = E.extractForced(fakeDoc([new FakeEl('div', { text: '太短了' })]), LIEPIN_CHAT_LOC, E.SITE_LIEPIN)
  eq(tiny.ok, false, '内容过短时拒绝保存')
  eq(tiny.reason, 'text-too-short', '拒绝原因是「文本过短」')
}

section('15. 来源 URL 与平台 ID：从 DOM 里找「这份简历自己的详情页链接」')
{
  // 真实场景：在 /recommend 预览面板采集，location.href 只是列表页；
  // 预览面板上那个「新页面查看」按钮的 href 才是这份简历自己的详情页。
  const DETAIL_HREF =
    'https://lpt.liepin.com/resume/detail?sfrom=R_HOMEPAGE_RECMD&resIdEncode=CD34EF56AB7800cc33dd44' +
    '&usercIdEncode=89968fa0c57ad8ee7cb9374f3bb026df&ejobId=85928801&sign=abc'

  const resumeBox = new FakeEl('div', { cls: 'candidate-profile-body', text: RESUME })
  const panel = new FakeEl('div', {
    cls: 'right-panel',
    children: [
      resumeBox,
      new FakeEl('a', { attrs: { href: DETAIL_HREF, target: '_blank' }, text: '新页面查看' }),
    ],
  })
  const doc = fakeDoc([panel])

  const found = E.findResumeDetailLink(doc, resumeBox)
  ok(!!found, '能在容器附近找到详情页链接')
  ok(String(found).includes('resIdEncode=CD34EF56AB7800cc33dd44'), '取到的是带真 ID 的那条链接')

  eq(
    E.resumeIdFromDetailUrl(DETAIL_HREF),
    'resIdEncode:CD34EF56AB7800cc33dd44',
    'resIdEncode 优先于 usercIdEncode / ejobId'
  )
  eq(
    E.resumeIdFromDetailUrl('https://lpt.liepin.com/resume/detail?resumeId=12345678'),
    'resumeId:12345678',
    '没有 resIdEncode 时退回 resumeId'
  )
  eq(E.resumeIdFromDetailUrl('https://x.com/a?foo=1'), null, '没有 ID 参数时返回 null')

  // ★ 最关键的一条：预览面板采集时，平台 ID 应该是详情页里的真 ID，而不是内容指纹
  const text = E.stripResumeChrome((resumeBox.textContent || ''))
  const idWithDetail = E.pickCandidateId(doc, LIEPIN_CHAT_LOC, E.SITE_LIEPIN, resumeBox, text, found)
  eq(idWithDetail, 'resIdEncode:CD34EF56AB7800cc33dd44', '有详情链接时用平台真 ID（不再是内容指纹）')
  ok(!idWithDetail.startsWith('content:'), '不再退化成内容指纹')

  // ★ 去重收敛：同一个人换个容器边界再采，只要详情链接在，ID 必须一致
  const box2 = new FakeEl('div', { cls: 'candidate-profile-body', text: `${RESUME}\n继续沟通\n展开` })
  const panel2 = new FakeEl('div', {
    cls: 'right-panel',
    children: [box2, new FakeEl('a', { attrs: { href: DETAIL_HREF }, text: 'x' })],
  })
  const doc2 = fakeDoc([panel2])
  const found2 = E.findResumeDetailLink(doc2, box2)
  const id2 = E.pickCandidateId(
    doc2,
    LIEPIN_CHAT_LOC,
    E.SITE_LIEPIN,
    box2,
    E.stripResumeChrome(box2.textContent || ''),
    found2
  )
  eq(id2, idWithDetail, '容器边界抖动时 ID 仍然一致 → 同一人不会存成两条档案')

  // 没有详情链接时仍然退化到内容指纹（保底行为不变）
  const idNoDetail = E.pickCandidateId(doc, LIEPIN_CHAT_LOC, E.SITE_LIEPIN, resumeBox, text, null)
  ok(idNoDetail.startsWith('content:'), '拿不到详情链接时仍以内容指纹兜底')
}

section('15b. 正文里的「平台简历编号」优先于内容指纹（跨容器稳定的去重键）')
{
  // 实测：猎聘正文里的「简历编号」与详情页 URL 里的 resIdEncode 是同一个值
  //      （周敏：正文 CD34EF56AB7800cc33dd44 === URL 里的 resIdEncode）
  const WITH_NO = `${RESUME}\n附件简历与个人作品\n已上传附件简历\n向TA索要后才可查看完整的附件简历和作品\n向TA索要\n简历编号\n: CD34EF56AB7800cc33dd44\n觉得TA还不错：\n获取电话\n转发`

  const box = new FakeEl('div', { cls: 'candidate-profile-body', text: WITH_NO })
  const d = fakeDoc([box])
  const t = E.stripResumeChrome(box.textContent || '')
  const id = E.pickCandidateId(d, LIEPIN_CHAT_LOC, E.SITE_LIEPIN, box, t, null)
  eq(id, 'resumeNo:CD34EF56AB7800cc33dd44', '有简历编号时用它当平台 ID（不再退化成内容指纹）')

  // ★ 跨容器收敛：容器边界抖动（多几个按钮）时，ID 必须完全一致
  const box2 = new FakeEl('div', {
    cls: 'candidate-profile-body',
    text: `继续沟通\n${WITH_NO}\n展开\n意向沟通`,
  })
  const d2 = fakeDoc([box2])
  const t2 = E.stripResumeChrome(box2.textContent || '')
  eq(
    E.pickCandidateId(d2, LIEPIN_CHAT_LOC, E.SITE_LIEPIN, box2, t2, null),
    id,
    '容器边界抖动时 ID 仍一致 → 同一人不会存成两条档案（即使没找到详情链接）'
  )

  // 简历编号不能被「向TA索要」误切掉（真实数据里就这么丢过一次）
  ok(t.includes('CD34EF56AB7800cc33dd44'), '「向TA索要」不再把简历编号一起切掉')
  ok(!t.includes('剩10次权益'), '尾部噪声仍然被切掉')
}

section('16. 内容指纹的稳定性（回归：配额计数会让同一份简历每天一个新指纹）')
{
  const base = '张小雨\n今天活跃\n更新简历时间：2026.09.30\n青岛\n工作2年\n20 岁\n华北理工大学 · 复合材料与工程 · 本科 · 统招\n工作经历\n负责产线设备调试'
  const later = '张小雨\n7天内活跃\n更新简历时间：2026.10.05\n青岛\n工作2年\n20 岁\n华北理工大学 · 复合材料与工程 · 本科 · 统招\n工作经历\n负责产线设备调试'
  eq(
    E.fingerprintText(base),
    E.fingerprintText(later),
    '「N天内活跃」与「更新简历时间」变化不影响指纹'
  )

  const withQuota = `${base}\n觉得TA还不错：\n获取电话\n剩10次权益\n本月剩余30次\n转发\n打印`
  const quotaChanged = `${base}\n觉得TA还不错：\n获取电话\n剩3次权益\n本月剩余7次\n转发\n打印`
  eq(
    E.fingerprintText(E.stripResumeChrome(withQuota)),
    E.fingerprintText(E.stripResumeChrome(quotaChanged)),
    '尾部配额计数变化不影响指纹（先 stripResumeChrome 再算）'
  )
  ok(
    E.fingerprintText(withQuota) !== E.fingerprintText(quotaChanged) ||
      !E.fingerprintText(withQuota).includes('剩10次权益'),
    '易变行确实被从指纹里剔除了'
  )
  ok(!E.isVolatileLine('211'), '「211」不是易变行（别把院校层次误杀）')
  ok(!E.isVolatileLine('工作经历'), '章节标题不是易变行')
  ok(E.isVolatileLine('简历编号') === false, '「简历编号」是身份不是易变行，要留在指纹里')
}

section('17. 尾部 UI 噪声清洗')
{
  const dirty = `李先生\n38 岁\n盐城\n工作经历\n某某动力工业有限公司\n项目经理\n2024.08-至今 (2年2个月)\n负责产线项目\n觉得TA还不错：\n获取电话\n剩10次权益\n意向沟通\n立即沟通\n超级聊聊\n免费权益，本月剩余30次\n保存\n操作记录\n收藏\n转发\n打印\n举报\n人才招聘记录\n该候选人无人才招聘记录\n简历备注\n暂无备注内容`
  const clean = E.stripResumeChrome(dirty)
  ok(clean.length < dirty.length, `尾部被切掉（${dirty.length} → ${clean.length} 字）`)
  ok(!clean.includes('剩10次权益'), '不再含「剩10次权益」')
  ok(!clean.includes('人才招聘记录'), '不再含「人才招聘记录」')
  ok(!clean.includes('觉得TA还不错'), '不再含「觉得TA还不错」')
  ok(clean.includes('负责产线项目'), '正文主体保留')
  eq(E.stripResumeChrome('太短\n获取电话'), '太短\n获取电话', '正文过短时不误切（minIndex 保护）')
}

// ---------------------------------------------------------- 6. 汇总
console.log(`\n=== ${pass} 项通过，${fail} 项失败 ===`)
if (fail > 0) {
  console.log('失败项：')
  failures.forEach((f) => console.log(`  · ${f}`))
}
process.exit(fail > 0 ? 1 : 0)
