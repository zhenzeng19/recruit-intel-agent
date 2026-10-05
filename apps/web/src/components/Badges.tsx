import type { ApplicationStatus, Platform } from '@ria/shared'
import { PLATFORM_LABEL, STATUS_COLOR, STATUS_LABEL } from '@ria/shared'

/** 匹配度分档配色：≥85 强推 / 70–84 可看 / <70 待定 */
export function scoreLevel(score?: number): 'high' | 'mid' | 'low' | 'none' {
  if (score === undefined || score === null) return 'none'
  if (score >= 85) return 'high'
  if (score >= 70) return 'mid'
  return 'low'
}

const SCORE_TEXT: Record<ReturnType<typeof scoreLevel>, string> = {
  high: '强推',
  mid: '可看',
  low: '待定',
  none: '未评',
}

export function ScoreBadge({ score, showLabel = true }: { score?: number; showLabel?: boolean }) {
  const level = scoreLevel(score)
  return (
    <span className={`score score-${level}`}>
      <b>{score ?? '—'}</b>
      {showLabel && <em>{SCORE_TEXT[level]}</em>}
    </span>
  )
}

export function StatusTag({ status }: { status?: ApplicationStatus }) {
  if (!status) return <span className="tag">未入岗</span>
  const c = STATUS_COLOR[status]
  return (
    <span className="tag" style={{ background: c.bg, color: c.fg }}>
      {STATUS_LABEL[status]}
    </span>
  )
}

export function PlatformTag({ platform }: { platform?: Platform }) {
  if (!platform) return null
  return <span className={`plat plat-${platform}`}>{PLATFORM_LABEL[platform]}</span>
}
