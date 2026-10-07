import Fastify from 'fastify'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  ApiResult,
  ApplicationStatus,
  AskAnswer,
  CaptureMethod,
  CapturePayload,
  CaptureResult,
  CandidateDetail,
  CandidateFacets,
  CandidateQuery,
  CandidateRow,
  DailyReport,
  DeleteResult,
  IgnoredCandidate,
  Match,
  Paged,
  PipelineData,
  Platform,
  Position,
  PositionInput,
  RevisionInfo,
  Stats,
  TalentMapData,
  TodoData,
} from '@ria/shared'
import { JsonStore, resolveDataDir } from './db/store.ts'
import { STATUS_LABEL } from '@ria/shared'
import { buildCandidateWorkbook, type ExportPreset } from './export-build.ts'
import {
  BATCH_LIMIT,
  flagsFromQuery,
  parseIds,
  pickMatch,
  renderBatchPage,
  renderErrorPage,
  renderSinglePage,
  type PrintCard,
} from './print.ts'
import { loadEnvFile } from './env.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 先加载 .env（开发态从仓库根读取），再解析端口与数据目录
const envFile = loadEnvFile(__dirname)
const PORT = Number(process.env.SERVER_PORT) || 8787

// ------------------------------------------------------------
// 数据层初始化
// ------------------------------------------------------------
// .env 所在目录即仓库根，作为 DATA_DIR 相对路径的基准
const PREFERRED_DATA_DIR = resolveDataDir(__dirname, envFile ? path.dirname(envFile) : undefined)

/**
 * 这个目录能不能写？真的写一个探针文件试，别靠猜。
 * 目录存在但被 ACL 拒绝、被杀软拦住、只读介质 —— 只有真写一次才知道。
 */
function canWriteTo(dir: string): { ok: boolean; error?: NodeJS.ErrnoException } {
  const probe = path.join(dir, `.write-probe-${process.pid}`)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(probe, 'ok', 'utf8')
    fs.unlinkSync(probe)
    return { ok: true }
  } catch (err) {
    try {
      fs.unlinkSync(probe)
    } catch {
      /* ignore */
    }
    return { ok: false, error: err as NodeJS.ErrnoException }
  }
}

/** 包内目录写不进去时的退路：用户目录（一定可写，且与「便携」的语义不冲突） */
function fallbackDataDir(): string {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(base, '招聘agent-data')
}

/**
 * 选一个**真的能写**的数据目录。
 *
 * 为什么要有这层退路：便携包的目标场景是「换一台电脑解压就能用」，而那台电脑的
 * 权限/杀软/磁盘策略谁都说不准。真实踩到过：
 *   `EPERM: operation not permitted, open 'D:\招聘agent-portable\data\candidates.json.tmp'`
 * 一个「双击就要用」的工具，在这种环境下直接起不来是很糟的体验 ——
 * 宁可把数据落到用户目录（并**大声告诉用户落在哪**），也不要什么都不给。
 */
function pickDataDir(): { dir: string; fellBack: boolean; reason?: NodeJS.ErrnoException } {
  const first = canWriteTo(PREFERRED_DATA_DIR)
  if (first.ok) return { dir: PREFERRED_DATA_DIR, fellBack: false }
  const alt = fallbackDataDir()
  const second = canWriteTo(alt)
  if (second.ok) return { dir: alt, fellBack: true, reason: first.error }
  // 两个都不能写：报第一个（用户真正想用的那个）的原因，更贴近他的环境问题
  return { dir: PREFERRED_DATA_DIR, fellBack: false, reason: first.error }
}

const picked = pickDataDir()
const DATA_DIR = picked.dir
const store = new JsonStore(DATA_DIR)

/** 数一下某个数据目录里已存了多少候选人（只看份数，不解析结构） */
function countCandidatesIn(dir: string): number {
  try {
    const arr = JSON.parse(fs.readFileSync(path.join(dir, 'candidates.json'), 'utf8'))
    return Array.isArray(arr) ? arr.length : 0
  } catch {
    return 0
  }
}

