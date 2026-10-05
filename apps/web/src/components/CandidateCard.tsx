import type { CandidateRow } from '@ria/shared'
import { PlatformTag, ScoreBadge, StatusTag } from './Badges'

/** 采集时间的人话写法：刚刚 / 12 分钟前 / 3 小时前 / 2 天前 */
function shortWhen(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const mins = Math.floor((Date.now() - t) / 60000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  return `${days} 天前`
}

export function CandidateCard({
  row,
  active,
  picked = false,
  onPick,
  onClick,
}: {
  row: CandidateRow
  active: boolean
  /** 是否被勾选（用于批量导出 PDF） */
  picked?: boolean
  onPick?: (next: boolean) => void
  onClick: () => void
}) {
  const c = row.candidate
  const meta = [
    c.city,
    c.degree,
    // 学历性质也放到卡面上 —— 「非统招」是 HR 要一眼看到的信息
    c.educationMode ? `(${c.educationMode})` : undefined,
    c.school ? `${c.school}${c.schoolTier ? `·${c.schoolTier}` : ''}` : undefined,
    c.yearsOfExperience !== undefined ? `${c.yearsOfExperience} 年经验` : undefined,
    c.age !== undefined ? `${c.age} 岁` : undefined,
    c.expectedSalary ? `期望 ${c.expectedSalary}` : undefined,
  ].filter(Boolean) as string[]

  return (
    <article className={`cand${active ? ' cand-active' : ''}${picked ? ' cand-picked' : ''}`} onClick={onClick}>
      {onPick && (
        <label
          className="cand-pick"
          onClick={(e) => e.stopPropagation()}
          title="勾选后可把多份简历合成一个 PDF 交给业务部门"
        >
          <input type="checkbox" checked={picked} onChange={(e) => onPick(e.target.checked)} />
        </label>
      )}
      <div className="cand-top">
        <div className="cand-name">
          <span>{c.name}</span>
          {c.parseState === 'raw' && <span className="tag tag-warn">待解析</span>}
        </div>
        <ScoreBadge score={row.score} />
      </div>

      <div className="cand-title">
        {c.currentCompany ? (
          <>
            <b>{c.currentCompany}</b>
            {c.currentTitle && <span> · {c.currentTitle}</span>}
          </>
        ) : (
          <span className="muted">公司 / 职位待解析</span>
        )}
      </div>

      <div className="cand-meta">{meta.join(' · ')}</div>

      <div className="cand-tags">
        <StatusTag status={row.status} />
        <PlatformTag platform={row.platform} />
        {row.positionTitle && <span className="tag tag-pos">{row.positionTitle}</span>}
        {row.matchCount === 0 && <span className="tag tag-warn">待匹配岗位</span>}
        {row.matchCount > 1 && <span className="tag tag-more">关联 {row.matchCount} 个岗位</span>}
        {row.capturedAt && <span className="tag">采集 {shortWhen(row.capturedAt)}</span>}
      </div>

      {c.skills.length > 0 && (
        <div className="chips">
          {c.skills.slice(0, 6).map((s) => (
            <span className="chip" key={s}>
              {s}
            </span>
          ))}
          {c.skills.length > 6 && <span className="chip chip-more">+{c.skills.length - 6}</span>}
        </div>
      )}

      {row.hitPoints[0] && <div className="cand-hit">✓ {row.hitPoints[0]}</div>}
    </article>
  )
}
