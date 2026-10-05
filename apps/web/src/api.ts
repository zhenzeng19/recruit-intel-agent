// ============================================================
// 前端 API 客户端
// 统一走相对路径 /api —— 生产环境下前端由后端同源托管，开发环境下由 Vite 代理。
// ============================================================
import type {
  ApiResult,
  ApplicationStatus,
  AskAnswer,
  CandidateDetail,
  CandidateQuery,
  CandidateRow,
  DailyReport,
  IgnoredCandidate,
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

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, init)
  let json: ApiResult<T>
  try {
    json = (await resp.json()) as ApiResult<T>
  } catch {
    throw new Error(`接口返回异常（HTTP ${resp.status}）`)
  }
  if (!json.ok || json.data === undefined) {
    throw new Error(json.error || `请求失败（HTTP ${resp.status}）`)
  }
  return json.data
}

export function fetchStats(): Promise<Stats> {
  return request<Stats>('/api/stats')
}

/**
 * 数据版本探针。看板每隔几秒问一次，版本变了才去重拉数据 ——
 * 这样扩展在别的标签页把简历推进后端时，看板能自己刷新，不用手动 F5。
 */
export function fetchRevision(): Promise<RevisionInfo> {
  return request<RevisionInfo>('/api/revision')
}

/** 岗位列表里带的人数：后端在 Position 上多挂了一个 candidateCount */
export type PositionWithCount = Position & { candidateCount: number }

export function fetchPositions(): Promise<PositionWithCount[]> {
  return request<PositionWithCount[]>('/api/positions')
}

