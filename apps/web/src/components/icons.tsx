import type { RouteKey } from '../router'

/**
 * 内联 SVG 图标。
 * 不引图标库：6 个图标不值得多一个依赖，且内联后颜色跟随 currentColor，
 * 深色/浅色主题都不用额外适配。
 */
const svgProps = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
})

const PATHS: Record<RouteKey, JSX.Element> = {
  // 候选人库：档案卡片
  library: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.8" />
      <path d="M5.2 5.8h5.6M5.2 8h5.6M5.2 10.2h3.2" />
    </>
  ),
  // 岗位漏斗：漏斗
  pipeline: (
    <>
      <path d="M2.5 3.2h11L9.6 8.4v4.1l-3.2 1.6V8.4z" />
    </>
  ),
  // 岗位管理：公文包
  positions: (
    <>
      <rect x="2.2" y="5.4" width="11.6" height="7.8" rx="1.6" />
      <path d="M6.1 5.4V4.2c0-.6.5-1.1 1.1-1.1h1.6c.6 0 1.1.5 1.1 1.1v1.2" />
      <path d="M2.2 8.9h11.6" />
    </>
  ),
  // 每日简报：报纸
  daily: (
    <>
      <path d="M2.5 4.2h7.4v8.3H3.6a1.1 1.1 0 0 1-1.1-1.1z" />
      <path d="M9.9 6.6h3.6v4.8a1.1 1.1 0 0 1-1.1 1.1H9.9" />
      <path d="M4.4 6.4h3.6M4.4 8.3h3.6M4.4 10.2h2.3" />
    </>
  ),
  // 人才 Map：地图折页
  talentmap: (
    <>
      <path d="M2.5 4.4l3.7-1.5 3.6 1.5 3.7-1.5v7.9l-3.7 1.5-3.6-1.5-3.7 1.5z" />
      <path d="M6.2 2.9v7.9M9.8 4.4v7.9" />
    </>
  ),
  // 智能问答：对话气泡
  qa: (
    <>
      <path d="M2.6 7.1c0-2.5 2.4-4.5 5.4-4.5s5.4 2 5.4 4.5-2.4 4.5-5.4 4.5c-.7 0-1.3-.1-1.9-.3l-2.8 1.3.7-2.2A4.5 4.5 0 0 1 2.6 7.1z" />
    </>
  ),
  // 待办中心：勾选框
  todos: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2.6" />
      <path d="M5.4 8.2l1.9 1.9 3.4-3.7" />
    </>
  ),
}

export function RouteIcon({ route, size = 16 }: { route: RouteKey; size?: number }) {
  return <svg {...svgProps(size)}>{PATHS[route]}</svg>
}

/** 箭头：用在「跳转查看」这类引导上 */
export function ArrowIcon({ size = 12 }: { size?: number }) {
  return (
    <svg {...svgProps(size)}>
      <path d="M3.2 8h9.6M9.2 4.6L12.8 8l-3.6 3.4" />
    </svg>
  )
}
