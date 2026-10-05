import type { Stats } from '@ria/shared'
import { PLATFORM_LABEL, STATUS_COLOR, STATUS_LABEL, STATUS_ORDER } from '@ria/shared'

/** 顶部卡片可点的快捷筛选入口 */
export type StatsShortcut = 'today' | 'unmatched'

export function StatsBar({
  stats,
  onShortcut,
}: {
  stats: Stats | null
  onShortcut?: (key: StatsShortcut) => void
}) {
  if (!stats) {
    return (
      <section className="stats">
        {[0, 1, 2, 3].map((i) => (
          <div className="stat skeleton" key={i} />
        ))}
      </section>
    )
  }

  const cards: Array<{
    label: string
    value: number
    unit: string
    shortcut?: StatsShortcut
    hint?: string
  }> = [
    { label: '候选人总数', value: stats.candidateCount, unit: '人' },
    { label: '在招岗位', value: stats.positionCount, unit: '个' },
    { label: '平均匹配度', value: stats.avgScore, unit: '分' },
    {
      label: '今日采集',
      value: stats.capturedToday,
      unit: '份',
      shortcut: 'today',
      hint: '点一下按「最新采集」排序',
    },
  ]

  const maxStatus = Math.max(1, ...STATUS_ORDER.map((s) => stats.byStatus[s] ?? 0))
  const maxPlatform = Math.max(1, ...stats.byPlatform.map((p) => p.count))

  return (
    <>
      <section className="stats">
        {cards.map((c) => {
          const clickable = c.shortcut && onShortcut && c.value > 0
          const Tag = clickable ? 'button' : 'div'
          return (
            <Tag
              key={c.label}
              {...(clickable
                ? {
                    type: 'button' as const,
                    className: 'stat stat-clickable',
                    onClick: () => onShortcut(c.shortcut as StatsShortcut),
                    title: c.hint,
                  }
                : { className: 'stat' })}
            >
              <div className="stat-label">{c.label}</div>
              <div className="stat-value">
                {c.value}
                <span className="stat-unit">{c.unit}</span>
              </div>
              {clickable && <div className="stat-hint">点击查看 →</div>}
            </Tag>
          )
        })}
      </section>

      {stats.unmatchedCount > 0 && onShortcut && (
        <div className="notice notice-info">
          <span>
            有 <b>{stats.unmatchedCount}</b> 份简历还没有归到任何岗位（可能是刚采集进来，或在招岗位都不匹配）。
          </span>
          <button type="button" className="btn-ghost" onClick={() => onShortcut('unmatched')}>
            只看待匹配
          </button>
        </div>
      )}

      <section className="panels">
        <div className="panel">
          <div className="panel-title">招聘进度分布</div>
          {STATUS_ORDER.map((s) => {
            const n = stats.byStatus[s] ?? 0
            const c = STATUS_COLOR[s]
            return (
              <div className="bar-row" key={s}>
                <span className="bar-label">{STATUS_LABEL[s]}</span>
                <span className="bar-track">
                  <i style={{ width: `${(n / maxStatus) * 100}%`, background: c.fg }} />
                </span>
                <span className="bar-num">{n}</span>
              </div>
            )
          })}
        </div>

        <div className="panel">
          <div className="panel-title">简历来源分布</div>
          {stats.byPlatform.length === 0 && <div className="empty-mini">暂无数据</div>}
          {stats.byPlatform.map((p) => (
            <div className="bar-row" key={p.platform}>
              <span className="bar-label">{PLATFORM_LABEL[p.platform]}</span>
              <span className="bar-track">
                <i style={{ width: `${(p.count / maxPlatform) * 100}%` }} />
              </span>
              <span className="bar-num">{p.count}</span>
            </div>
          ))}

          {/* 把手动补采单独拎出来：这批是人工兜底救回来的，可信度与自动采集不同 */}
          {stats.capturedByMethod && stats.capturedByMethod.manual > 0 && (
            <div className="panel-hint" style={{ marginTop: 10 }}>
              其中 <b>{stats.capturedByMethod.manual}</b> 份是手动保存的，
              {stats.capturedByMethod.auto} 份由扩展自动采集。
            </div>
          )}

          <div className="panel-title" style={{ marginTop: 16 }}>
            岗位候选人量
          </div>
          {stats.topPositions.map((p) => (
            <div className="bar-row" key={p.positionId}>
              <span className="bar-label" title={p.title}>
                {p.title}
              </span>
              <span className="bar-track">
                <i
                  style={{
                    width: `${(p.count / Math.max(1, ...stats.topPositions.map((x) => x.count))) * 100}%`,
                  }}
                />
              </span>
              <span className="bar-num">
                {p.count}
                <em>均{p.avgScore}</em>
              </span>
            </div>
          ))}
        </div>
      </section>
    </>
  )
}
