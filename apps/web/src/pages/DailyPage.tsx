import { useEffect, useState } from 'react'
import type { BriefCandidate, DailyReport, FollowUp } from '@ria/shared'
import { fetchDaily } from '../api'
import { PlatformTag, ScoreBadge, StatusTag } from '../components/Badges'

const PRIORITY_TEXT = { high: '优先', mid: '常规', low: '可缓' } as const

export function BriefRow({
  item,
  onOpen,
}: {
  item: BriefCandidate
  onOpen: (candidateId: string) => void
}) {
  return (
    <div className="mini-row" onClick={() => onOpen(item.candidateId)}>
      <div className="mini-main">
        <span className="mini-name">{item.name}</span>
        <ScoreBadge score={item.score} showLabel={false} />
        <StatusTag status={item.status} />
        <PlatformTag platform={item.platform} />
      </div>
      <div className="mini-sub">{item.positionTitle}</div>
    </div>
  )
}

export function FollowUpRow({ item, onOpen }: { item: FollowUp; onOpen: (id: string) => void }) {
  return (
    <div className={`mini-row mini-row-${item.priority}`} onClick={() => onOpen(item.candidateId)}>
      <div className="mini-main">
        <span className={`pri pri-${item.priority}`}>{PRIORITY_TEXT[item.priority]}</span>
        <span className="mini-name">{item.name}</span>
        <ScoreBadge score={item.score} showLabel={false} />
        <StatusTag status={item.status} />
        <span className="mini-days">{item.daysSinceUpdate} 天未动</span>
      </div>
      <div className="mini-sub">{item.reason}</div>
    </div>
  )
}

/** 每日简报（#/daily） */
export function DailyPage({
  onOpenCandidate,
  refreshToken,
}: {
  onOpenCandidate: (candidateId: string) => void
  /** 数据版本令牌：外部（扩展采集）写入新数据时由外壳 +1，触发本页重拉 */
  refreshToken?: number
}) {
  const [data, setData] = useState<DailyReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchDaily()
      .then(setData)
      .catch((e: Error) => setError(e.message))
  }, [refreshToken])

  if (error) return <div className="notice notice-bad">加载失败：{error}</div>
  if (!data) return <div className="empty">加载中…</div>

  return (
    <>
      <div className="brief-head">
        <div className="brief-date">{data.date}</div>
        <p className="brief-line">{data.headline}</p>
        <p className="muted brief-note">
          简报由库内数据实时生成。接上大模型后，这里会变成真正会「写」的晨报（含推荐理由与沟通话术）。
        </p>
      </div>

      <div className="brief-grid">
        <section className="brief-col">
          <h3>
            今日新增 <span className="cnt">{data.newToday}</span>
          </h3>
          {data.newCandidates.length === 0 && <div className="empty-mini">今天还没有新简历进来</div>}
          {data.newCandidates.map((c) => (
            <BriefRow key={`${c.candidateId}-${c.positionId}`} item={c} onOpen={onOpenCandidate} />
          ))}
        </section>

        <section className="brief-col">
          <h3>
            今日优先联系 <span className="cnt">{data.recommended.length}</span>
          </h3>
          {data.recommended.length === 0 && <div className="empty-mini">没有待联系的高分候选人</div>}
          {data.recommended.map((c) => (
            <BriefRow key={`${c.candidateId}-${c.positionId}`} item={c} onOpen={onOpenCandidate} />
          ))}
        </section>

        <section className="brief-col">
          <h3>
            该跟进了 <span className="cnt">{data.followUps.length}</span>
          </h3>
          {data.followUps.length === 0 && <div className="empty-mini">没有卡住的流程，保持住</div>}
          {data.followUps.map((c) => (
            <FollowUpRow key={`${c.candidateId}-${c.positionId}`} item={c} onOpen={onOpenCandidate} />
          ))}
        </section>
      </div>

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-title">各岗位进展</div>
        <table className="tbl">
          <thead>
            <tr>
              <th>岗位</th>
              <th className="num">候选人</th>
              <th className="num">平均匹配</th>
              <th className="num">强推</th>
              <th className="num">面试中</th>
              <th className="num">Offer / 入职</th>
            </tr>
          </thead>
          <tbody>
            {data.byPosition.map((p) => (
              <tr key={p.positionId}>
                <td>{p.title}</td>
                <td className="num">{p.count}</td>
                <td className="num">{p.avgScore}</td>
                <td className="num">{p.strongCount}</td>
                <td className="num">{p.interviewCount}</td>
                <td className="num">{p.offerCount}</td>
              </tr>
            ))}
            {data.byPosition.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  暂无数据
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </>
  )
}
