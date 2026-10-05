import { useCallback, useEffect, useState } from 'react'
import { PLATFORM_LABEL } from '@ria/shared'
import { fetchIgnored, restoreIgnored, type IgnoredItem } from '../api'
import { PlatformTag } from './Badges'

/**
 * 「不再采集名单」面板。
 *
 * 这些人是在删除简历时被勾上「同时设为不再采集此人」的 ——
 * 名单存在的意义是：以后即使扩展又打开了他们的简历页，也不会再存进库里。
 * 所以这里只做两件事：看见有谁、以及把人放回去（恢复采集）。
 *
 * 刻意不做弹窗：列表直接铺在页面里，用完点「收起」。
 */
function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function IgnoreListPanel({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<IgnoredItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  /** 正在恢复的那条 id —— 只禁用它自己的按钮，别把整张表锁死 */
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    fetchIgnored()
      .then((d) => {
        setItems(d.items)
        setError(null)
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const handleRestore = useCallback(
    async (item: IgnoredItem) => {
      setBusyId(item.id)
      try {
        await restoreIgnored(item.id)
        setHint(`已恢复采集「${item.name}」—— 以后扩展采到他的简历会正常存进来。`)
        setError(null)
        load()
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusyId(null)
      }
    },
    [load]
  )

  return (
    <section className="panel ignore-panel">
      <div className="ignore-hd">
        <div>
          <h3 className="ignore-title">不再采集名单</h3>
          <p className="hint" style={{ marginTop: 2 }}>
            这些人在你删除时被设为不再采集 —— 即使以后又打开他们的简历，扩展也不会再存进来。
          </p>
        </div>
        <button type="button" className="btn-ghost btn-inline" onClick={onClose}>
          收起
        </button>
      </div>

      {error && <div className="notice notice-bad">操作失败：{error}</div>}
      {hint && !error && <div className="notice notice-ok">{hint}</div>}

      {loading && items.length === 0 && !error && <div className="empty-mini">载入中…</div>}

      {!loading && !error && items.length === 0 && <div className="empty-mini">名单是空的</div>}

      {items.length > 0 && (
        <table className="tbl">
          <thead>
            <tr>
              <th>姓名</th>
              <th>平台</th>
              <th>加入时间</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id}>
                <td>{it.name}</td>
                <td>
                  <PlatformTag platform={it.platform} />
                  <span className="muted" style={{ marginLeft: 6 }}>
                    {PLATFORM_LABEL[it.platform]}
                  </span>
                </td>
                <td className="muted">{fmtTime(it.ignoredAt)}</td>
                <td className="ignore-acts">
                  <button
                    type="button"
                    className="btn-ghost btn-inline"
                    disabled={busyId === it.id}
                    onClick={() => void handleRestore(it)}
                    title="把这个人从名单里移除，之后采集到的简历会正常入库"
                  >
                    {busyId === it.id ? '恢复中…' : '恢复采集'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
