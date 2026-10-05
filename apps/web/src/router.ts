// ============================================================
// 极简 hash 路由
// ------------------------------------------------------------
// 为什么不用 react-router：
//   1. 入口只有七个（候选人库 / 岗位漏斗 / 岗位管理 / 每日简报 / 人才 Map / 智能问答 / 待办中心）、
//      无嵌套路由，一个 hook 足够；
//   2. 用 hash 而非 history —— 纯静态部署时不需要服务端配 rewrite，
//      刷新、前进后退、把链接发给同事都能正确落到同一页。
// ============================================================
import { useCallback, useEffect, useState } from 'react'

export type RouteKey =
  | 'library'
  | 'pipeline'
  | 'positions'
  | 'daily'
  | 'talentmap'
  | 'qa'
  | 'todos'

export interface RouteDef {
  key: RouteKey
  title: string
  desc: string
}

/** 看台的入口（顺序即侧边栏顺序） */
export const ROUTES: RouteDef[] = [
  { key: 'library', title: '候选人库', desc: '按岗位 / 匹配度 / 进度浏览与检索' },
  { key: 'pipeline', title: '岗位漏斗', desc: '每个岗位的候选人推进进度' },
  { key: 'positions', title: '岗位管理', desc: '加岗位、改 JD、看每个岗位招得怎么样' },
  { key: 'daily', title: '每日简报', desc: '今天每个岗位该推谁、该跟进谁' },
  { key: 'talentmap', title: '人才 Map', desc: '地理 · 技能 · 公司来源分布' },
  { key: 'qa', title: '智能问答', desc: '用自然语言检索候选人库' },
  { key: 'todos', title: '待办中心', desc: '今日 / 逾期待跟进清单' },
]

const KEYS: string[] = ROUTES.map((r) => r.key)

export const DEFAULT_ROUTE: RouteKey = 'library'

function readHash(): string {
  if (typeof window === 'undefined') return ''
  return window.location.hash.replace(/^#\/?/, '')
}

/** 解析 `#/library?c=xxx&p=yyy` → { route, params } */
function parse(hash: string): { route: RouteKey; params: Record<string, string> } {
  const [path, search = ''] = hash.split('?')
  const route = (KEYS.includes(path) ? path : DEFAULT_ROUTE) as RouteKey
  const params: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(search)) params[k] = v
  return { route, params }
}

export type Navigate = (key: RouteKey, params?: Record<string, string>) => void

/**
 * 当前路由 + 跳转函数。
 * 跳转写进 location.hash，因此「点按钮跳转」和「直接改地址栏」等价，
 * 浏览器前进/后退也能正常回到上一页。
 */
export function useHashRoute(): [RouteKey, Record<string, string>, Navigate] {
  const [state, setState] = useState(() => parse(readHash()))

  useEffect(() => {
    const onHash = () => setState(parse(readHash()))
    window.addEventListener('hashchange', onHash)
    // 首次进入补一个 hash，保证地址栏能看出当前在哪一页
    if (!readHash()) window.location.hash = `#/${DEFAULT_ROUTE}`
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const go = useCallback<Navigate>((key, params) => {
    const qs = params && Object.keys(params).length ? `?${new URLSearchParams(params)}` : ''
    const next = `#/${key}${qs}`
    if (readHash() === `${key}${qs}`) {
      setState(parse(`${key}${qs}`))
      return
    }
    window.location.hash = next
  }, [])

  return [state.route, state.params, go]
}
