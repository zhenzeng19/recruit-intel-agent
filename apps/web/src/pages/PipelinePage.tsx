import { useEffect, useState } from 'react'
import type { PipelineData, PipelineRow } from '@ria/shared'
import { STATUS_COLOR, STATUS_LABEL, STATUS_ORDER } from '@ria/shared'
import { fetchPipeline, loadPrintOptions, printPositionUrl } from '../api'
import { ArrowIcon } from '../components/icons'

const POSITION_STATUS_TEXT: Record<string, string> = {
  open: '在招',
  paused: '暂停',
  closed: '已关闭',
}

export function PipelineCard({
  row,
  onOpenPosition,
}: {
  row: PipelineRow
  onOpenPosition: (positionId: string) => void
}) {
  const visible = row.stages.filter((s) => s.count > 0)

  return (
    <article className="pipe-card">
      <div className="pipe-head">
        <div className="pipe-head-left">
          <div className="pipe-title">
            {row.title}
            {row.positionStatus !== 'open' && (
              <span className="tag tag-warn">{POSITION_STATUS_TEXT[row.positionStatus]}</span>
            )}
          </div>
          <div className="pipe-meta">
            {[row.city, row.department, row.headcount ? `编制 ${row.headcount} 人` : undefined]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>

        <div className="pipe-kpi">
          <div className="kpi">
            <b>{row.total}</b>
            <span>候选人</span>
          </div>
          <div className="kpi">
            <b>{row.avgScore}</b>
            <span>平均匹配</span>
          </div>
          <div className="kpi kpi-strong">
            <b>{row.strongCount}</b>
            <span>强推</span>
          </div>
        </div>
      </div>

      <div className="funnel">
        {visible.length === 0 && <span className="funnel-empty">还没有候选人</span>}
        {visible.map((s) => (
          <span
            key={s.status}
            className="funnel-seg"
            style={{ flexGrow: s.count, background: STATUS_COLOR[s.status].fg }}
            title={`${STATUS_LABEL[s.status]} ${s.count} 人`}
          />
        ))}
      </div>

      <div className="funnel-legend">
        {STATUS_ORDER.filter((s) => row.stages.find((x) => x.status === s)?.count).map((s) => {
          const n = row.stages.find((x) => x.status === s)?.count ?? 0
          return (
            <span className="legend-item" key={s}>
              <i style={{ background: STATUS_COLOR[s].fg }} />
              {STATUS_LABEL[s]}
              <b>{n}</b>
            </span>
          )
        })}
      </div>

      <div className="pipe-foot" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button type="button" className="link-btn" onClick={() => onOpenPosition(row.positionId)}>
          查看该岗位全部候选人 <ArrowIcon />
        </button>
        {row.total > 0 && (
          <button
            type="button"
            className="btn-ghost btn-inline"
            style={{ marginLeft: 'auto' }}
            onClick={() =>
              window.open(printPositionUrl(row.positionId, loadPrintOptions()), '_blank')
            }
            title={`把该岗位下的 ${row.total} 位候选人合成一个 PDF（在打印对话框里选「另存为 PDF」）`}
          >
            导出候选人 PDF
          </button>
        )}
      </div>
    </article>
  )
}

/** 岗位漏斗（#/pipeline） */
export function PipelinePage({
  onOpenPosition,
  refreshToken,
}: {
  onOpenPosition: (positionId: string) => void
  /** 数据版本令牌：外部（扩展采集）写入新数据时由外壳 +1，触发本页重拉 */
  refreshToken?: number
}) {
  const [data, setData] = useState<PipelineData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchPipeline()
      .then(setData)
      .catch((e: Error) => setError(e.message))
  }, [refreshToken])

  if (error) return <div className="notice notice-bad">加载失败：{error}</div>
  if (!data) return <div className="empty">加载中…</div>

  const totalActive = data.totals
    .filter((t) => ['contacted', 'screening', 'interview', 'offer'].includes(t.status))
    .reduce((n, t) => n + t.count, 0)

  return (
    <>
      <div className="page-head">
        <div>
          <h2>岗位漏斗</h2>
          <p className="muted">
            每个岗位的候选人在各阶段的分布。条越长代表该阶段的人越多，一眼能看出卡在哪一环。
          </p>
        </div>
        <div className="page-head-kpi">
          <span>
            在招岗位 <b>{data.positions.length}</b>
          </span>
          <span>
            候选人 <b>{data.totalCandidates}</b>
          </span>
          <span>
            流程中 <b>{totalActive}</b>
          </span>
        </div>
      </div>

      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-title">全库合计</div>
        <div className="funnel">
          {data.totals
            .filter((t) => t.count > 0)
            .map((t) => (
              <span
                key={t.status}
                className="funnel-seg"
                style={{ flexGrow: t.count, background: STATUS_COLOR[t.status].fg }}
                title={`${STATUS_LABEL[t.status]} ${t.count} 人`}
              />
            ))}
        </div>
        <div className="funnel-legend">
          {STATUS_ORDER.filter((s) => data.totals.find((x) => x.status === s)?.count).map((s) => (
            <span className="legend-item" key={s}>
              <i style={{ background: STATUS_COLOR[s].fg }} />
              {STATUS_LABEL[s]}
              <b>{data.totals.find((x) => x.status === s)?.count ?? 0}</b>
            </span>
          ))}
        </div>
      </section>

      <div className="pipe-grid">
        {data.positions.map((p) => (
          <PipelineCard key={p.positionId} row={p} onOpenPosition={onOpenPosition} />
        ))}
      </div>
    </>
  )
}
