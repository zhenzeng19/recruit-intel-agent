import { useEffect, useState } from 'react'
import type { PriorityLevel, TodoData, TodoItem } from '@ria/shared'
import { fetchTodos } from '../api'
import { ScoreBadge, StatusTag } from '../components/Badges'
import { ArrowIcon } from '../components/icons'

const GROUPS: Array<{ key: PriorityLevel; title: string; desc: string }> = [
  { key: 'high', title: '今天必须处理', desc: '流程卡住了，或高分候选人没人管' },
  { key: 'mid', title: '这两天处理', desc: '推进变慢，别在池子里放凉' },
  { key: 'low', title: '有空再看', desc: '排队中的可看候选人' },
]

export function TodoRow({ item, onOpen }: { item: TodoItem; onOpen: (id: string) => void }) {
  return (
    <div className="todo-row" onClick={() => onOpen(item.candidateId)}>
      <div className="todo-left">
        <div className="todo-title">
          <span className="todo-name">{item.candidateName}</span>
          <ScoreBadge score={item.score} showLabel={false} />
          <StatusTag status={item.status} />
        </div>
        <div className="todo-sub">{item.reason}</div>
      </div>
      <div className="todo-right">
        <span className="todo-pos" title={item.positionTitle}>
          {item.positionTitle}
        </span>
        <span className="todo-days">{item.daysSinceUpdate} 天</span>
        <ArrowIcon />
      </div>
    </div>
  )
}

/** 待办中心（#/todos） */
export function TodosPage({
  onOpenCandidate,
  refreshToken,
}: {
  onOpenCandidate: (candidateId: string) => void
  /** 数据版本令牌：外部（扩展采集）写入新数据时由外壳 +1，触发本页重拉 */
  refreshToken?: number
}) {
  const [data, setData] = useState<TodoData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchTodos()
      .then(setData)
      .catch((e: Error) => setError(e.message))
  }, [refreshToken])

  if (error) return <div className="notice notice-bad">加载失败：{error}</div>
  if (!data) return <div className="empty">加载中…</div>

  return (
    <>
      <div className="page-head">
        <div>
          <h2>待办中心</h2>
          <p className="muted">
            规则自动生成：只看「确实卡住了」和「高分却没人管」，不做无差别提醒。
          </p>
        </div>
        <div className="page-head-kpi">
          <span>
            今天必须处理 <b className="kpi-red">{data.counts.high}</b>
          </span>
          <span>
            这两天 <b>{data.counts.mid}</b>
          </span>
          <span>
            有空再看 <b>{data.counts.low}</b>
          </span>
        </div>
      </div>

      {data.items.length === 0 && (
        <div className="empty">
          <div>当前没有待跟进事项</div>
          <div className="muted">所有流程都在正常推进中。</div>
        </div>
      )}

      {GROUPS.map((g) => {
        const items = data.items.filter((i) => i.priority === g.key)
        if (items.length === 0) return null
        return (
          <section className="todo-group" key={g.key}>
            <div className={`todo-group-hd todo-hd-${g.key}`}>
              <span className="todo-group-title">{g.title}</span>
              <span className="todo-group-desc">
                {g.desc} · {items.length} 条
              </span>
            </div>
            <div className="todo-list">
              {items.map((i) => (
                <TodoRow key={i.id} item={i} onOpen={onOpenCandidate} />
              ))}
            </div>
          </section>
        )
      })}
    </>
  )
}
