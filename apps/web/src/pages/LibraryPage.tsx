import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  ApplicationStatus,
  CandidateDetail,
  CandidateFacets,
  CandidateRow,
  Position,
  Stats,
} from '@ria/shared'
import {
  candidateExportUrl,
  deleteCandidates,
  fetchCandidateDetail,
  fetchCandidateFacets,
  fetchCandidateIds,
  fetchCandidates,
  fetchIgnored,
  fetchPositions,
  fetchStats,
  loadExportPreset,
  loadPrintOptions,
  printBatchUrl,
  resetDemoData,
  saveExportPreset,
  updateMatchStatus,
  type ExportPreset,
} from '../api'
import { CandidateCard } from '../components/CandidateCard'
import { CandidateDrawer } from '../components/CandidateDrawer'
import { EMPTY_FILTER, FilterPanel, type FilterValue } from '../components/FilterPanel'
import { IgnoreListPanel } from '../components/IgnoreListPanel'
import { StatsBar, type StatsShortcut } from '../components/StatsBar'

/** 服务端 /api/candidates/delete 一次最多删 500 人 —— 前端同步挡一下，别让用户白点一次 */
const BULK_DELETE_MAX = 500

/**
 * 批量导出 PDF 的上限。**必须与 `apps/server/src/print.ts` 的 `BATCH_LIMIT` 保持一致**
 * （服务端是最终裁判，前端只是提前挡住，别让用户点了才发现少了几十份）。
 */
const PRINT_BATCH_MAX = 200
/** 超过这个人数先确认 —— 打印是同步阻塞的，上百份简历会让浏览器卡几十秒 */
const PRINT_CONFIRM_AT = 50

/**
 * 每页条数档位（服务端 limit 上限 500）。
 *
 * 特意带上 20：库里几十人时，50 一页意味着**永远翻不到第二页** ——
 * 分页做了却看不见效果，用户会以为没做。20 一页让「翻页」在真实数据量下也看得见。
 */
const PAGE_SIZES = [20, 50, 100, 200]

/**
 * 候选人库（#/library）
 * 支持从别的页面带参进来：?c=<候选人ID> 直接打开详情，?p=<岗位ID> 预设岗位筛选。
 */
