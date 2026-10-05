import type { ApplicationStatus, CandidateQuery, Platform, Position } from '@ria/shared'
import { PLATFORM_LABEL, STATUS_LABEL, STATUS_ORDER } from '@ria/shared'

const PLATFORMS: Platform[] = ['boss', 'liepin', 'offline']

export interface FilterValue extends CandidateQuery {
  q: string
  sort: NonNullable<CandidateQuery['sort']>
}

export const EMPTY_FILTER: FilterValue = {
  q: '',
  positionId: undefined,
  platform: undefined,
  status: undefined,
  minScore: undefined,
  unmatched: undefined,
  sort: 'score',
}

export function FilterPanel({
  positions,
  value,
  total,
  onChange,
  onResetData,
  resetting,
}: {
  positions: Position[]
  value: FilterValue
  total: number
  onChange: (next: FilterValue) => void
  onResetData: () => void
  resetting: boolean
}) {
  const set = <K extends keyof FilterValue>(key: K, v: FilterValue[K]) =>
    onChange({ ...value, [key]: v })

  const dirty =
    value.q !== '' ||
    value.positionId !== undefined ||
    value.platform !== undefined ||
    value.status !== undefined ||
    value.minScore !== undefined ||
    value.unmatched === true

  return (
    <aside className="filters">
      <div className="filter-head">
        <span>筛选</span>
        <span className="filter-count">共 {total} 人</span>
      </div>

      <label className="field">
        <span>关键词</span>
        <input
          type="search"
          placeholder="姓名 / 公司 / 学校 / 技能"
          value={value.q}
          onChange={(e) => set('q', e.target.value)}
        />
      </label>

      <label className="field">
        <span>岗位</span>
        <select
          value={value.positionId ?? ''}
          onChange={(e) => set('positionId', e.target.value || undefined)}
        >
          <option value="">全部岗位</option>
          {positions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>招聘进度</span>
        <select
          value={value.status ?? ''}
          onChange={(e) => set('status', (e.target.value || undefined) as ApplicationStatus | undefined)}
        >
          <option value="">全部进度</option>
          {STATUS_ORDER.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>简历来源</span>
        <select
          value={value.platform ?? ''}
          onChange={(e) => set('platform', (e.target.value || undefined) as Platform | undefined)}
        >
          <option value="">全部来源</option>
          {PLATFORMS.map((p) => (
            <option key={p} value={p}>
              {PLATFORM_LABEL[p]}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>最低匹配度</span>
        <select
          value={value.minScore ?? ''}
          onChange={(e) => set('minScore', e.target.value ? Number(e.target.value) : undefined)}
        >
          <option value="">不限</option>
          <option value="85">85 分以上（强推）</option>
          <option value="70">70 分以上（可看）</option>
          <option value="60">60 分以上</option>
        </select>
      </label>

      <label className="field">
        <span>排序</span>
        <select
          value={value.sort}
          onChange={(e) => set('sort', e.target.value as FilterValue['sort'])}
        >
          <option value="score">匹配度从高到低</option>
          <option value="recent">最新采集优先 ★</option>
          <option value="updated">最近更新优先</option>
          <option value="name">按姓名</option>
        </select>
      </label>

      <label className="field field-check">
        <input
          type="checkbox"
          checked={value.unmatched === true}
          onChange={(e) => set('unmatched', e.target.checked ? true : undefined)}
        />
        <span>只看待匹配（还没归到岗位的）</span>
      </label>

      <p className="hint">
        刚采集进来的简历如果还没归到岗位，默认按匹配度排序会被压到列表最后 ——
        用「最新采集优先」或勾上「只看待匹配」就能立刻看到。
      </p>

      <button className="btn-ghost" disabled={!dirty} onClick={() => onChange({ ...EMPTY_FILTER, sort: value.sort })}>
        清空筛选
      </button>

      <div className="filter-foot">
        <button className="btn-ghost" onClick={onResetData} disabled={resetting}>
          {resetting ? '重置中…' : '重置示例数据'}
        </button>
        <p className="hint">测试用：把数据清空并重新灌入示例简历。</p>
      </div>
    </aside>
  )
}
