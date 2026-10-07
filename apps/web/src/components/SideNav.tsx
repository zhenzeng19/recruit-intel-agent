import type { PriorityLevel, Stats } from '@ria/shared'
import { ROUTES, type RouteKey } from '../router'
import { RouteIcon } from './icons'

/**
 * 路径太长会把侧边栏撑破，只留最后两级（`…\招聘agent-data`）。
 * 完整路径在 title 里，鼠标悬浮能看到。
 */
function shortPath(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts.length <= 2 ? p : '…\\' + parts.slice(-2).join('\\')
}

/**
 * 左侧导航。
 * 六个入口常驻，点击即切换到对应页面（切换通过 hash 路由，可前进后退、可分享链接）。
 */
export function SideNav({
  current,
  onNav,
  stats,
  serverOk,
  todoCounts,
  dataDir,
  onManualRefresh,
}: {
  current: RouteKey
  onNav: (key: RouteKey) => void
  stats: Stats | null
  serverOk: boolean | null
  todoCounts: Record<PriorityLevel, number> | null
  /** 后端实际在用的数据目录（便携包可能因包内目录不可写而改存到用户目录） */
  dataDir: string | null
  onManualRefresh: () => void
}) {
  const pending = todoCounts ? todoCounts.high + todoCounts.mid : 0

  return (
    <aside className="nav">
      <div className="nav-brand">
        <div className="nav-logo">招</div>
        <div className="nav-brand-text">
          <div className="nav-title">招聘情报看台</div>
          <div className="nav-sub">无感采集 · 云端归档</div>
        </div>
      </div>

      <nav className="nav-list">
        {ROUTES.map((r) => (
          <button
            key={r.key}
            type="button"
            className={`nav-item${r.key === current ? ' nav-item-active' : ''}`}
            onClick={() => onNav(r.key)}
            title={r.desc}
          >
            <span className="nav-icon">
              <RouteIcon route={r.key} />
            </span>
            <span className="nav-text">
              <span className="nav-name">{r.title}</span>
              <span className="nav-desc">{r.desc}</span>
            </span>
            {r.key === 'todos' && pending > 0 && <span className="nav-badge">{pending}</span>}
          </button>
        ))}
      </nav>

      <div className="nav-foot">
        <div className="nav-status">
          <span className={`dot${serverOk === false ? ' dot-bad' : serverOk ? ' dot-ok' : ''}`} />
          {serverOk === null ? '检测后端…' : serverOk ? '后端已连接' : '后端未启动'}
        </div>
        {stats && (
          <div className="nav-foot-stat">
            库内 {stats.candidateCount} 人 · {stats.positionCount} 个岗位
          </div>
        )}
        {/*
          数据目录必须显示出来：便携包在包内目录不可写时会自动把数据改存到
          %LOCALAPPDATA%，用户如果不知道这件事，换包/换位置后会以为简历丢了。
          这里给完整路径（悬浮可见），平时只显示最后两级，不占地方。
        */}
        {dataDir && (
          <div className="nav-foot-path" title={`数据实际存在这里：${dataDir}`}>
            <span className="nav-foot-path-label">数据目录</span>
            <span className="nav-foot-path-val">{shortPath(dataDir)}</span>
          </div>
        )}
        <button type="button" className="btn-ghost nav-refresh" onClick={onManualRefresh}>
          立即刷新
        </button>
        <div className="nav-foot-hint">已开启自动刷新（5 秒）</div>
      </div>
    </aside>
  )
}
