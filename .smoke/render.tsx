// 渲染冒烟测试：在 Node 里用 react-dom/server 真实渲染各组件，
// 用真实数据层里的数据喂给它们，验证组件不会崩、关键内容能出现在 DOM 里。
// 只在开发期用于自检，不参与构建产物。
//
// 数据来源：**进程内直接起一个 JsonStore**（临时数据目录 + 示例数据），
// 不走 HTTP —— 这样 npm test 不依赖「服务是否在跑」，也不会受端口占用影响。
// 接口层本身由 apps/server/tools/test-store.mjs 与扩展的集成测试覆盖。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JsonStore } from '../apps/server/src/db/store'
import { App } from '../apps/web/src/App'
import { CandidateCard } from '../apps/web/src/components/CandidateCard'
import { CandidateDrawer } from '../apps/web/src/components/CandidateDrawer'
import { EMPTY_FILTER, FilterPanel } from '../apps/web/src/components/FilterPanel'
import { SideNav } from '../apps/web/src/components/SideNav'
import { StatsBar } from '../apps/web/src/components/StatsBar'
import { BriefRow, FollowUpRow } from '../apps/web/src/pages/DailyPage'
import { PipelineCard } from '../apps/web/src/pages/PipelinePage'
import { BarList, SkillCloud } from '../apps/web/src/pages/TalentMapPage'
import { TodoRow } from '../apps/web/src/pages/TodosPage'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ria-smoke-'))
process.on('exit', () => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

const store = new JsonStore(tmpDir)
store.seed()

const stats = store.stats()
const positions = store.listPositions()
const paged = store.query({ limit: 50 })
const facets = store.facets()
const pipeline = store.pipeline()
const daily = store.dailyReport()
const todos = store.todos()
const talentMap = store.talentMap()

const row = paged.items[0]
const detail = store.detail(row.candidate.id)

const pipeRow = pipeline.positions[0]
const briefItem = daily.recommended[0] ?? daily.newCandidates[0]
const followItem = daily.followUps[0]
const todoItem = todos.items[0]

const renders: Array<[string, string]> = []

// ---------- 候选人库 ----------
enqueue('StatsBar', <StatsBar stats={stats} onShortcut={() => {}} />, [
  '候选人总数',
  String(stats.candidateCount),
  '招聘进度分布',
  '今日采集',
])
enqueue(
  'FilterPanel',
  <FilterPanel
    positions={positions}
    // ⚠️ 必须传真实 facets：不传的话（esbuild 不做类型检查）所有筛选下拉都是空的，
    //    组件照样渲染、冒烟照样"通过"—— 等于新加的筛选维度一个都没被测到。
    facets={facets}
    value={{ ...EMPTY_FILTER }}
    total={paged.total}
    onChange={() => {}}
    onResetData={() => {}}
    resetting={false}
  />,
  [
    '关键词',
    '最低匹配度',
    '只看待匹配',
    '最新采集优先',
    `共 ${paged.total} 人`,
    // ---- 字段级筛选的控件是否都在 ----
    '硬条件',
    '城市',
    '学历性质',
    '院校层次',
    '年龄',
    '工作年限',
    '采集方式',
    '采集时间',
    '只看有联系方式的',
    // ---- 下拉是否真的被 facet 数据填上了（只验 label 会漏掉"传了空数组"）----
    facets.cities[0]?.value ?? '',
    facets.degrees[0]?.value ?? '',
    facets.educationModes[0]?.value ?? '',
    facets.languages[0]?.value ?? '',
    // ---- 年龄/年限的档位 ----
    '26–30',
    '10 年以上',
  ]
)
enqueue('CandidateCard', <CandidateCard row={row} active={false} onClick={() => {}} />, [
  row.candidate.name,
  String(row.score ?? ''),
])
enqueue(
  'CandidateDrawer',
  <CandidateDrawer
    detail={detail}
    loading={false}
    error={null}
    onClose={() => {}}
    onStatusChange={() => {}}
  />,
  ['基本信息', '岗位匹配', '来源与留痕', detail.candidate.name]
)

// ---------- 导航（六个入口是否都在） ----------
enqueue(
  'SideNav',
  <SideNav
    current="library"
    onNav={() => {}}
    stats={stats}
    serverOk
    todoCounts={todos.counts}
    dataDir={'E:\\zzl_workbuddy_datas\\招聘agent-data'}
    onManualRefresh={() => {}}
  />,
  [
    '招聘情报看台',
    '候选人库',
    '岗位漏斗',
    '每日简报',
    '人才 Map',
    '智能问答',
    '待办中心',
    '立即刷新',
    // 数据目录必须显示：便携包会因包内目录不可写而改存到用户目录，
    // 不显示的话用户换包/换位置之后会以为简历丢了
    '数据目录',
    '招聘agent-data',
  ]
)

// ---------- 岗位漏斗 ----------
enqueue(
  'PipelineCard',
  <PipelineCard row={pipeRow} onOpenPosition={() => {}} />,
  [pipeRow.title, '候选人', '强推', String(pipeRow.total)]
)

// ---------- 每日简报 ----------
if (briefItem) {
  enqueue('BriefRow', <BriefRow item={briefItem} onOpen={() => {}} />, [
    briefItem.name,
    briefItem.positionTitle,
  ])
}
if (followItem) {
  enqueue('FollowUpRow', <FollowUpRow item={followItem} onOpen={() => {}} />, [
    followItem.name,
    followItem.reason,
  ])
}

// ---------- 人才 Map ----------
enqueue('BarList(城市)', <BarList title="城市分布" items={talentMap.byCity} />, [
  '城市分布',
  talentMap.byCity[0]?.name ?? '',
])
enqueue('SkillCloud', <SkillCloud items={talentMap.bySkill} />, [
  '技能热度',
  talentMap.bySkill[0]?.name ?? '',
])

// ---------- 待办中心 ----------
if (todoItem) {
  enqueue('TodoRow', <TodoRow item={todoItem} onOpen={() => {}} />, [
    todoItem.candidateName,
    todoItem.reason,
  ])
}

// ---------- App 首屏（数据仍在加载中）——验证外壳与导航初始态不崩 ----------
enqueue('App(首屏)', <App />, ['招聘情报看台', '候选人库', '岗位漏斗'])

let failed = 0
for (const [name, html, mustHave] of renders) {
  const missing = mustHave.filter((m) => m && !html.includes(m))
  const okMark = missing.length === 0 ? 'OK  ' : 'FAIL'
  if (missing.length) failed++
  console.log(
    `${okMark} ${name.padEnd(16)} ${String(html.length).padStart(6)} 字节${
      missing.length ? '  缺少: ' + missing.join(' / ') : ''
    }`
  )
}

function enqueue(name: string, node: ReactElement, mustHave: string[]) {
  try {
    renders.push([name, renderToStaticMarkup(node), mustHave])
  } catch (e) {
    renders.push([name, '', [`渲染抛错: ${(e as Error).message}`]])
  }
}

console.log(failed === 0 ? '\n全部组件渲染通过' : `\n${failed} 个组件渲染失败`)
process.exit(failed === 0 ? 0 : 1)
