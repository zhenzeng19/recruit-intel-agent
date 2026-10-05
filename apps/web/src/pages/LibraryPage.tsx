import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  ApplicationStatus,
  CandidateDetail,
  CandidateRow,
  Position,
  Stats,
} from '@ria/shared'
import {
  candidateExportUrl,
  deleteCandidates,
  fetchCandidateDetail,
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
  /** 勾选的人（批量导出 PDF / 批量删除） */
  const [picked, setPicked] = useState<Set<string>>(() => new Set())
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

  useEffect(() => {
    loadStats()
    loadPositions()
    loadIgnored()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadStats, loadPositions, loadIgnored, refreshToken])

  // ---- 候选人列表 ----
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchCandidates(filter)
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
  }, [filter, refreshToken])

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
      setFilter(EMPTY_FILTER)
      setQInput('')
      loadStats()
      onDataChanged?.()
      const d = await fetchCandidates(EMPTY_FILTER)
      setRows(d.items)
      setTotal(d.total)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setResetting(false)
    }
  }, [loadStats, onDataChanged])

  // ---- 导出 Excel ----
  // 0 条命中时服务端会返回一张 400 的中文错误页，而下载又走的是浏览器自己那一套，
  // 前端拦不住这个响应 —— 所以在发请求之前就用 total 挡住。
  const handleExportExcel = useCallback(() => {
    if (total === 0) {
      setExportErr('当前筛选没有候选人，无法导出')
      return
    }
    setExportErr(null)
    saveExportPreset(preset)
    // 用 URLSearchParams 拼 URL，不手工 encodeURI；<a download> 让浏览器自己去下附件
    const a = document.createElement('a')
    a.href = candidateExportUrl(filter, preset)
    a.download = ''
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }, [filter, preset, total])

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
          value={{ ...filter, q: qInput }}
          total={total}
          onChange={(next) => {
            setQInput(next.q)
            setFilter(next)
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
              <em className="muted"> · {loading ? '加载中…' : `命中 ${total} 人`}</em>
            </span>
            <span className="list-tools">
              <button
                type="button"
                className="btn-ghost btn-inline"
                disabled={total === 0}
                onClick={handleExportExcel}
                title={`导出当前筛选的全部 ${total} 位候选人（忽略分页）`}
              >
                导出 Excel
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
                    onClick={() =>
                      window.open(printBatchUrl([...picked], loadPrintOptions()), '_blank')
                    }
                    title="把勾选的候选人合成一个多页 PDF（在打印对话框里选「另存为 PDF」）"
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