/**
 * 「你的数据在另一个目录里」的提醒 —— 便携包最容易让人以为**丢数据**的场景。
 *
 * 真实路径长这样：
 *   ① 包放在 `D:\招聘agent-portable`，包内 `data` 目录不可写（EPERM）
 *      → 0.5.5 自动退到 `%LOCALAPPDATA%\招聘agent-data`，在那儿存了 30 份简历
 *   ② 后来把整个包移到 `C:\Users\<你>\`（或换个位置重新解压），包内 `data` 可写了
 *      → 程序**切回包内的空目录**，于是界面上只有 22 份示例简历
 * 用户看到的现象是「我采的简历全没了」——其实一条都没丢，只是没在用那个目录。
 *
 * 所以这里必须**在灌示例数据之前**主动检查并大声说出来。
 */
function warnAboutOtherData(altDir: string, altCount: number): void {
  const box = '='.repeat(66)
  console.log('')
  console.log(box)
  console.log(`  注意：另一处还有 ${altCount} 份简历，但当前没在用`)
  console.log(box)
  console.log('  当前使用：' + DATA_DIR + (fs.existsSync(path.join(DATA_DIR, 'candidates.json')) ? '' : '（空）'))
  console.log(`  另一处有：${altDir}（${altCount} 份）`)
  console.log('')
  console.log('  两处**不会自动合并**。看板现在显示的是示例数据，你的真实简历在另一处。')
  console.log('')
  console.log('  想把它们找回来，二选一：')
  console.log('    A) 让程序继续用那个目录：用记事本打开本文件夹的 .env，把')
  console.log('         DATA_DIR=data')
  console.log('       改成')
  console.log('         DATA_DIR=' + altDir)
  console.log('       保存后重新启动看板。')
  console.log('    B) 把数据搬进来：先双击「停止看板.bat」，再把')
  console.log('         ' + altDir)
  console.log('       里所有 .json 文件复制到')
  console.log('         ' + DATA_DIR)
  console.log('       然后重新启动。')
  console.log(box)
  console.log('')
}

/**
 * 首次启动（数据目录为空）时自动灌入示例数据，保证「装完就能看到东西」。
 *
 * ⚠️ 这一段是程序**第一次真正写盘**的地方，也是便携包换一台电脑最容易失败的地方 ——
 *    实测在别的电脑上遇到过
 *      `EPERM: operation not permitted, open 'D:\招聘agent-portable\data\candidates.json.tmp'`。
 *    对一个「只想双击一下就用」的人来说，原始堆栈毫无帮助，所以这里要把
 *    写失败收敛成一段能照着做的中文提示（具体原因与解法由 store 层给出）。
 */
function fatalDataWrite(err: unknown): never {
  const box = '='.repeat(66)
  console.error('')
  console.error(box)
  console.error('  启动失败：数据目录写不进去')
  console.error(box)
  console.error(err instanceof Error ? err.message : String(err))
  console.error(box)
  console.error('  数据目录：' + DATA_DIR)
  console.error('')
  process.exit(1)
}

try {
  fs.mkdirSync(DATA_DIR, { recursive: true })

  // ★ 灌示例数据**之前**先查：是不是有一批数据留在「另一处」没用上
  //   （放在前面是因为灌完之后包内目录就不空了，判断条件就不再成立）
  const altDir = fallbackDataDir()
  if (altDir !== DATA_DIR && countCandidatesIn(DATA_DIR) === 0) {
    const altCount = countCandidatesIn(altDir)
    if (altCount > 0) warnAboutOtherData(altDir, altCount)
  }

  if (store.isEmpty() && process.env.SEED_ON_EMPTY !== '0') {
    const n = store.seed()
    console.log(`[store] 数据目录为空，已自动灌入示例数据：${n} 份候选人简历`)
  }
} catch (err) {
  fatalDataWrite(err)
}

// 退路生效时**必须大声说**：否则用户会以为数据还在包里，找不到人会慌
if (picked.fellBack) {
  const box = '='.repeat(66)
  console.log('')
  console.log(box)
  console.log('  注意：包内目录不可写，数据已自动改存到用户目录')
  console.log(box)
  console.log('  原本想用的目录：' + PREFERRED_DATA_DIR)
  console.log('    原因：' + (picked.reason?.code ?? '未知') + '（' + (picked.reason?.message ?? '') + '）')
  console.log('')
  console.log('  现在实际使用：' + DATA_DIR)
  console.log('  看板照常可用，采集的数据都存在上面这个目录里。')
  console.log('')
  console.log('  ⚠️ 修好权限之后请留意：程序会改回用包内目录（那里是空的），')
  console.log('     你的数据**不会自动搬过去** —— 需要手工把下面这个目录里的 json')
  console.log('     复制到包内的 data 目录：')
  console.log('       ' + DATA_DIR)
  console.log('')
  console.log('  想让它存回包内目录（比如为了整包拷走）？按顺序试：')
  console.log('    1) 本文件夹右键 → 属性 → 取消「只读」→ 应用到子文件夹')
  console.log('    2) 把杀毒软件 / Windows「受控文件夹访问」里的 node.exe 放行')
  console.log('    3) 把整个文件夹移到 C:\\Users\\<你的用户名>\\ 下面再启动')
  console.log('    4) 或者直接改 .env 里的 DATA_DIR 指向一个可写目录')
  console.log(box)
  console.log('')
}

