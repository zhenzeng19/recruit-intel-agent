import { useCallback, useEffect, useRef, useState } from 'react'
import type { PriorityLevel, Stats } from '@ria/shared'
import { fetchHealth, fetchRevision, fetchStats, fetchTodos } from './api'
import { SideNav } from './components/SideNav'
import { DailyPage } from './pages/DailyPage'
import { LibraryPage } from './pages/LibraryPage'
import { PipelinePage } from './pages/PipelinePage'
import { PositionsPage } from './pages/PositionsPage'
import { QaPage } from './pages/QaPage'
import { TalentMapPage } from './pages/TalentMapPage'
import { TodosPage } from './pages/TodosPage'
import { useHashRoute } from './router'

/** 自动刷新轮询间隔。本地应用，5 秒足够灵敏，代价也只是一个轻量接口。 */
const POLL_MS = 5000

/**
 * 应用外壳：左侧常驻导航 + 右侧按路由渲染的页面。
 * 路由走 hash（#/library、#/pipeline…），所以刷新 / 前进后退 / 分享链接都能落到同一页。
 *
 * 关于「自动刷新」：
 *   浏览器扩展在招聘网站上采集简历后，是直接把数据 POST 到后端的，
 *   看板这边完全不知情 —— 早先的版本只会在页面挂载时拉一次数据，
 *   于是「扩展明明采到了，看板却一直没变」，得手动 F5 才看得到。
 *   现在的做法：轮询后端的 /api/revision（一个只读整数，几乎零成本），
 *   版本一变就把 refreshToken +1 传下去，各看台靠它重新拉数；
 *   同时在标签页重新可见 / 获得焦点时立刻补查一次，切回来就能看到最新的。
 */
export function App() {
  const [route, params, go] = useHashRoute()
  const [stats, setStats] = useState<Stats | null>(null)
  const [serverOk, setServerOk] = useState<boolean | null>(null)
  const [todoCounts, setTodoCounts] = useState<Record<PriorityLevel, number> | null>(null)
  /** 后端实际在用的数据目录 —— 显示在侧边栏，避免"换包后以为简历丢了" */
  const [dataDir, setDataDir] = useState<string | null>(null)

  /** 数据版本令牌：每次外部数据变化都 +1，各页面以此为依赖重新拉数 */
  const [refreshToken, setRefreshToken] = useState(0)
  /** 自动刷新的提示条（外部采集进来时闪一下，让 HR 知道「刚刚进人了」） */
  const [liveHint, setLiveHint] = useState<string | null>(null)

  const revRef = useRef<number | null>(null)
  const hintTimerRef = useRef<number | null>(null)

  /** 侧边栏上的库内统计与待办角标 */
  const refresh = useCallback(() => {
    fetchStats()
      .then((s) => {
        setStats(s)
        setServerOk(true)
      })
      .catch(() => setServerOk(false))
    fetchTodos()
      .then((t) => setTodoCounts(t.counts))
      .catch(() => undefined)
    // 数据目录只在启动时拿一次就够了（运行中不会变）
    fetchHealth()
      .then((h) => setDataDir(h.dataDir))
      .catch(() => setDataDir(null))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  /** 让所有看台重新拉数（手动刷新按钮 / 外部数据变化都走这里） */
  const bumpData = useCallback(
    (hint?: string) => {
      setRefreshToken((t) => t + 1)
      refresh()
      if (!hint) return
      setLiveHint(hint)
      if (hintTimerRef.current !== null) window.clearTimeout(hintTimerRef.current)
      hintTimerRef.current = window.setTimeout(() => setLiveHint(null), 5000)
    },
    [refresh]
  )

  // ---- 自动刷新：轮询数据版本 + 回到标签页时补查 ----
  useEffect(() => {
    let alive = true

    const check = async () => {
      try {
        const { revision } = await fetchRevision()
        if (!alive) return
        if (revRef.current === null) {
          revRef.current = revision
          return
        }
        if (revision !== revRef.current) {
          revRef.current = revision
          bumpData('检测到新采集的数据，看板已自动刷新')
        }
        setServerOk(true)
      } catch {
        // 后端没起来或正在重启 —— 静默重试，不打扰用户
        if (alive) setServerOk(false)
      }
    }

    void check()
    const timer = window.setInterval(() => void check(), POLL_MS)
    const onWake = () => {
      if (!document.hidden) void check()
    }
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('focus', onWake)

    return () => {
      alive = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('focus', onWake)
      if (hintTimerRef.current !== null) window.clearTimeout(hintTimerRef.current)
    }
  }, [bumpData])

  // ---- 跨页跳转：统一跳到候选人库并带参 ----
  const openCandidate = useCallback(
    (candidateId: string) => {
      go('library', { c: candidateId })
    },
    [go]
  )

  const openPosition = useCallback(
    (positionId: string) => {
      go('library', { p: positionId })
    },
    [go]
  )

  return (
    <div className="shell">
      <SideNav
        current={route}
        onNav={go}
        stats={stats}
        serverOk={serverOk}
        todoCounts={todoCounts}
        dataDir={dataDir}
        onManualRefresh={() => bumpData('已手动刷新')}
      />

      <main className="content">
        <div className="page">
          {liveHint && (
            <div className="notice notice-live" role="status">
              <span className="live-dot" />
              {liveHint}
            </div>
          )}

          {route === 'library' && (
            <LibraryPage
              initialCandidateId={params.c}
              initialPositionId={params.p}
              refreshToken={refreshToken}
              onDataChanged={() => bumpData()}
            />
          )}

          {route === 'pipeline' && (
            <PipelinePage onOpenPosition={openPosition} refreshToken={refreshToken} />
          )}

          {route === 'positions' && (
            <PositionsPage
              refreshToken={refreshToken}
              onOpenPosition={openPosition}
              onDataChanged={() => bumpData()}
            />
          )}

          {route === 'daily' && <DailyPage onOpenCandidate={openCandidate} refreshToken={refreshToken} />}

          {route === 'talentmap' && <TalentMapPage refreshToken={refreshToken} />}

          {route === 'qa' && <QaPage initialQuestion={params.q} onOpenCandidate={openCandidate} />}

          {route === 'todos' && <TodosPage onOpenCandidate={openCandidate} refreshToken={refreshToken} />}

          <footer className="ft">
            数据存于后端数据目录（默认仓库同级的 招聘agent-data/）—— 七个看台都是用同一批数据现算的，
            改一个进度，漏斗 / 简报 / 待办会跟着变。扩展采到新简历时，看板会自动刷新。
          </footer>
        </div>
      </main>
    </div>
  )
}
