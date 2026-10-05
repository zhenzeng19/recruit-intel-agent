import { useEffect, useState } from 'react'
import type { DistItem, TalentMapData } from '@ria/shared'
import { fetchTalentMap } from '../api'

export function BarList({
  title,
  items,
  limit,
  hint,
}: {
  title: string
  items: DistItem[]
  limit?: number
  hint?: string
}) {
  const list = limit ? items.slice(0, limit) : items
  const max = Math.max(1, ...list.map((i) => i.count))

  return (
    <div className="panel">
      <div className="panel-title">
        {title}
        {hint && <span className="panel-hint">{hint}</span>}
      </div>
      {list.length === 0 && <div className="empty-mini">暂无数据</div>}
      {list.map((i) => (
        <div className="bar-row" key={i.name}>
          <span className="bar-label" title={i.name}>
            {i.name}
          </span>
          <span className="bar-track">
            <i style={{ width: `${(i.count / max) * 100}%` }} />
          </span>
          <span className="bar-num">{i.count}</span>
        </div>
      ))}
    </div>
  )
}

/** 技能热度：字号 + 底色随出现次数变化，一眼看出哪些是「大家都会」的 */
export function SkillCloud({ items, limit = 24 }: { items: DistItem[]; limit?: number }) {
  const list = items.slice(0, limit)
  const max = Math.max(1, list[0]?.count ?? 1)

  return (
    <div className="panel">
      <div className="panel-title">
        技能热度 Top {list.length}
        <span className="panel-hint">字号越大，简历里出现得越多</span>
      </div>
      {list.length === 0 && <div className="empty-mini">暂无数据</div>}
      <div className="cloud">
        {list.map((i) => {
          const w = i.count / max
          return (
            <span
              className="cloud-item"
              key={i.name}
              style={{
                fontSize: `${11.5 + w * 7}px`,
                color: w > 0.66 ? '#3b5bdb' : w > 0.33 ? '#1c7ed6' : '#5a6270',
                background: w > 0.66 ? '#eef1fd' : w > 0.33 ? '#eef7fe' : '#f4f6f9',
              }}
            >
              {i.name}
              <em>{i.count}</em>
            </span>
          )
        })}
      </div>
    </div>
  )
}

/** 人才 Map（#/talentmap） */
export function TalentMapPage({ refreshToken }: { refreshToken?: number } = {}) {
  const [data, setData] = useState<TalentMapData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchTalentMap()
      .then(setData)
      .catch((e: Error) => setError(e.message))
  }, [refreshToken])

  if (error) return <div className="notice notice-bad">加载失败：{error}</div>
  if (!data) return <div className="empty">加载中…</div>

  const cards = [
    { label: '覆盖城市', value: data.coverage.cityCount, unit: '个' },
    { label: '来源公司', value: data.coverage.companyCount, unit: '家' },
    { label: '毕业院校', value: data.coverage.schoolCount, unit: '所' },
  ]

  return (
    <>
      <div className="page-head">
        <div>
          <h2>人才 Map</h2>
          <p className="muted">
            从城市、公司、院校、技能四个维度看候选池的结构。用来判断「这个岗位该去哪里捞人」。
          </p>
        </div>
      </div>

      <section className="stats" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        {cards.map((c) => (
          <div className="stat" key={c.label}>
            <div className="stat-label">{c.label}</div>
            <div className="stat-value">
              {c.value}
              <span className="stat-unit">{c.unit}</span>
            </div>
          </div>
        ))}
      </section>

      <div className="map-grid">
        <BarList title="城市分布" items={data.byCity} hint="候选人在哪" />
        <BarList title="学历分布" items={data.byDegree} />
        <BarList title="工作年限分布" items={data.byExperience} />
      </div>

      <div style={{ marginTop: 12 }}>
        <SkillCloud items={data.bySkill} />
      </div>

      <div className="map-grid" style={{ marginTop: 12 }}>
        <BarList title="公司来源 Top 10" items={data.byCompany} limit={10} hint="同一家公司出得多，说明是同行" />
        <BarList title="毕业院校 Top 10" items={data.bySchool} limit={10} />
      </div>

      <section className="panel" style={{ marginTop: 12 }}>
        <div className="panel-title">
          岗位 × 技能矩阵
          <span className="panel-hint">每个岗位候选人最集中的技能，拿来对 JD 和调筛选词</span>
        </div>
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 260 }}>岗位</th>
              <th>候选人技能分布</th>
            </tr>
          </thead>
          <tbody>
            {data.positionSkills.map((p) => (
              <tr key={p.positionId}>
                <td>{p.title}</td>
                <td>
                  <div className="chips">
                    {p.skills.map((s) => (
                      <span className="chip" key={s.name}>
                        {s.name}
                        <em className="chip-cnt">{s.count}</em>
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
            {data.positionSkills.length === 0 && (
              <tr>
                <td colSpan={2} className="muted">
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
