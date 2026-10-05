import { useCallback, useEffect, useRef, useState } from 'react'
import type { PipelineRow, Position, PositionInput } from '@ria/shared'
import {
  createPosition,
  deletePosition,
  fetchPipeline,
  fetchPositions,
  loadPrintOptions,
  printPositionUrl,
  rematchCandidates,
  updatePosition,
  type PositionWithCount,
} from '../api'
import { ArrowIcon } from '../components/icons'

type PositionStatus = Position['status']

const STATUS_TEXT: Record<PositionStatus, string> = {
  open: '在招',
  paused: '已暂停',
  closed: '已关闭',
}

/**
 * 状态标签配色。
 * 在招用绿色（`.tag` 默认是灰的，这里显式给绿），其余复用已有的警示 / 中性底色。
 */
const STATUS_TAG_CLASS: Record<PositionStatus, string> = {
  open: 'tag',
  paused: 'tag tag-warn',
  closed: 'tag',
}
const STATUS_TAG_STYLE: Record<PositionStatus, { background?: string; color?: string }> = {
  open: { background: 'var(--green-soft)', color: 'var(--green)' },
  paused: {},
  closed: {},
}

const EMPTY_DRAFT: Draft = {
  title: '',
  department: '',
  city: '',
  headcount: '',
  status: 'open',
  jdText: '',
  hardRequirements: '',
  niceToHave: '',
}

interface Draft {
  title: string
  department: string
  city: string
  headcount: string
  status: PositionStatus
  jdText: string
  /** 表单里一行一条，提交时才拆成数组 */
  hardRequirements: string
  niceToHave: string
}