/**
 * 定位前端构建产物目录，找到就由本服务一并托管（前后端同源，无需反向代理）。
 * 兼容两种运行形态：
 *   1) 运行编译产物：招聘agent-build/server/index.js → 同级 ../web
 *   2) 开发时跑源码：apps/server/src/index.ts → 向上找到 招聘agent-build/web
 * 找不到就只提供 API（开发模式下前端由 Vite 提供）。
 */
function findWebDist(startDir: string): string | null {
  const envDist = process.env.WEB_DIST
  if (envDist && fs.existsSync(path.join(envDist, 'index.html'))) return envDist

  const sibling = path.resolve(startDir, '..', 'web')
  if (fs.existsSync(path.join(sibling, 'index.html'))) return sibling

  let dir = startDir
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, '招聘agent-build', 'web')
    if (fs.existsSync(path.join(candidate, 'index.html'))) return candidate
    dir = path.dirname(dir)
  }
  return null
}

const app = Fastify({ logger: true })

// 允许 web 看板与浏览器扩展跨域调用
await app.register(cors, { origin: true })

const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data })
const fail = (error: string): ApiResult<never> => ({ ok: false, error })

// ------------------------------------------------------------
// 基础
// ------------------------------------------------------------

/** 健康检查 */
app.get('/api/health', async (): Promise<ApiResult<{ ok: boolean; ts: string; dataDir: string }>> =>
  ok({ ok: true, ts: new Date().toISOString(), dataDir: DATA_DIR })
)

/**
 * 数据版本号 —— 看板「自动刷新」的探针。
 * 任何写操作（扩展推简历 / 改进度 / 重置）都会让 revision 变大；
 * 看板每隔几秒问一次这里，版本变了才去重拉数据。
 * 不直接用 /api/stats 做探针是因为它会现算派生视图，轮询代价高。
 */
app.get('/api/revision', async (): Promise<ApiResult<RevisionInfo>> => ok(store.revisionInfo()))

/** 库内统计（看板顶部卡片） */
app.get('/api/stats', async (): Promise<ApiResult<Stats>> => ok(store.stats()))

/** 岗位列表 */
app.get('/api/positions', async (): Promise<ApiResult<Position[]>> => ok(store.listPositions() as Position[]))

// ------------------------------------------------------------
// 岗位管理（看板后台自己加岗位）
// ------------------------------------------------------------

/** 新建岗位 */
app.post('/api/positions', async (request, reply): Promise<ApiResult<Position>> => {
  const body = (request.body ?? {}) as PositionInput
  if (!body.title?.trim()) {
    void reply.code(400)
    return fail('岗位标题不能为空')
  }
  if (!body.jdText?.trim()) {
    void reply.code(400)
    return fail('JD 正文不能为空')
  }
  const pos = store.createPosition(body)
  app.log.info({ positionId: pos.id, title: pos.title }, '新建岗位')
  return ok(pos as Position)
})

/** 编辑岗位（含改状态：在招 / 暂停 / 关闭） */
app.patch('/api/positions/:id', async (request, reply): Promise<ApiResult<Position>> => {
  const { id } = request.params as { id: string }
  const patch = (request.body ?? {}) as Partial<PositionInput>
  let updated: Position | undefined
  try {
    updated = store.updatePosition(id, patch)
  } catch (e) {
    void reply.code(400)
    return fail((e as Error).message)
  }
  if (!updated) {
    void reply.code(404)
    return fail('岗位不存在')
  }
  return ok(updated)
})

/**
 * 删除岗位。
 * 岗位下还有候选人时**拒绝删除**（会让匹配变成孤儿数据），改为提示停用。
 */
