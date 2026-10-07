import type {
  ApplicationStatus,
  CandidateFacets,
  CandidateQuery,
  FacetValue,
  Platform,
  Position,
} from '@ria/shared'
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

/**
 * 年龄 / 工作年限用**区间下拉**而不是两个数字输入框。
 *
 * 理由：HR 说「30 岁左右」「5 年以上」是区间概念，让人工填上下限既慢又容易填反；
 * 而且区间下拉能一眼看出当前筛的是哪一档。值就是这一档的 [下限, 上限]。
 */
const RANGES: Array<{ label: string; min?: number; max?: number }> = [
  { label: '不限' },
  { label: '25 以下', max: 25 },
  { label: '26–30', min: 26, max: 30 },
  { label: '31–35', min: 31, max: 35 },
  { label: '36–40', min: 36, max: 40 },
  { label: '41 以上', min: 41 },
]

const YEAR_RANGES: Array<{ label: string; min?: number; max?: number }> = [
  { label: '不限' },
  { label: '1 年以内', max: 1 },
  { label: '2–3 年', min: 2, max: 3 },
  { label: '4–5 年', min: 4, max: 5 },
  { label: '6–10 年', min: 6, max: 10 },
  { label: '10 年以上', min: 11 },
]

/** 从 [下限, 上限] 反查出对应的选项 label（用于受控 select） */
function rangeLabel(ranges: typeof RANGES, min?: number, max?: number): string {
  const hit = ranges.find((r) => r.min === min && r.max === max)
  return hit ? hit.label : '不限'
}

/** 采集时间档位 → 天数 */
const CAPTURE_DAYS: Array<{ label: string; days?: number }> = [
  { label: '不限' },
  { label: '今天/最近 1 天', days: 1 },
  { label: '最近 7 天', days: 7 },
  { label: '最近 30 天', days: 30 },
]

export function FilterPanel({
  positions,
  facets,
  value,
  total,
  onChange,
  onResetData,
  resetting,
}: {
  positions: Position[]
  /** 下拉的可选值（数据里真实存在的值 + 人数）；还没加载到时传 null */
  facets: CandidateFacets | null
  value: FilterValue
  total: number
  onChange: (next: FilterValue) => void
  onResetData: () => void
  resetting: boolean
}) {
  const set = <K extends keyof FilterValue>(key: K, v: FilterValue[K]) =>
    onChange({ ...value, [key]: v })

  /** 一次改多个字段（区间下拉要同时改 min 和 max） */
  const setMany = (patch: Partial<FilterValue>) => onChange({ ...value, ...patch })

  const dirty =
    value.q !== '' ||
    value.positionId !== undefined ||
    value.platform !== undefined ||
    value.status !== undefined ||
    value.minScore !== undefined ||
    value.unmatched === true ||
    value.city !== undefined ||
    value.degree !== undefined ||
    value.educationMode !== undefined ||
    value.schoolTier !== undefined ||
    value.minAge !== undefined ||
    value.maxAge !== undefined ||
    value.minYears !== undefined ||
    value.maxYears !== undefined ||
    value.language !== undefined ||
    value.captureMethod !== undefined ||
    value.capturedWithinDays !== undefined ||
    value.hasContact === true

  /** 字段级筛选的那几个 string 键（受控下拉共用） */
  type FacetKey = 'city' | 'degree' | 'educationMode' | 'schoolTier' | 'language'
  const setFacet = (key: FacetKey, v?: string) => setMany({ [key]: v } as Partial<FilterValue>)

  /** 渲染一个「可选值 + 人数」的下拉（数据驱动的那几项共用） */
  const facetSelect = (
    label: string,
    key: FacetKey,
    list: FacetValue[] | undefined,
    allLabel: string
  ) => (
    <label className="field">
      <span>{label}</span>
      <select value={(value[key] as string | undefined) ?? ''} onChange={(e) => setFacet(key, e.target.value || undefined)}>
        <option value="">{allLabel}</option>
        {(list ?? []).map((f) => (
          <option key={f.value} value={f.value}>
            {f.value}（{f.count}）
          </option>
        ))}
      </select>
    </label>
  )

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

      {/* ---- 字段级筛选：简历里已经抽出来的结构化字段 ---- */}
      <div className="filter-sep">硬条件</div>

      {facetSelect('城市', 'city', facets?.cities, '全部城市')}
      {facetSelect('学历', 'degree', facets?.degrees, '全部学历')}
      {facetSelect('学历性质', 'educationMode', facets?.educationModes, '不限')}
      {facetSelect('院校层次', 'schoolTier', facets?.schoolTiers, '不限')}
      {facetSelect('语言', 'language', facets?.languages, '不限')}

      <label className="field">
        <span>年龄</span>
        <select
          value={rangeLabel(RANGES, value.minAge, value.maxAge)}
          onChange={(e) => {
            const r = RANGES.find((x) => x.label === e.target.value)
            setMany({ minAge: r?.min, maxAge: r?.max })
          }}
        >
          {RANGES.map((r) => (
            <option key={r.label} value={r.label}>
              {r.label}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>工作年限</span>
        <select
          value={rangeLabel(YEAR_RANGES, value.minYears, value.maxYears)}
          onChange={(e) => {
            const r = YEAR_RANGES.find((x) => x.label === e.target.value)
            setMany({ minYears: r?.min, maxYears: r?.max })
          }}
        >
          {YEAR_RANGES.map((r) => (
            <option key={r.label} value={r.label}>
              {r.label}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>采集方式</span>
        <select
          value={value.captureMethod ?? ''}
          onChange={(e) =>
            setMany({ captureMethod: (e.target.value || undefined) as FilterValue['captureMethod'] })
          }
        >
          <option value="">全部</option>
          <option value="auto">扩展自动采集</option>
          <option value="manual">我手动保存的</option>
        </select>
      </label>

      <label className="field">
        <span>采集时间</span>
        <select
          value={value.capturedWithinDays ?? ''}
          onChange={(e) =>
            setMany({
              capturedWithinDays: e.target.value ? Number(e.target.value) : undefined,
            })
          }
        >
          {CAPTURE_DAYS.map((d) => (
            <option key={d.label} value={d.days ?? ''}>
              {d.label}
            </option>
          ))}
        </select>
      </label>

      <label className="field field-check">
        <input
          type="checkbox"
          checked={value.hasContact === true}
          onChange={(e) => setMany({ hasContact: e.target.checked ? true : undefined })}
        />
        <span>只看有联系方式的（手机或邮箱）</span>
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