export function LibraryPage({
  initialCandidateId,
  initialPositionId,
  refreshToken,
  onDataChanged,
}: {
  initialCandidateId?: string
  initialPositionId?: string
  /** 数据版本令牌：外部（扩展采集）写入新数据时由外壳 +1，触发本页重拉 */
  refreshToken?: number
  onDataChanged?: () => void
}) {
  const [stats, setStats] = useState<Stats | null>(null)
  const [positions, setPositions] = useState<Position[]>([])
  const [rows, setRows] = useState<CandidateRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [filter, setFilter] = useState<FilterValue>(() => ({
    ...EMPTY_FILTER,
    positionId: initialPositionId,
  }))
  const [qInput, setQInput] = useState('')
  const [resetting, setResetting] = useState(false)

  const [selectedId, setSelectedId] = useState<string | null>(initialCandidateId ?? null)
  /** 勾选的人（批量导出 PDF / Excel / 批量删除）—— 跨页保留，翻页不会丢 */
  const [picked, setPicked] = useState<Set<string>>(() => new Set())
  const [pickingAll, setPickingAll] = useState(false)

  // ---- 分页 ----
  // page 是 0 基的页码；筛选条件一变必须回第 1 页，否则会停在一个空页上。
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0])

  // ---- 筛选下拉的可选值 ----
  const [facets, setFacets] = useState<CandidateFacets | null>(null)

  const [detail, setDetail] = useState<CandidateDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  // ---- 导出 Excel：列预设 + 错误提示 ----
  const [preset, setPreset] = useState<ExportPreset>(() => loadExportPreset())
  const [exportErr, setExportErr] = useState<string | null>(null)

  // ---- 批量删除：确认条 + 勾选「同时设为不再采集」 ----
  const [confirmDelete, setConfirmDelete] = useState(false)
  // 批量时默认**不勾**：勾错了会让一批人以后再也采不进来，代价太大
  const [bulkForget, setBulkForget] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [bulkErr, setBulkErr] = useState<string | null>(null)
  /** 删除成功后的提示，几秒后自动消失 */
  const [done, setDone] = useState<string | null>(null)

  // ---- 不再采集名单 ----
  const [ignoredCount, setIgnoredCount] = useState(0)
  const [showIgnored, setShowIgnored] = useState(false)

  // 从别的页面点「查看」带 c= 参数进来时，自动打开详情抽屉
  useEffect(() => {
    if (initialCandidateId) setSelectedId(initialCandidateId)
  }, [initialCandidateId])

  // 带 p= 参数进来（例如从岗位漏斗点某个岗位）时，预设岗位筛选
  useEffect(() => {
    if (initialPositionId) setFilter((f) => ({ ...f, positionId: initialPositionId }))
  }, [initialPositionId])

  // ---- 关键词输入防抖（250ms），避免每敲一个字都打一次接口 ----
  useEffect(() => {
    const t = window.setTimeout(() => {
      setFilter((f) => (f.q === qInput ? f : { ...f, q: qInput }))
    }, 250)
    return () => window.clearTimeout(t)
  }, [qInput])

  const loadStats = useCallback(() => {
    fetchStats()
      .then(setStats)
      .catch(() => undefined)
  }, [])

  const loadPositions = useCallback(() => {
    fetchPositions().then(setPositions).catch(() => undefined)
  }, [])

  /**
   * 名单人数只用来决定「不再采集名单」这个入口显不显示。
   * 拉失败（比如后端还没把接口加上）就当作 0 —— 静默隐藏入口，不在页头上挂个报错。
   */
  const loadIgnored = useCallback(() => {
    fetchIgnored()
      .then((d) => setIgnoredCount(d.total))
      .catch(() => setIgnoredCount(0))
  }, [])

  /**
   * 改筛选条件 —— **必须顺手把页码打回第 1 页**。
   *
   * 否则会出现：在第 3 页把「城市 = 深圳」改成「城市 = 青岛」，而青岛只有 8 个人
   * （不到第 3 页），列表直接空白，看起来像"筛不出来"。
   * 所有改 filter 的地方都要走这个函数，不要直接 setFilter。
   */
  const applyFilter = useCallback((next: FilterValue) => {
    setFilter(next)
    setPage(0)
  }, [])

  const loadFacets = useCallback(() => {
    fetchCandidateFacets()
      .then(setFacets)
      .catch(() => setFacets(null))
  }, [])

  useEffect(() => {
    loadStats()
    loadPositions()
    loadIgnored()
    loadFacets()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadStats, loadPositions, loadIgnored, loadFacets, refreshToken])

  // ---- 候选人列表（带分页）----
  const listQuery = useMemo<FilterValue>(
    () => ({ ...filter, limit: pageSize, offset: page * pageSize }),
    [filter, page, pageSize]
  )

  /**
   * 筛选条件一变就回第 1 页。
   *
   * 用 effect 统一兜住，而不是在每个改 filter 的地方手动 `setPage(0)` ——
   * 那种写法只要漏掉一处（关键词防抖、统计卡快捷入口、重置数据…），
   * 就会出现「改了条件却停在空页」这种看着像 bug 的现象。
   *
   * 为什么不会多打请求：page 本来就是 0 时 `setPage(0)` 会被 React 直接跳过（同值 bail out）。
   */
  useEffect(() => {
    setPage(0)
  }, [filter])

  /**
   * 页码越界时收回最后一页。
   *
   * 场景：人在第 3 页，把最后几条删掉之后总页数只剩 2 页 —— 不收回的话会停在空页，
   * 而用户完全不知道为什么列表突然空了。
   */
  useEffect(() => {
    const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1)
    if (page > maxPage) setPage(maxPage)
  }, [total, pageSize, page])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchCandidates(listQuery)
      .then((d) => {
        if (cancelled) return
        setRows(d.items)
        setTotal(d.total)
        setError(null)
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // ⚠️ 依赖必须是 listQuery（含 limit/offset），**不能只写 filter**。
    //    写成 [filter] 的后果实测过：点「下一页」时页码变了、页眉也跟着变成
    //    「第 21–31 条」（那是从 state 算的，会立刻更新），但列表**根本没重新拉**，
    //    于是显示的还是第 1 页那 20 个人 —— 页眉与内容对不上，看起来像"翻页坏了"。
    //    这类 bug 只有真的点一下按钮才会暴露，接口层测试和冒烟测试都抓不到。
  }, [listQuery, refreshToken])

  // ---- 详情 ----
  const loadDetail = useCallback((id: string) => {
    setDetailLoading(true)
    setDetailError(null)
    fetchCandidateDetail(id)
      .then(setDetail)
      .catch((e: Error) => setDetailError(e.message))
      .finally(() => setDetailLoading(false))
  }, [])

  useEffect(() => {
    if (!selectedId) {
      setDetail(null)
      return
    }
    loadDetail(selectedId)
  }, [selectedId, loadDetail, refreshToken])

  const handleStatusChange = useCallback(
    async (positionId: string, status: ApplicationStatus) => {
      if (!selectedId) return
      try {
        await updateMatchStatus(selectedId, positionId, status)
        loadDetail(selectedId)
        loadStats()
        onDataChanged?.()
        const d = await fetchCandidates(filter)
        setRows(d.items)
        setTotal(d.total)
      } catch (e) {
        setDetailError((e as Error).message)
      }
    },
    [selectedId, loadDetail, loadStats, filter, onDataChanged]
  )

  const handleResetData = useCallback(async () => {
    const ok = window.confirm(
      '将清空当前所有候选人数据，并重新灌入示例简历。\n（你手动采集进来的简历也会被清掉）\n\n确定继续？'
    )
    if (!ok) return
    setResetting(true)
    try {
      await resetDemoData()
      setSelectedId(null)
      applyFilter(EMPTY_FILTER)
      setPicked(new Set())
      setQInput('')
      loadStats()
      loadFacets()
      onDataChanged?.()
      const d = await fetchCandidates({ ...EMPTY_FILTER, limit: pageSize, offset: 0 })
      setRows(d.items)
      setTotal(d.total)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setResetting(false)
    }
  }, [applyFilter, loadStats, loadFacets, onDataChanged, pageSize])

  // ---- 导出 Excel ----
  // 0 条命中时服务端会返回一张 400 的中文错误页，而下载又走的是浏览器自己那一套，
  // 前端拦不住这个响应 —— 所以在发请求之前就用 total 挡住。
  //
  // 有勾选就**只导勾选的**：用户明确勾了 8 个人，期望就是这 8 个。
  // 按钮文案会跟着变（见 JSX），不能让「勾了却导出全部」这种事静默发生。
  const exportIds = picked.size > 0 ? [...picked] : undefined

  const handleExportExcel = useCallback(() => {
    if (picked.size === 0 && total === 0) {
      setExportErr('当前筛选没有候选人，无法导出')
      return
    }
    setExportErr(null)
    saveExportPreset(preset)
    // 用 URLSearchParams 拼 URL，不手工 encodeURI；<a download> 让浏览器自己去下附件
    const a = document.createElement('a')
    a.href = candidateExportUrl(filter, preset, exportIds)
    a.download = ''
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }, [filter, preset, total, picked.size, exportIds])

  /**
   * 导出勾选的 PDF。
   *
   * 两道挡：
   *   · 超过服务端上限（200）→ 直接挡住让用户分批，**不要静默截断**
   *   · 超过 50 → 先确认。打印是同步阻塞的，上百份简历会让浏览器卡几十秒，
   *     用户得知道自己在等什么。
   */
  const handleExportPdf = useCallback(() => {
    const n = picked.size
    if (n === 0) return
    if (n > PRINT_BATCH_MAX) {
      setExportErr(`一次最多导出 ${PRINT_BATCH_MAX} 份简历（本次 ${n} 份），请分批导出。`)
      return
    }
    if (n > PRINT_CONFIRM_AT) {
      // 每人约 2–4 页，给个量级估算，别让用户以为"点了没反应"
      const ok = window.confirm(
        `将生成 ${n} 份简历的 PDF（约 ${n * 2}–${n * 4} 页），浏览器可能卡顿几十秒。\n\n继续？`
      )
      if (!ok) return
    }
    setExportErr(null)
    window.open(printBatchUrl([...picked], loadPrintOptions()), '_blank')
  }, [picked])

  // ---- 勾选 ----
  const pageIds = useMemo(() => rows.map((r) => r.candidate.id), [rows])
  const allPagePicked = pageIds.length > 0 && pageIds.every((id) => picked.has(id))
  const somePagePicked = !allPagePicked && pageIds.some((id) => picked.has(id))

  /** 勾选/取消勾选**本页** */
  const togglePage = useCallback(() => {
    setPicked((prev) => {
      const next = new Set(prev)
      if (allPagePicked) pageIds.forEach((id) => next.delete(id))
      else pageIds.forEach((id) => next.add(id))
      return next
    })
  }, [allPagePicked, pageIds])

  /**
   * 勾选**全部命中**（跨页）。
   *
   * 必须走后端要 id 列表，而不是「把当前页全选 + 循环翻页」——
   * 列表接口 limit 上限 500，命中上千人时循环翻页既慢又拿不全。
   */
  const pickAllMatching = useCallback(async () => {
    setPickingAll(true)
    setExportErr(null)
    try {
      const d = await fetchCandidateIds(filter)
      setPicked(new Set(d.ids))
      if (d.truncated) {
        setExportErr(`命中 ${d.total} 人，一次最多勾选 ${d.ids.length} 人（已勾选前 ${d.ids.length} 人）。`)
      }
    } catch (e) {
      setExportErr(`勾选失败：${(e as Error).message}`)
    } finally {
      setPickingAll(false)
    }
  }, [filter])

  // ---- 批量删除 ----
  const handleBulkDelete = useCallback(async () => {
    if (picked.size === 0) return
    // 服务端一次最多 500 人（见 /api/candidates/delete），先在本地挡一下，别等后端报错
    if (picked.size > BULK_DELETE_MAX) {
      setBulkErr(`一次最多删除 ${BULK_DELETE_MAX} 人（本次 ${picked.size} 人），请分批删除。`)
      return
    }
    const forget = bulkForget
    setDeleting(true)
    setBulkErr(null)
    try {
      const r = await deleteCandidates([...picked], forget)
      // 清空勾选 + 重新拉列表与统计，别让已经删掉的人还挂在列表上
      setPicked(new Set())
      setConfirmDelete(false)
      setBulkForget(false)
      loadStats()
      loadIgnored()
      onDataChanged?.()
      const d = await fetchCandidates(filter)
      setRows(d.items)
      setTotal(d.total)
      setDone(
        `已删除 ${r.deleted} 份简历` +
          (r.forgot > 0 ? `，其中 ${r.forgot} 人已设为不再采集` : '') +
          '。'
      )
    } catch (e) {
      setBulkErr((e as Error).message)
    } finally {
      setDeleting(false)
    }
  }, [picked, bulkForget, filter, loadStats, loadIgnored, onDataChanged])

  // 操作结果提示 4 秒后自动收起，不长期占着页头
  useEffect(() => {
    if (!done) return
    const t = window.setTimeout(() => setDone(null), 4000)
    return () => window.clearTimeout(t)
  }, [done])

  // ---- 删除后刷新（抽屉里的单个删除也走这里）----
  // 不复用 handleStatusChange：那边的语义是「改了匹配进度」，这里整条候选人可能已经没了。
  // 列表不做显式重拉 —— onDataChanged() 会让外壳把 refreshToken +1，
  // 上面那个带 cancelled 保护的列表 effect 会自己再拉一次，这里再拉一遍就是重复请求。
  const handleDeleted = useCallback(() => {
    const goneId = selectedId
    setSelectedId(null)
    setDetail(null)
    if (goneId) {
      // 顺手把他的勾选也清掉，别留一个删不掉的人在「已勾选 N 人」里
      setPicked((prev) => {
        if (!prev.has(goneId)) return prev
        const next = new Set(prev)
        next.delete(goneId)
        return next
      })
    }
    loadStats()
    loadIgnored()
    onDataChanged?.()
  }, [selectedId, loadStats, loadIgnored, onDataChanged])

  const activeNote = useMemo(() => {
    const parts: string[] = []
    if (filter.q) parts.push(`关键词「${filter.q}」`)
    if (filter.positionId) {
      const p = positions.find((x) => x.id === filter.positionId)
      if (p) parts.push(`岗位「${p.title}」`)
    }
    if (filter.unmatched) parts.push('只看待匹配')
    if (filter.sort === 'recent') parts.push('按最新采集排序')
    return parts.join(' · ')
  }, [filter, positions])

  /**
   * 顶部统计卡片的快捷入口。
   * 「今日采集」→ 切到最新采集排序；「只看待匹配」→ 过滤出还没归岗位的简历。
   * 这是为了回答一个很常见的困惑：我明明采到了，为什么看板里看不到 ——
   * 因为默认按匹配度排序，没有匹配记录的会被压到最后。
   */
  const handleShortcut = useCallback((key: StatsShortcut) => {
    setQInput('')
    setFilter((f) => {
      if (key === 'today') return { ...EMPTY_FILTER, sort: 'recent' }
      return { ...EMPTY_FILTER, unmatched: true, sort: 'recent' }
    })
  }, [])

  return (
    <>
      <StatsBar stats={stats} onShortcut={handleShortcut} />

      <div className="main">
        <FilterPanel
          positions={positions}
          facets={facets}
          value={{ ...filter, q: qInput }}
          total={total}
          onChange={(next) => {
            setQInput(next.q)
            applyFilter(next)
          }}
          onResetData={handleResetData}
          resetting={resetting}
        />

        <section className="list">
          <div className="cand-tools">
            {/* 「不再采集名单」放在工具栏之外的次要位置：它是个低频维护入口，
                0 人时整条隐藏，不占页头的注意力。 */}
            {ignoredCount > 0 && (
              <button
                type="button"
                className="link-btn"
                onClick={() => setShowIgnored((v) => !v)}
                title="这些人被设为不再采集，扩展不会再把他们存进来"
              >
                不再采集名单（{ignoredCount}）
              </button>
            )}
          </div>

          <div className="list-hd">
            <span>
              候选人库
              {activeNote && <em className="muted"> · {activeNote}</em>}
              <em className="muted">
                {' · '}
                {loading
                  ? '加载中…'
                  : total === 0
                    ? '命中 0 人'
                    : `第 ${page * pageSize + 1}–${Math.min((page + 1) * pageSize, total)} 条，共 ${total} 人`}
              </em>
            </span>
            <span className="list-tools">
              {/* 勾选相关：先给「本页全选 / 全部命中」，再给导出。顺序与操作习惯一致 */}
              {rows.length > 0 && (
                <>
                  <label className="pick-page" title="勾选 / 取消勾选本页全部">
                    <input
                      type="checkbox"
                      checked={allPagePicked}
                      ref={(el) => {
                        // 三态：部分勾选时显示横杠（HTML 没有 indeterminate 属性，只能用 JS 设）
                        if (el) el.indeterminate = somePagePicked
                      }}
                      onChange={togglePage}
                    />
                    <span>本页</span>
                  </label>
                  {total > rows.length && (
                    <button
                      type="button"
                      className="btn-ghost btn-inline"
                      disabled={pickingAll}
                      onClick={() => void pickAllMatching()}
                      title={`勾选符合当前筛选的全部 ${total} 人（跨页）`}
                    >
                      {pickingAll ? '勾选中…' : `勾选全部命中（${total}）`}
                    </button>
                  )}
                </>
              )}

              <button
                type="button"
                className="btn-ghost btn-inline"
                disabled={picked.size === 0 && total === 0}
                onClick={handleExportExcel}
                title={
                  picked.size > 0
                    ? `只导出勾选的 ${picked.size} 人`
                    : `导出当前筛选的全部 ${total} 位候选人（忽略分页）`
                }
              >
                {picked.size > 0 ? `导出勾选的 ${picked.size} 人` : `导出全部 ${total} 人`}
              </button>
              <select
                className="preset-sel"
                value={preset}
                onChange={(e) => {
                  const next = e.target.value as ExportPreset
                  setPreset(next)
                  saveExportPreset(next)
                }}
                title="精简 14 列（够看）+ 联系方式；完整 25 列（全部结构化字段）"
              >
                <option value="brief">精简 14 列</option>
                <option value="full">完整 25 列</option>
              </select>

              {picked.size > 0 && (
                <>
                  <span className="muted">已勾选 {picked.size} 人</span>
                  <button
                    type="button"
                    className="btn-primary btn-inline"
                    disabled={picked.size > PRINT_BATCH_MAX}
                    onClick={handleExportPdf}
                    title={
                      picked.size > PRINT_BATCH_MAX
                        ? `一次最多导出 ${PRINT_BATCH_MAX} 份，请分批导出`
                        : `把勾选的 ${picked.size} 位候选人合成一个多页 PDF（在打印对话框里选「另存为 PDF」）`
                    }
                  >
                    导出选中 PDF
                  </button>
                  <button
                    type="button"
                    className="btn-inline btn-danger"
                    disabled={picked.size > BULK_DELETE_MAX}
                    title={
                      picked.size > BULK_DELETE_MAX
                        ? `一次最多删除 ${BULK_DELETE_MAX} 人，请分批删除`
                        : '删除勾选的简历'
                    }
                    onClick={() => {
                      setBulkErr(null)
                      setConfirmDelete((v) => !v)
                    }}
                  >
                    删除选中
                  </button>
                  <button type="button" className="btn-ghost btn-inline" onClick={() => setPicked(new Set())}>
                    取消勾选
                  </button>
                </>
              )}
            </span>
          </div>

          {showIgnored && <IgnoreListPanel onClose={() => setShowIgnored(false)} />}

          {exportErr && <div className="notice notice-bad">{exportErr}</div>}
          {/* 批量删除确认条：写明人数 + 明确「不可从界面撤销」，
              「同时设为不再采集」默认不勾（批量误勾代价大）。 */}
          {confirmDelete && picked.size > 0 && (
            <div className="export-bar del-bar">
              {bulkErr && <div className="notice notice-bad">删除失败：{bulkErr}</div>}
              <div className="export-title">
                删除选中的 {picked.size} 份简历？删除后不能从界面撤销（不再采集名单里的可以恢复采集）。
              </div>
              <div className="export-opts">
                <label>
                  <input
                    type="checkbox"
                    checked={bulkForget}
                    onChange={(e) => setBulkForget(e.target.checked)}
                  />
                  同时设为不再采集这些人
                </label>
              </div>
              <div className="export-acts">
                <span className="muted">
                  勾上之后，即使以后又打开他们的简历，扩展也不会再存进来。
                </span>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={deleting}
                  onClick={() => void handleBulkDelete()}
                >
                  {deleting ? '删除中…' : '确认删除'}
                </button>
                <button
                  type="button"
                  className="btn-ghost btn-inline"
                  disabled={deleting}
                  onClick={() => {
                    setConfirmDelete(false)
                    setBulkErr(null)
                  }}
                >
                  取消
                </button>
              </div>
            </div>
          )}

          {exportErr && <div className="notice notice-bad">{exportErr}</div>}
          {done && <div className="notice notice-ok">{done}</div>}

          {error && <div className="notice notice-bad">加载失败：{error}</div>}

          {!error && !loading && rows.length === 0 && (
            <div className="empty">
              <div>没有符合条件的候选人</div>
              <div className="muted">试着放宽筛选条件，或点左侧「清空筛选」。</div>
            </div>
          )}

          <div className="cards">
            {rows.map((r) => (
              <CandidateCard
                key={r.candidate.id}
                row={r}
                active={r.candidate.id === selectedId}
                picked={picked.has(r.candidate.id)}
                onPick={(on) => {
                  setPicked((prev) => {
                    const next = new Set(prev)
                    if (on) next.add(r.candidate.id)
                    else next.delete(r.candidate.id)
                    return next
                  })
                }}
                onClick={() => setSelectedId(r.candidate.id)}
              />
            ))}
          </div>

          {/*
            分页条。
            只有一页时**不显示** —— 但只要命中数超过一页就一定要出现：
            在此之前列表只拉前 50 条且没有任何翻页入口，页头又写着「命中 120 人」，
            用户会以为剩下 70 个人丢了。
          */}
          {!loading && total > 0 && (
            <div className="pager">
              <span className="pager-info">
                第 {page * pageSize + 1}–{Math.min((page + 1) * pageSize, total)} 条 / 共 {total} 人
                {picked.size > 0 && <em className="muted"> · 已勾选 {picked.size} 人</em>}
              </span>
              <span className="pager-acts">
                <select
                  className="preset-sel"
                  value={pageSize}
                  onChange={(e) => setPageSize(Number(e.target.value))}
                  title="每页显示多少条"
                >
                  {PAGE_SIZES.map((n) => (
                    <option key={n} value={n}>
                      每页 {n} 条
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn-ghost btn-inline"
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  上一页
                </button>
                <span className="pager-page">
                  第 {page + 1} / {Math.max(1, Math.ceil(total / pageSize))} 页
                </span>
                <button
                  type="button"
                  className="btn-ghost btn-inline"
                  disabled={page + 1 >= Math.ceil(total / pageSize)}
                  onClick={() => setPage((p) => p + 1)}
                >
                  下一页
                </button>
              </span>
            </div>
          )}
        </section>
      </div>

      {selectedId && (
        <CandidateDrawer
          detail={detail}
          loading={detailLoading}
          error={detailError}
          onClose={() => setSelectedId(null)}
          onStatusChange={handleStatusChange}
          onDeleted={handleDeleted}
        />
      )}
    </>
  )
}