app.delete(
  '/api/positions/:id',
  async (request, reply): Promise<ApiResult<{ deleted: boolean; matchCount: number }>> => {
    const { id } = request.params as { id: string }
    const result = store.deletePosition(id)
    if (!result.deleted) {
      // 信封必须和 HTTP 状态一致：409 + ok:false。
      // 之前是 409 + ok:true，前端两套判断都得写，属于自找的麻烦。
      void reply.code(result.reason === '岗位不存在' ? 404 : 409)
      return fail(result.reason ?? '删除失败')
    }
    app.log.info({ positionId: id }, '删除岗位')
    return ok({ deleted: true, matchCount: 0 })
  }
)

/** 按当前在招岗位，给「还没有岗位匹配」的候选人补跑一次匹配 */
app.post('/api/rematch', async (): Promise<ApiResult<{ matched: number; skipped: number }>> =>
  ok(store.rematchUnmatched())
)

// ------------------------------------------------------------
// 候选人库
// ------------------------------------------------------------

/**
 * 候选人检索
 * 支持：关键词 q、岗位 positionId、来源 platform、进度 status、匹配度下限 minScore、排序 sort、
 *      以及字段级筛选 city/degree/educationMode/schoolTier/年龄区间/年限区间/language/
 *      captureMethod/capturedWithinDays/hasContact，分页 limit/offset
 */
app.get(
  '/api/candidates',
  async (request): Promise<ApiResult<Paged<CandidateRow>>> => {
    const raw = (request.query ?? {}) as Record<string, unknown>
    return ok(store.query(candidateQueryOf(raw)))
  }
)

/**
 * 只回 id 列表（「勾选全部命中」用）。
 *
 * ⚠️ 必须注册在 `/api/candidates/:id` **之前**：虽然 Fastify 的路由器优先匹配静态段，
 *    但把静态路由写在参数路由后面是靠框架实现细节吃饭 —— 显式排在前面不需要这份运气。
 */
app.get(
  '/api/candidates/ids',
  async (request): Promise<ApiResult<{ ids: string[]; total: number; truncated: boolean }>> => {
    const raw = (request.query ?? {}) as Record<string, unknown>
    return ok(store.queryIds(candidateQueryOf(raw)))
  }
)

/** 筛选下拉的可选值（数据里真实存在的城市/学历/统招/院校层次/语言 + 人数） */
app.get(
  '/api/candidates/facets',
  async (): Promise<ApiResult<CandidateFacets>> => ok(store.facets())
)

/** 候选人详情：一人一档 + 各岗位匹配 + 全部来源 */
app.get(
  '/api/candidates/:id',
  async (request, reply): Promise<ApiResult<CandidateDetail>> => {
    const { id } = request.params as { id: string }
    const detail = store.detail(id)
    if (!detail) {
      void reply.code(404)
      return fail('候选人不存在')
    }
    return ok(detail)
  }
)

/** 更新候选人在某岗位下的推进进度 */
app.patch(
  '/api/candidates/:id/matches/:positionId',
  async (request, reply): Promise<ApiResult<{ updated: boolean }>> => {
    const { id, positionId } = request.params as { id: string; positionId: string }
    const body = (request.body ?? {}) as { status?: ApplicationStatus }
    if (!body.status) {
      void reply.code(400)
      return fail('缺少 status 字段')
    }
    const updated = store.updateMatchStatus(id, positionId, body.status)
    if (!updated) {
      void reply.code(404)
      return fail('未找到该候选人与岗位的匹配记录')
    }
    return ok({ updated: true })
  }
)

/**
 * 手动把候选人挂到某岗位 —— 「规则猜错了」和「这个人其实适合两个岗位」都靠它纠错。
 * 幂等：已挂则原样返回，不会重复建档。
 */
app.post(
  '/api/candidates/:id/matches',
  async (request, reply): Promise<ApiResult<Match>> => {
    const { id } = request.params as { id: string }
    const body = (request.body ?? {}) as { positionId?: string }
    if (!body.positionId) {
      void reply.code(400)
      return fail('缺少 positionId')
    }
    const m = store.addMatch(id, body.positionId, 'manual')
    if (!m) {
      void reply.code(404)
      return fail('候选人不存在，或该岗位不存在')
    }
    return ok(m)
  }
)