/** 新建岗位（缺 title / jdText 时后端返回 400，request 会抛出后端给的文案） */
export function createPosition(input: PositionInput): Promise<Position> {
  return request<Position>('/api/positions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function updatePosition(id: string, patch: Partial<PositionInput>): Promise<Position> {
  return request<Position>(`/api/positions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

/**
 * 删除岗位。岗位下还有候选人时后端拒绝删除（HTTP 409）：
 * 这里不自己编文案 —— 后端返回的 error 已经解释清楚「为什么该停用而不是删除」。
 */
export function deletePosition(
  id: string
): Promise<{ deleted: boolean; matchCount: number; reason?: string }> {
  return request<{ deleted: boolean; matchCount: number; reason?: string }>(
    `/api/positions/${encodeURIComponent(id)}`,
    { method: 'DELETE' }
  )
}

/** 给「还没归到岗位」的候选人按当前在招岗位补跑一次匹配 */
export function rematchCandidates(): Promise<{ matched: number; skipped: number }> {
  return request<{ matched: number; skipped: number }>('/api/rematch', { method: 'POST' })
}

export function fetchCandidates(query: CandidateQuery): Promise<Paged<CandidateRow>> {
  const params = new URLSearchParams()
  if (query.q) params.set('q', query.q)
  if (query.positionId) params.set('positionId', query.positionId)
  if (query.platform) params.set('platform', query.platform)
  if (query.status) params.set('status', query.status)
  if (query.minScore !== undefined) params.set('minScore', String(query.minScore))
  if (query.sort) params.set('sort', query.sort)
  if (query.unmatched) params.set('unmatched', 'true')
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  if (query.offset !== undefined) params.set('offset', String(query.offset))
  return request<Paged<CandidateRow>>(`/api/candidates?${params.toString()}`)
}

export function fetchCandidateDetail(id: string): Promise<CandidateDetail> {
  return request<CandidateDetail>(`/api/candidates/${encodeURIComponent(id)}`)
}

export function resetDemoData(): Promise<{ candidateCount: number }> {
  return request<{ candidateCount: number }>('/api/admin/reset', { method: 'POST' })
}

export function updateMatchStatus(
  candidateId: string,
  positionId: string,
  status: ApplicationStatus
): Promise<{ updated: boolean }> {
  return request<{ updated: boolean }>(
    `/api/candidates/${encodeURIComponent(candidateId)}/matches/${encodeURIComponent(positionId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    }
  )
}

// ------------------------------------------------------------
// 派生视图（岗位漏斗 / 每日简报 / 人才地图 / 待办 / 问答）
// ------------------------------------------------------------

export function fetchPipeline(): Promise<PipelineData> {
  return request<PipelineData>('/api/pipeline')
}

export function fetchDaily(): Promise<DailyReport> {
  return request<DailyReport>('/api/daily')
}

export function fetchTalentMap(): Promise<TalentMapData> {
  return request<TalentMapData>('/api/talent-map')
}

export function fetchTodos(): Promise<TodoData> {
  return request<TodoData>('/api/todos')
}

export function askQuestion(question: string): Promise<AskAnswer> {
  return request<AskAnswer>(`/api/ask?q=${encodeURIComponent(question)}`)
}

// ------------------------------------------------------------
// 候选人删除 / 不再采集名单
// ------------------------------------------------------------

/**
 * 删除单个候选人。
 * forget=true 表示「同时设为不再采集此人」—— 服务端会在他下次被采到时直接忽略，
 * 所以删掉之后扩展又打开他的简历也不会再进库。
 */
export function deleteCandidate(
  id: string,
  forget: boolean
): Promise<{ deleted: boolean; forgot: boolean }> {
  const sp = new URLSearchParams()
  // 显式带上 0，不留一个光秃秃的 `?`；服务端也把缺省当 false
  sp.set('forget', forget ? '1' : '0')
  return request<{ deleted: boolean; forgot: boolean }>(
    `/api/candidates/${encodeURIComponent(id)}?${sp.toString()}`,
    { method: 'DELETE' }
  )
}

/** 批量删除。forget 缺省 = false（服务端默认值），批量时前端刻意默认不勾 */
export function deleteCandidates(
  ids: string[],
  forget = false
): Promise<{ deleted: number; forgot: number }> {
  return request<{ deleted: number; forgot: number }>('/api/candidates/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, forget }),
  })
}

/**
 * 「不再采集名单」一条 = 共享包里的 IgnoredCandidate（平台是 Platform 枚举）。
 * 就近再导出一次，调用方只 import 本文件即可。
 */
export type IgnoredItem = IgnoredCandidate

export function fetchIgnored(): Promise<{ items: IgnoredItem[]; total: number }> {
  return request<{ items: IgnoredItem[]; total: number }>('/api/ignored')
}

/** 从名单里移除（恢复采集） */
export function restoreIgnored(id: string): Promise<{ removed: boolean }> {
  return request<{ removed: boolean }>(`/api/ignored/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

// ------------------------------------------------------------
// 简历导出（打印页）
// ------------------------------------------------------------
// 打印页是**服务端渲染的整页 HTML**（不是 XHR 接口），所以这里不返回 Promise，
// 只负责拼 URL；调用方 window.open 打开它，页面加载后自动唤起浏览器打印对话框，
// 用户在对话框里选「另存为 PDF」。
//
// 为什么用浏览器打印而不是服务端生成 PDF：
//   ① 本机已确认无头 Chrome 拿不到输出（踩过两次）；
//   ② PDF 库必须嵌入中文字体（10~20MB）+ 手写排版。
//   浏览器打印用系统字体栈，中文不会乱码，零新增依赖，便携包里也能用。

export interface PrintOptions {
  /** 页眉上印的「应聘岗位」；不传则用分数最高的那个匹配 */
  positionId?: string
  /** 印匹配度与命中点/缺失点（默认 true） */
  score?: boolean
  /** 页脚印来源链接与采集时间（默认 true） */
  source?: boolean
  /** 附「未结构化原文」附录（默认 true） */
  raw?: boolean
  /** 打开后自动唤起打印对话框（默认 true） */
  auto?: boolean
}

const PRINT_OPTS_KEY = 'ria_print_options'

/** 记住上次的导出选项 —— 每次都要重勾很烦 */
export function loadPrintOptions(): PrintOptions {
  try {
    return JSON.parse(localStorage.getItem(PRINT_OPTS_KEY) || '{}') as PrintOptions
  } catch {
    return {}
  }
}

export function savePrintOptions(opts: PrintOptions): void {
  try {
    localStorage.setItem(PRINT_OPTS_KEY, JSON.stringify(opts))
  } catch {
    /* ignore */
  }
}

function printQuery(opts: PrintOptions): string {
  const sp = new URLSearchParams()
  if (opts.positionId) sp.set('positionId', opts.positionId)
  sp.set('score', opts.score === false ? '0' : '1')
  sp.set('source', opts.source === false ? '0' : '1')
  sp.set('raw', opts.raw === false ? '0' : '1')
  sp.set('auto', opts.auto === false ? '0' : '1')
  return sp.toString()
}

export function printUrl(candidateId: string, opts: PrintOptions = {}): string {
  return `/print/${encodeURIComponent(candidateId)}?${printQuery(opts)}`
}

/** 批量：把多份简历合成一个多页 PDF（每人从新页开始） */
export function printBatchUrl(candidateIds: string[], opts: PrintOptions = {}): string {
  const sp = new URLSearchParams()
  sp.set('ids', candidateIds.join(','))
  return `/print/batch?${sp.toString()}&${printQuery(opts)}`
}

/**
 * 批量（按岗位）：导出某个岗位下的**全部候选人** ——
 * 这才是「分岗位给业务部门」的正解，比逐份导出实用。
 * 传递的是 positionId 而不是 id 列表，因为岗位卡片上只有人数、没有候选人的 id。
 */
export function printPositionUrl(positionId: string, opts: PrintOptions = {}): string {
  const sp = new URLSearchParams()
  sp.set('positionId', positionId)
  return `/print/batch?${sp.toString()}&${printQuery({ ...opts, positionId })}`
}

// ------------------------------------------------------------
// 导出 Excel（xlsx 附件）
// ------------------------------------------------------------
// 这一条是**真附件下载**，不走 request<T>：服务端直接吐 .xlsx 字节流，
// 前端只要拼好 URL 让浏览器自己下就行（<a download> 点一下）。
// 也正因为不走 XHR，失败时拿不到 JSON —— 0 条命中会是一张 400 的中文 HTML 错误页，
// 所以调用方必须先用列表的 total 挡住，别让用户平白看到一张错误页。

export type ExportPreset = 'brief' | 'full'

const EXPORT_PRESET_KEY = 'ria_export_preset'

/**
 * 拼导出 URL。查询参数与 /api/candidates 完全一致（复用 fetchCandidates 的拼法），
 * 但**不带 limit / offset** —— 服务端忽略分页、导出当前筛选的全部命中。
 */
export function candidateExportUrl(query: CandidateQuery, preset: ExportPreset): string {
  const params = new URLSearchParams()
  if (query.q) params.set('q', query.q)
  if (query.positionId) params.set('positionId', query.positionId)
  if (query.platform) params.set('platform', query.platform)
  if (query.status) params.set('status', query.status)
  if (query.minScore !== undefined) params.set('minScore', String(query.minScore))
  if (query.sort) params.set('sort', query.sort)
  if (query.unmatched) params.set('unmatched', 'true')
  params.set('preset', preset)
  return `/api/export/candidates.xlsx?${params.toString()}`
}

/** 记住上次选的列预设 —— 每次导出都要重选很烦 */
export function loadExportPreset(): ExportPreset {
  try {
    return localStorage.getItem(EXPORT_PRESET_KEY) === 'full' ? 'full' : 'brief'
  } catch {
    return 'brief'
  }
}

export function saveExportPreset(p: ExportPreset): void {
  try {
    localStorage.setItem(EXPORT_PRESET_KEY, p)
  } catch {
    /* ignore */
  }
}

export type { Platform }