/** 一行一条 → 数组；顺手丢掉空行 */
function toLines(text: string): string[] {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

function pipeOf(rows: PipelineRow[] | null, positionId: string): PipelineRow | undefined {
  return rows?.find((r) => r.positionId === positionId)
}

/** 单个岗位卡片：标题 + 状态 + 关键数字 + 三个操作 */
function PositionCard({
  position,
  pipe,
  busy,
  onEdit,
  onToggleStatus,
  onRemove,
  onOpenPosition,
}: {
  position: PositionWithCount
  /** 漏斗里对应的一行，取不到（接口失败）就不显示均分 / 强推 */
  pipe: PipelineRow | undefined
  /** 该岗位正在被改（停用 / 启用 / 删除请求还没回来） */
  busy: boolean
  onEdit: () => void
  onToggleStatus: () => void
  onRemove: () => void
  onOpenPosition?: (positionId: string) => void
}) {
  const facts = [
    position.department || undefined,
    position.city || undefined,
    position.headcount !== undefined ? `编制 ${position.headcount} 人` : undefined,
    `候选人 ${position.candidateCount} 人`,
  ].filter(Boolean) as string[]

  return (
    <article className="panel">
      <div className="pipe-head">
        <div className="pipe-head-left">
          <div className="pipe-title">
            {position.title}
            <span className={STATUS_TAG_CLASS[position.status]} style={STATUS_TAG_STYLE[position.status]}>
              {STATUS_TEXT[position.status]}
            </span>
          </div>
          <div className="pipe-meta">{facts.join(' · ')}</div>
        </div>

        {pipe && (
          <div className="pipe-kpi">
            <div className="kpi">
              <b>{pipe.avgScore}</b>
              <span>平均匹配</span>
            </div>
            <div className="kpi kpi-strong">
              <b>{pipe.strongCount}</b>
              <span>强推</span>
            </div>
          </div>
        )}
      </div>

      <div className="pipe-foot" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {onOpenPosition && (
          <button type="button" className="link-btn" onClick={() => onOpenPosition(position.id)}>
            查看该岗位候选人 <ArrowIcon />
          </button>
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {busy && <span className="muted">处理中…</span>}
          {/* 分岗位给业务部门的正解：一个按钮把该岗位下的全部候选人导成一个多页 PDF */}
          {position.candidateCount > 0 && (
            <button
              type="button"
              className="btn-ghost btn-inline"
              onClick={() => window.open(printPositionUrl(position.id, loadPrintOptions()), '_blank')}
              title={`把该岗位下的 ${position.candidateCount} 位候选人合成一个 PDF（在打印对话框里选「另存为 PDF」）`}
            >
              导出候选人 PDF
            </button>
          )}
          <button type="button" className="btn-ghost btn-inline" onClick={onEdit} disabled={busy}>
            编辑
          </button>
          <button
            type="button"
            className="btn-ghost btn-inline"
            onClick={onToggleStatus}
            disabled={busy}
            title={
              position.status === 'open'
                ? '停用后不再参与自动匹配，历史匹配与看板展示都保留'
                : '重新开启后参与自动匹配'
            }
          >
            {position.status === 'open' ? '停用' : '启用'}
          </button>
          <button type="button" className="btn-ghost btn-inline" onClick={onRemove} disabled={busy}>
            删除
          </button>
        </span>
      </div>
    </article>
  )
}

/**
 * 岗位管理（#/positions）
 * 加岗位、改 JD、停用 / 删除，并顺带看每个岗位招得怎么样（人数 / 均分 / 强推取自 /api/pipeline）。
 */
export function PositionsPage({
  refreshToken,
  onOpenPosition,
  onDataChanged,
}: {
  /** 数据版本令牌：外部（扩展采集）写入新数据时由外壳 +1，触发本页重拉 */
  refreshToken?: number
  /** 由外壳传入：跳到候选人库并预设该岗位筛选。没传就不显示这个入口 */
  onOpenPosition?: (positionId: string) => void
  onDataChanged: () => void
}) {
  const [positions, setPositions] = useState<PositionWithCount[] | null>(null)
  const [pipeline, setPipeline] = useState<PipelineRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  /** 页内表单（不用弹窗，保持和其它页面一致） */
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const [rematching, setRematching] = useState(false)
  const [flash, setFlash] = useState<{ kind: 'info' | 'bad'; text: string } | null>(null)
  const flashTimer = useRef<number | null>(null)

  /** 页内提示：几秒后自己收掉（成功和失败都走这里，文案由调用方给） */
  const showFlash = useCallback((kind: 'info' | 'bad', text: string) => {
    setFlash({ kind, text })
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setFlash(null), 6000)
  }, [])

  useEffect(() => {
    return () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current)
    }
  }, [])

  /**
   * 写操作成功后重拉：岗位列表是主数据，拉不到就报错；
   * 漏斗只用来补均分 / 强推，拉不到就安静降级（不显示这两个数字）。
   * 首次进页面不走这里，而是下面那个带 cancelled 标志的 effect。
   */
  const load = useCallback(async (): Promise<void> => {
    const [posRes, pipeRes] = await Promise.allSettled([fetchPositions(), fetchPipeline()])
    if (posRes.status === 'fulfilled') {
      setPositions(posRes.value)
      setError(null)
    } else {
      setError((posRes.reason as Error).message)
    }
    setPipeline(pipeRes.status === 'fulfilled' ? pipeRes.value.positions : null)
  }, [])

  useEffect(() => {
    let cancelled = false
    setError(null)
    fetchPositions()
      .then((rows) => {
        if (cancelled) return
        setPositions(rows)
        setError(null)
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })
    // 漏斗只用来补「均分 / 强推」，拉不到就安静降级，不影响岗位列表
    fetchPipeline()
      .then((d) => {
        if (!cancelled) setPipeline(d.positions)
      })
      .catch(() => {
        if (!cancelled) setPipeline(null)
      })
    return () => {
      cancelled = true
    }
  }, [refreshToken])

  const openCreate = useCallback(() => {
    setEditingId(null)
    setDraft(EMPTY_DRAFT)
    setShowForm(true)
    setFlash(null)
  }, [])

  const openEdit = useCallback((p: PositionWithCount) => {
    setEditingId(p.id)
    setDraft({
      title: p.title,
      department: p.department ?? '',
      city: p.city ?? '',
      headcount: p.headcount !== undefined ? String(p.headcount) : '',
      status: p.status,
      jdText: p.jdText,
      hardRequirements: (p.hardRequirements ?? []).join('\n'),
      niceToHave: (p.niceToHave ?? []).join('\n'),
    })
    setShowForm(true)
    setFlash(null)
  }, [])

  const cancelForm = useCallback(() => {
    setShowForm(false)
    setEditingId(null)
    setDraft(EMPTY_DRAFT)
  }, [])

  const handleSubmit = useCallback(async () => {
    // 两个必填项先在前端拦一道，不发无意义的请求
    if (!draft.title.trim()) {
      setFlash({ kind: 'bad', text: '请先填岗位标题' })
      return
    }
    if (!draft.jdText.trim()) {
      setFlash({ kind: 'bad', text: '请先填 JD 正文' })
      return
    }

    const headcount = draft.headcount.trim() === '' ? undefined : Number(draft.headcount)
    const input: PositionInput = {
      title: draft.title.trim(),
      department: draft.department.trim() || undefined,
      city: draft.city.trim() || undefined,
      headcount: headcount !== undefined && Number.isFinite(headcount) ? headcount : undefined,
      status: draft.status,
      jdText: draft.jdText.trim(),
      hardRequirements: toLines(draft.hardRequirements),
      niceToHave: toLines(draft.niceToHave),
    }

    setSaving(true)
    try {
      if (editingId) await updatePosition(editingId, input)
      else await createPosition(input)
      cancelForm()
      await load()
      showFlash('info', editingId ? '岗位已更新' : '岗位已新建')
      onDataChanged()
    } catch (e) {
      // 后端 400 / 404 的文案直接给用户看
      showFlash('bad', (e as Error).message)
    } finally {
      setSaving(false)
    }
  }, [draft, editingId, cancelForm, load, onDataChanged, showFlash])

  /** 停用 / 启用：岗位下已有候选人时，这才是正确的「下架」方式 */
  const handleToggleStatus = useCallback(
    async (p: Position) => {
      const next: PositionStatus = p.status === 'open' ? 'paused' : 'open'
      setBusyId(p.id)
      try {
        await updatePosition(p.id, { status: next })
        await load()
        setFlash({ kind: 'info', text: next === 'paused' ? `已停用「${p.title}」` : `已启用「${p.title}」` })
        onDataChanged()
      } catch (e) {
        showFlash('bad', (e as Error).message)
      } finally {
        setBusyId(null)
      }
    },
    [load, onDataChanged, showFlash]
  )

  const handleDelete = useCallback(
    async (p: PositionWithCount) => {
      const okToDelete = window.confirm(
        `确定删除岗位「${p.title}」？\n\n删除后不可恢复。若岗位下还有候选人，系统会拒绝删除并提示你改为「停用」。`
      )
      if (!okToDelete) return

      setBusyId(p.id)
      try {
        const res = await deletePosition(p.id)
        if (!res.deleted) {
          // 后端 409 的解释文案（为什么该停用而不是删除）原样转达，不自己编
          showFlash('bad', res.reason ?? '删除失败：该岗位还不能删除')
          return
        }
        await load()
        setFlash({ kind: 'info', text: `已删除岗位「${p.title}」` })
        onDataChanged()
      } catch (e) {
        showFlash('bad', (e as Error).message)
      } finally {
        setBusyId(null)
      }
    },
    [load, onDataChanged, showFlash]
  )

  const handleRematch = useCallback(async () => {
    setRematching(true)
    try {
      const res = await rematchCandidates()
      await load()
      showFlash('info', `已给 ${res.matched} 位候选人补上岗位`)
      onDataChanged()
    } catch (e) {
      showFlash('bad', (e as Error).message)
    } finally {
      setRematching(false)
    }
  }, [load, onDataChanged, showFlash])

  const openCount = positions?.filter((p) => p.status === 'open').length ?? 0
  const linkedCount = positions?.reduce((n, p) => n + p.candidateCount, 0) ?? 0

  return (
    <>
      <div className="page-head">
        <div>
          <h2>岗位管理</h2>
          <p className="muted">
            加岗位、改 JD、看每个岗位招得怎么样。岗位下还有候选人时不要删除，改成「停用」——
            停用后不再参与自动匹配，历史匹配与看板展示都保留。
          </p>
        </div>
        <div className="page-head-kpi">
          <span>
            在招岗位 <b>{openCount}</b>
          </span>
          <span>
            已挂候选人 <b>{linkedCount}</b>
          </span>
          <span style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="btn-primary btn-inline"
              style={{ padding: '6px 12px', fontSize: 13 }}
              onClick={openCreate}
            >
              + 新建岗位
            </button>
            <button
              type="button"
              className="btn-ghost btn-inline"
              style={{ padding: '6px 12px', fontSize: 13 }}
              onClick={handleRematch}
              disabled={rematching}
            >
              {rematching ? '重跑中…' : '重跑匹配'}
            </button>
          </span>
        </div>
      </div>

      {flash && (
        <div
          className={flash.kind === 'bad' ? 'notice notice-bad' : 'notice notice-info'}
          role="status"
        >
          {flash.text}
        </div>
      )}

      {showForm && (
        <section className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-title">{editingId ? '编辑岗位' : '新建岗位'}</div>

          <label className="field">
            <span>岗位标题 *</span>
            <input
              type="text"
              placeholder="例如：高级前端工程师"
              value={draft.title}
              onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            />
          </label>

          <div className="field-row">
            <label className="field">
              <span>部门</span>
              <input
                type="text"
                placeholder="例如：技术中心"
                value={draft.department}
                onChange={(e) => setDraft((d) => ({ ...d, department: e.target.value }))}
              />
            </label>
            <label className="field">
              <span>城市</span>
              <input
                type="text"
                placeholder="例如：深圳"
                value={draft.city}
                onChange={(e) => setDraft((d) => ({ ...d, city: e.target.value }))}
              />
            </label>
            <label className="field">
              <span>招聘人数</span>
              <input
                type="number"
                min={0}
                placeholder="例如：2"
                value={draft.headcount}
                onChange={(e) => setDraft((d) => ({ ...d, headcount: e.target.value }))}
              />
            </label>
          </div>

          <label className="field">
            <span>状态</span>
            <select
              value={draft.status}
              onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value as PositionStatus }))}
            >
              <option value="open">在招</option>
              <option value="paused">暂停</option>
              <option value="closed">关闭</option>
            </select>
          </label>

          <label className="field">
            <span>JD 正文 *</span>
            <textarea
              rows={6}
              placeholder="岗位职责、任职要求等，越完整匹配越准"
              value={draft.jdText}
              onChange={(e) => setDraft((d) => ({ ...d, jdText: e.target.value }))}
            />
          </label>

          <div className="field-row">
            <label className="field">
              <span>硬性条件（一行一条）</span>
              <textarea
                rows={5}
                placeholder={'例如：\n本科及以上\n5 年以上前端经验'}
                value={draft.hardRequirements}
                onChange={(e) => setDraft((d) => ({ ...d, hardRequirements: e.target.value }))}
              />
            </label>
            <label className="field">
              <span>加分项（一行一条）</span>
              <textarea
                rows={5}
                placeholder={'例如：\n有大厂经验\n熟悉 Node.js'}
                value={draft.niceToHave}
                onChange={(e) => setDraft((d) => ({ ...d, niceToHave: e.target.value }))}
              />
            </label>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button
              type="button"
              className="btn-primary btn-inline"
              style={{ padding: '6px 12px', fontSize: 13 }}
              onClick={() => void handleSubmit()}
              disabled={saving}
            >
              {saving ? '保存中…' : '保存'}
            </button>
            <button
              type="button"
              className="btn-ghost btn-inline"
              style={{ padding: '6px 12px', fontSize: 13 }}
              onClick={cancelForm}
              disabled={saving}
            >
              取消
            </button>
          </div>
        </section>
      )}

      {error && <div className="notice notice-bad">加载失败：{error}</div>}

      {!error && !positions && <div className="empty">加载中…</div>}

      {!error && positions && positions.length === 0 && (
        <div className="empty">
          <div>还没有岗位</div>
          <div className="muted">点右上角「+ 新建岗位」，把 JD 粘进来就能开始匹配。</div>
        </div>
      )}

      {!error && positions && positions.length > 0 && (
        <div className="cards" style={{ gap: 12 }}>
          {positions.map((p) => (
            <PositionCard
              key={p.id}
              position={p}
              pipe={pipeOf(pipeline, p.id)}
              busy={busyId === p.id}
              onEdit={() => openEdit(p)}
              onToggleStatus={() => void handleToggleStatus(p)}
              onRemove={() => void handleDelete(p)}
              onOpenPosition={onOpenPosition}
            />
          ))}
        </div>
      )}
    </>
  )
}