/** 取消候选人在某岗位下的挂靠 */
app.delete(
  '/api/candidates/:id/matches/:positionId',
  async (request, reply): Promise<ApiResult<{ removed: boolean }>> => {
    const { id, positionId } = request.params as { id: string; positionId: string }
    const removed = store.removeMatch(id, positionId)
    if (!removed) {
      void reply.code(404)
      return fail('没有找到这条岗位挂靠记录')
    }
    return ok({ removed: true })
  }
)

// ------------------------------------------------------------
// 采集入口（浏览器扩展 → 后端）
// ------------------------------------------------------------

/**
 * 接收扩展上报的简历。
 * 去重键：(platform, platformCandidateId)；重复上报只刷新抓取时间，不产生重复档案。
 */
app.post(
  '/api/capture',
  async (request, reply): Promise<ApiResult<CaptureResult>> => {
    const payload = request.body as CapturePayload | undefined
    if (!payload?.platform || !payload?.platformCandidateId) {
      void reply.code(400)
      return fail('payload 需包含 platform 与 platformCandidateId')
    }
    const result = store.ingestCapture(payload)
    app.log.info(
      {
        platform: payload.platform,
        id: payload.platformCandidateId,
        action: result.action,
        autoMatched: result.autoMatched ?? 'none',
      },
      result.duplicated ? '重复采集，已刷新时间' : '新增候选人档案（已做规则初筛匹配）'
    )
    return ok(result)
  }
)

// ------------------------------------------------------------
// 派生视图：岗位漏斗 / 每日简报 / 人才地图 / 待办 / 智能问答
// 说明：这些都不是独立的表，而是从 candidates / matches / sources 现算出来的视图。
//       放进后端算的原因——只有后端能看到全量数据，前端分页拿不全。
// ------------------------------------------------------------

/** 岗位漏斗：每个岗位各进度状态下的人数 */
app.get('/api/pipeline', async (): Promise<ApiResult<PipelineData>> => ok(store.pipeline()))

/** 每日简报：今日新增 / 今日推荐 / 待跟进 / 岗位摘要 */
app.get('/api/daily', async (): Promise<ApiResult<DailyReport>> => ok(store.dailyReport()))

/** 人才地图：城市 / 公司 / 院校 / 学历 / 技能 / 年限 + 岗位技能矩阵 */
app.get('/api/talent-map', async (): Promise<ApiResult<TalentMapData>> => ok(store.talentMap()))

/** 待办中心：按「卡住了 / 高分没人管」规则生成的跟进清单 */
app.get('/api/todos', async (): Promise<ApiResult<TodoData>> => ok(store.todos()))

/** 智能问答：用 GET 便于把问题分享成链接 */
app.get('/api/ask', async (request): Promise<ApiResult<AskAnswer>> => {
  const raw = (request.query ?? {}) as { q?: string }
  return ok(store.ask(raw.q ?? ''))
})

// ------------------------------------------------------------
// 运维（本地调试用）
// ------------------------------------------------------------

/** 重置为示例数据（看板上的「重置示例数据」按钮调用） */
app.post('/api/admin/reset', async (): Promise<ApiResult<{ candidateCount: number }>> => {
  const n = store.seed()
  app.log.warn({ candidateCount: n }, '已重置为示例数据')
  return ok({ candidateCount: n })
})

// ------------------------------------------------------------
// 简历打印页（浏览器打印 → PDF）
// 说明：返回的是 text/html 而不是 ok()/fail() 信封 —— 这是给人看的页面，
//       不是给程序消费的接口。正文来自外部网站，渲染层（print.ts）全程 esc()。
// ------------------------------------------------------------

/** 详情 + 岗位选择 → 打印页的卡片模型 */
function toPrintCard(
  detail: CandidateDetail,
  positionId: string | undefined,
  index?: number,
  total?: number
): PrintCard {
  const picked = pickMatch(detail.matches, positionId)
  return { id: detail.candidate.id, detail, positionTitle: picked.positionTitle, match: picked.match, index, total }
}

/** 单人简历打印页：/print/:candidateId */
app.get('/print/:candidateId', async (request, reply) => {
  const { candidateId } = request.params as { candidateId: string }
  const q = (request.query ?? {}) as Record<string, unknown>
  const flags = flagsFromQuery(q)
  const positionId = typeof q.positionId === 'string' && q.positionId ? q.positionId : undefined

  const detail = store.detail(candidateId)
  if (!detail) {
    void reply.code(404)
    return reply
      .type('text/html; charset=utf-8')
      .send(renderErrorPage(404, '候选人不存在', `没有找到 id 为「${candidateId}」的候选人。`))
  }

  return reply
    .type('text/html; charset=utf-8')
    .send(renderSinglePage(toPrintCard(detail, positionId), flags))
})

/**
 * 「按岗位批量导出」：该岗位下全部候选人，按匹配分从高到低。
 *
 * 取数来源刻意是 **matches 表**（`query({ positionId })` 里 positionId 就走
 * matches→候选人的关联），而不是「先分页拉候选人再在前端筛岗位」——
 * 后者在人多时会漏人，而漏人对「导出发业务」是致命的。
 * limit 给一个足够大的值让存储层负责截断前的排序，真正的 50 人上限在调用处收口。
 */
function candidateIdsOfPosition(positionId: string, limit: number): string[] {
  const paged = store.query({ positionId, sort: 'score', limit })
  return paged.items
    .filter((row) => row.positionId === positionId)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .map((row) => row.candidate.id)
}

/**
 * 批量简历打印页：`/print/batch?ids=a,b,c` 或 `/print/batch?positionId=xxx`
 *
 * 两种取法：
 *   · ids    —— 显式列表，**优先级最高**（给了 ids 就完全忽略 positionId 的取人语义）
 *   · positionId —— 该岗位下全部候选人，按分数从高到低
 * 两者给人的「应聘岗位」都用传入的 positionId（若给），保证页眉印的岗位
 * 和这次导出的岗位是同一个。
 */
app.get('/print/batch', async (request, reply) => {
  const q = (request.query ?? {}) as Record<string, unknown>
  const flags = flagsFromQuery(q)
  const positionId = typeof q.positionId === 'string' && q.positionId.trim() ? q.positionId.trim() : undefined
  const htmlError = (code: number, heading: string, message: string) => {
    void reply.code(code)
    return reply.type('text/html; charset=utf-8').send(renderErrorPage(code, heading, message))
  }
  const hasIds = String(q.ids ?? '').trim().length > 0

  let ids: string[] = []
  let missing: string[] = []
  let requested = 0

  if (hasIds) {
    // ① ids 优先
    const parsed = parseIds(q.ids)
    ids = parsed.ids
    requested = parsed.requested
  } else if (positionId) {
    // ② 按岗位取人
    const position = store.listPositions().find((p) => p.id === positionId)
    if (!position) {
      return htmlError(400, '岗位不存在', `没有找到 id 为「${positionId}」的岗位，无法按岗位导出简历。`)
    }
    // 先把该岗位下的候选人数拿全，再截断到上限（截断数要如实写在页面上）
    const all = candidateIdsOfPosition(positionId, 500)
    if (all.length === 0) {
      return htmlError(
        400,
        '该岗位下还没有候选人',
        `岗位「${position.title}」目前没有任何候选人，无法按岗位导出简历。`
      )
    }
    requested = all.length
    ids = all.slice(0, BATCH_LIMIT)
  } else {
    return htmlError(
      400,
      '缺少 ids 与 positionId',
      '批量打印需要指定候选人：/print/batch?ids=id1,id2 或 /print/batch?positionId=岗位id'
    )
  }

  const details: CandidateDetail[] = []
  for (const id of ids) {
    const d = store.detail(id)
    if (d) details.push(d)
    else missing.push(id)
  }
  if (details.length === 0) {
    return htmlError(400, '没有有效的候选人', `传入的 ${ids.length} 个 id 都找不到对应候选人。`)
  }

  const cards = details.map((d, i) => toPrintCard(d, positionId, i + 1, details.length))
  app.log.info(
    { found: details.length, requested, byPosition: !hasIds, positionId, limit: BATCH_LIMIT },
    '批量打印简历'
  )

  return reply
    .type('text/html; charset=utf-8')
    .send(renderBatchPage(cards, flags, { requested, kept: details.length, missing }))
})

// ============================================================
// 导出 Excel
// ============================================================

/**
 * 把查询串解析成候选人查询条件。
 *
 * ⚠️ `/api/candidates`、`/api/candidates/ids`、`/api/export/candidates.xlsx` **共用这一个函数** ——
 *    三处各解析一遍的话，很容易出现「列表按 A 条件筛、导出按 B 条件筛」这种
 *    用户完全看不出来的错位。
 */
function candidateQueryOf(raw: Record<string, unknown>): CandidateQuery {
  const s = (k: string): string | undefined => {
    const v = raw[k]
    return typeof v === 'string' && v.trim() ? v.trim() : undefined
  }
  /** 数字参数：空串 / 非数字一律当「没传」，绝不让 NaN 漏进存储层 */
  const n = (k: string): number | undefined => {
    const v = s(k)
    if (v === undefined) return undefined
    const x = Number(v)
    return Number.isFinite(x) ? x : undefined
  }
  return {
    q: s('q'),
    positionId: s('positionId'),
    platform: s('platform') as Platform | undefined,
    status: s('status') as ApplicationStatus | undefined,
    minScore: n('minScore'),
    sort: s('sort') as CandidateQuery['sort'],
    unmatched: raw.unmatched === 'true' || raw.unmatched === '1' ? true : undefined,
    // ---- 字段级筛选 ----
    city: s('city'),
    degree: s('degree'),
    educationMode: s('educationMode'),
    schoolTier: s('schoolTier'),
    minAge: n('minAge'),
    maxAge: n('maxAge'),
    minYears: n('minYears'),
    maxYears: n('maxYears'),
    language: s('language'),
    captureMethod: s('captureMethod') as CaptureMethod | undefined,
    capturedWithinDays: n('capturedWithinDays'),
    hasContact: raw.hasContact === 'true' || raw.hasContact === '1' ? true : undefined,
    limit: n('limit'),
    offset: n('offset'),
  }
}

/** 文件名里不能出现的字符（Windows 比 POSIX 严：`应用工程师 / FAE` 真的会挂） */
function sanitizeFilenamePart(s: string): string {
  const cleaned = String(s || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .trim()
  return cleaned.slice(0, 100) || '全部岗位'
}

/** `<岗位>_<日期>_推荐名单.xlsx` */
function exportFilename(positionTitle: string | undefined, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const date = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
  return `${sanitizeFilenamePart(positionTitle || '全部岗位')}_${date}_推荐名单.xlsx`
}

/**
 * 中文文件名**必须双写**：`filename=` 给只认 ASCII 的老客户端（会变乱码但不报错），
 * `filename*=UTF-8''…` 给现代浏览器。只写前者是中文文件名乱码最常见的原因。
 */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

/** 把筛选条件写成一句人话，放进「导出信息」sheet */
function describeFilters(raw: Record<string, unknown>, positionTitle?: string): string {
  const parts: string[] = []
  parts.push(`岗位：${positionTitle || '全部岗位'}`)
  const q = typeof raw.q === 'string' ? raw.q.trim() : ''
  if (q) parts.push(`关键词：${q}`)
  if (typeof raw.platform === 'string' && raw.platform) parts.push(`平台：${raw.platform}`)
  if (typeof raw.status === 'string' && raw.status) parts.push(`进度：${STATUS_LABEL[raw.status as ApplicationStatus] ?? raw.status}`)
  if (raw.minScore !== undefined && String(raw.minScore) !== '') parts.push(`最低匹配度：${raw.minScore}`)
  return parts.join('；')
}

/**
 * 导出候选人 Excel。
 *
 * 导出的是**当前筛选结果的全部**（忽略分页）—— 这才是「我筛选完成后导出来」的用法。
 * 服务端生成真正的 .xlsx（零依赖，见 export-build.ts），浏览器直接下载，
 * 前端不需要引入任何表格库。
 */
app.get('/api/export/candidates.xlsx', async (request, reply) => {
  const raw = (request.query ?? {}) as Record<string, unknown>
  const preset: ExportPreset = raw.preset === 'full' ? 'full' : 'brief'
  const query = candidateQueryOf(raw)

  // 勾选导出：给了 ids 就**只导这些人**（忽略筛选条件），与 /print/batch 的取舍一致 ——
  // 用户明确勾了 8 个人，期望就是这 8 个，而不是「当前筛选的全部」。
  const picked = parseIds(raw.ids, 5000).ids
  const { rows, total, truncated } = store.exportRows(query, 5000, picked.length > 0 ? picked : undefined)

  if (rows.length === 0) {
    // 宁可明确报错，也不下发一个只有表头的空文件 ——
    // 空表格容易被误读成「没有人符合条件」之外的意思
    void reply.code(400)
    return fail(picked.length > 0 ? '勾选的候选人都不存在，无法导出' : '当前筛选没有候选人，无法导出')
  }

  const positionTitle = query.positionId
    ? store.listPositions().find((p) => p.id === query.positionId)?.title
    : undefined
  const buf = buildCandidateWorkbook(rows, {
    preset,
    positionTitle,
    // 表头注释要写清「这份表是哪来的」：勾选导出和筛选导出的来源完全不同，
    // 事后拿到表格的人得能看懂为什么是这些人
    filterNote:
      picked.length > 0 ? `手动勾选的 ${picked.length} 人（共导出 ${rows.length} 人）` : describeFilters(raw, positionTitle),
    truncated,
    total,
  })
  const filename = exportFilename(positionTitle)
  app.log.info({ rows: rows.length, total, preset, filename, byIds: picked.length > 0 }, '导出候选人 Excel')

  return reply
    .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .header('Content-Disposition', contentDisposition(filename))
    .send(buf)
})

// ============================================================
// 删除候选人 / 「不再采集」名单
// ============================================================

/** 删除一位候选人（级联删来源与匹配；可选加入「不再采集」名单） */
app.delete(
  '/api/candidates/:id',
  async (request, reply): Promise<ApiResult<DeleteResult>> => {
    const { id } = request.params as { id: string }
    const q = (request.query ?? {}) as Record<string, unknown>
    const forget = q.forget === '1' || q.forget === 'true'
    const result = store.deleteCandidate(id, forget)
    if (!result.deleted) {
      void reply.code(404)
      return fail(result.reason ?? '删除失败')
    }
    app.log.info({ candidateId: id, forget, ...result }, '删除候选人')
    return ok(result)
  }
)

/** 批量删除（库内「删除选中」） */
app.post(
  '/api/candidates/delete',
  async (request, reply): Promise<ApiResult<{ deleted: number; forgot: number }>> => {
    const body = (request.body ?? {}) as { ids?: unknown; forget?: unknown }
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string' && !!x) : []
    if (ids.length === 0) {
      void reply.code(400)
      return fail('没有指定要删除的候选人')
    }
    // 上限只是防误操作把整库带走；真要删 200 个也允许分两次
    if (ids.length > 500) {
      void reply.code(400)
      return fail(`一次最多删除 500 人（本次 ${ids.length} 人）`)
    }
    const forget = body.forget === true
    const result = store.deleteCandidates(ids, forget)
    app.log.info({ requested: ids.length, forget, ...result }, '批量删除候选人')
    return ok(result)
  }
)

/** 「不再采集」名单 */
app.get('/api/ignored', async (): Promise<ApiResult<{ items: IgnoredCandidate[]; total: number }>> => {
  const items = store.listIgnored()
  return ok({ items, total: items.length })
})

/** 移出「不再采集」名单（恢复采集） */
app.delete(
  '/api/ignored/:id',
  async (request, reply): Promise<ApiResult<{ removed: boolean }>> => {
    const { id } = request.params as { id: string }
    const removed = store.removeIgnored(id)
    if (!removed) {
      void reply.code(404)
      return fail('名单里没有这一条')
    }
    app.log.info({ ignoredId: id }, '移出不再采集名单')
    return ok({ removed })
  }
)

// ---- 静态托管前端产物（放在最后，避免抢占 /api 路由）----
const webDist = findWebDist(__dirname)
if (webDist) {
  await app.register(fastifyStatic, { root: webDist, prefix: '/' })
  // SPA 回退：非 /api 的未知路径一律交给前端路由
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ ok: false, error: '接口不存在' })
    }
    return reply.sendFile('index.html')
  })
  app.log.info(`已托管前端静态产物：${webDist}`)
} else {
  app.log.warn('未找到前端构建产物，当前仅提供 API（开发模式下前端由 Vite 提供）')
}

await app.listen({ port: PORT, host: '0.0.0.0' })
console.log(`\n招聘情报 Agent 已启动：http://localhost:${PORT}`)
console.log(`数据目录：${DATA_DIR}`)
if (envFile) console.log(`配置文件：${envFile}`)
if (webDist) console.log(`看板入口：http://localhost:${PORT}/`)
