// ============================================================
// 页内浮动卡片（Shadow DOM）
// ------------------------------------------------------------
// 为什么必须有它：扩展原本是「无感采集」——用户全程看不到任何反馈，
// 也没法对某一份简历说「别存」。要支持「保存前询问」和「手动补采」，
// 控制点就必须出现在**用户视线所在的地方**（页面上），而不是让他每次
// 都去点工具栏图标。
//
// 三个形态：
//   confirm 且识别到简历 → 展开的询问卡（保存 / 这次不存 / 本页都不再问）
//   auto                → 收起的小圆点，点一下展开，里面有「手动保存这一页」
//   其他                → 细小的状态提示（未识别到 / 本页已暂停 / 回执）
//
// 实现上的四条硬要求（都是别人踩过的坑）：
//   ① Shadow DOM + :host{all:initial} —— 否则猎聘的全局 font-size / reset
//      会把卡片搞变形（站点 CSS 是全局作用域的）
//   ② 挂在 document.documentElement 而不是 body —— 重度 SPA 重渲染可能替换
//      body，挂 body 上会连卡片一起消失
//   ③ 自愈：MutationObserver 发现自己的宿主被移除就重新挂上
//   ④ 位置可拖拽并持久化，默认避开右下角（那里常有站点自己的客服/反馈按钮）
// ============================================================
import type { CaptureMode } from '@ria/shared'

export interface OverlayResume {
  name: string
  chars: number
  /** 正文未达自动阈值（可能不完整） */
  lowConfidence?: boolean
  /** 疑似「一屏多人」的列表页 */
  listPage?: boolean
}

export interface OverlayFeedback {
  kind: 'ok' | 'warn' | 'err'
  text: string
}

/** 下拉里的一项岗位 */
export interface OverlayPosition {
  id: string
  title: string
}

export interface OverlayView {
  mode: CaptureMode
  /** auto 模式下是否显示状态小圆点 */
  showStatusChip: boolean
  /** 当前识别到的简历；null = 本帧没识别到 */
  resume: OverlayResume | null
  /** confirm 模式下正在等用户决定（此时面板必须展开） */
  asking: boolean
  /** 本页已被用户选择「都不再问」 */
  pathPaused: boolean
  feedback: OverlayFeedback | null
  /** 可选岗位（保存时「挂到哪个岗位」的下拉） */
  positions?: OverlayPosition[]
  /** 当前选中的岗位 id；空字符串 = 不指定（按规则自动挂） */
  selectedPositionId?: string
  /** 平台自己推荐的职位（猎聘头部的「推荐职位：X」），用来提示默认值 */
  recommendedTitle?: string
  /**
   * 规则原本推荐谁。
   * 方案 C：用户选岗后默认只留他选的那个，但要如实告诉他「规则原本推荐 X」，
   * 并给一个「也挂上」的按钮 —— 信息不丢，漏斗也不被污染。
   */
  ruleSuggested?: { positionId: string; title: string; score: number } | null
}

export interface OverlayHandlers {
  onSave: (positionId?: string) => void
  onSkip: (scope: 'once' | 'path') => void
  onResumePath: () => void
  onPosChange: (pos: { right: number; bottom: number }) => void
  /** 选了岗位（要记住，下次默认就用它） */
  onSelectPosition?: (positionId: string) => void
  /** 「也挂上」规则推荐的那个岗位 */
  onAttachSuggested?: (positionId: string) => void
}

const HOST_ID = 'ria-catcher-overlay'
const DEFAULT_POS = { right: 20, bottom: 96 }

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.wrap {
  position: fixed;
  z-index: 2147483000;
  font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  color: #1f2328;
  display: flex; align-items: flex-end; gap: 8px; flex-direction: row-reverse;
  pointer-events: none;
}
.wrap > * { pointer-events: auto; }
.dot {
  width: 34px; height: 34px; flex: none; border-radius: 50%;
  border: 1px solid rgba(0,0,0,.08); background: #fff; cursor: pointer;
  box-shadow: 0 4px 14px rgba(15,23,42,.16);
  display: flex; align-items: center; justify-content: center;
  font: 15px/1 -apple-system, "Segoe UI", sans-serif; padding: 0;
  transition: transform .12s, box-shadow .12s;
  color: #4338ca;
}
.dot:hover { transform: scale(1.06); box-shadow: 0 6px 18px rgba(15,23,42,.22); }
.dot.ok { color: #16a34a; }
.dot.warn { color: #d97706; }
.dot.bad { color: #dc2626; }
.dot.paused { color: #6b7280; }
.panel {
  max-width: 308px;
  background: #fff; border: 1px solid #e5e7eb; border-radius: 12px;
  box-shadow: 0 10px 34px rgba(15,23,42,.18);
  padding: 11px 12px;
}
.panel[hidden] { display: none; }
.t { font-weight: 650; font-size: 13px; margin-bottom: 3px; }
.sub { font-size: 11.5px; color: #6b7280; line-height: 1.45; }
.name { color: #111827; font-weight: 600; }
.acts { display: flex; gap: 6px; margin-top: 9px; flex-wrap: wrap; }
button.b {
  font: inherit; font-size: 12px; cursor: pointer; padding: 6px 10px;
  border-radius: 7px; border: 1px solid #e5e7eb; background: #fff; color: #1f2328;
  transition: .12s;
}
button.b:hover { background: #f6f7f9; border-color: #d1d5db; }
button.b.pri { background: #4338ca; border-color: #4338ca; color: #fff; font-weight: 550; }
button.b.pri:hover { background: #3730a3; border-color: #3730a3; }
button.b.ghost { border-color: transparent; color: #6b7280; }
button.b.ghost:hover { background: #f6f7f9; }
.fb { margin-top: 8px; padding: 6px 8px; border-radius: 7px; font-size: 11.5px; line-height: 1.45; }
.fb.ok { background: #f0fdf4; border: 1px solid #bbf7d0; color: #15803d; }
.fb.warn { background: #fffbeb; border: 1px solid #fed7aa; color: #b45309; }
.fb.err { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; }
.note { margin-top: 7px; font-size: 11px; color: #b45309; line-height: 1.45; }
.hintline { margin-top: 5px; font-size: 11px; color: #6b7280; line-height: 1.45; }
.pick { display: flex; align-items: center; gap: 7px; margin-top: 9px; }
.pick-l { font-size: 11.5px; color: #6b7280; flex: none; }
.pick-s {
  flex: 1; min-width: 0; font: inherit; font-size: 12px; padding: 5px 6px;
  border: 1px solid #e5e7eb; border-radius: 7px; background: #fff; color: #1f2328;
}
.sug {
  display: flex; align-items: center; gap: 8px; margin-top: 8px;
  padding-top: 8px; border-top: 1px dashed #e5e7eb;
}
.sug-t { flex: 1; font-size: 11px; color: #6b7280; line-height: 1.45; }
.badge {
  display: inline-block; font-size: 10.5px; padding: 1px 5px; border-radius: 4px;
  background: #eef1fd; color: #3b5bdb; margin-right: 4px; vertical-align: 1px;
}
`

/**
 * 页面右下角的浮动卡片。
 *
 * 生命周期：content script 里 `new Overlay(handlers, settings.cardPos)` → `render(view)`。
 * `mode: 'off'` 时 render 会把自己整个销毁（页面上零打扰）。
 */
export class Overlay {
  private host: HTMLDivElement | null = null
  private root: ShadowRoot | null = null
  private wrap: HTMLDivElement | null = null
  private panel: HTMLDivElement | null = null
  private dot: HTMLButtonElement | null = null
  private view: OverlayView | null = null
  private expanded = false
  private pos: { right: number; bottom: number }
  private healObserver: MutationObserver | null = null
  /** 上一次渲染的面板内容指纹（没变就不重建 DOM，避免打断用户操作下拉） */
  private panelKey: string | null = null

  constructor(
    private handlers: OverlayHandlers,
    pos?: { right: number; bottom: number }
  ) {
    this.pos = pos && typeof pos.right === 'number' ? { ...pos } : { ...DEFAULT_POS }
  }

  /** 按当前视图渲染；mode='off' 时销毁自己 */
  render(view: OverlayView): void {
    this.view = view
    // 关闭模式，或用户关掉了状态点且当下没有任何非说不可的事 → 页面上零打扰。
    // 「非说不可」= 正在等用户回答 / 有回执 / 本页被暂停（需要给出恢复入口）
    const essential = view.asking || !!view.feedback || view.pathPaused
    if (view.mode === 'off' || (!view.showStatusChip && !essential)) {
      this.destroy()
      return
    }

    this.ensure()
    this.paint(view)
  }

  destroy(): void {
    this.healObserver?.disconnect()
    this.healObserver = null
    this.host?.remove()
    this.host = null
    this.root = null
    this.wrap = null
    this.panel = null
    this.dot = null
  }

  // ---------------------------------------------------------------- 挂载

  private ensure(): void {
    if (this.host && this.host.isConnected) return
    if (!this.host) {
      const host = document.createElement('div')
      host.id = HOST_ID
      // 宿主本身不参与布局，避免影响站点页面
      host.style.cssText = 'all:initial;position:static;'
      const root = host.attachShadow({ mode: 'open' })
      const style = document.createElement('style')
      style.textContent = CSS
      root.appendChild(style)

      const wrap = document.createElement('div')
      wrap.className = 'wrap'
      const dot = document.createElement('button')
      dot.className = 'dot'
      dot.type = 'button'
      dot.textContent = '✓'
      dot.title = '招聘捕手 · 点开可选择是否保存这份简历'
      const panel = document.createElement('div')
      panel.className = 'panel'
      panel.hidden = true
      wrap.append(panel, dot)
      root.appendChild(wrap)

      this.host = host
      this.root = root
      this.wrap = wrap
      this.panel = panel
      this.dot = dot
      this.bindDot(dot, wrap)
      this.applyPos()
    }
    try {
      document.documentElement.appendChild(this.host!)
    } catch {
      /* ignore */
    }
    this.watchHeal()
  }

  /** 宿主被站点重渲染摘掉时自动挂回（重度 SPA 上这个真的会发生） */
  private watchHeal(): void {
    if (this.healObserver) return
    try {
      this.healObserver = new MutationObserver(() => {
        if (!this.host) return
        if (!this.host.isConnected) {
          try {
            document.documentElement.appendChild(this.host)
            this.applyPos()
          } catch {
            /* ignore */
          }
        }
      })
      this.healObserver.observe(document.documentElement, { childList: true })
    } catch {
      /* ignore */
    }
  }

  private applyPos(): void {
    if (!this.wrap) return
    this.wrap.style.right = `${Math.max(0, this.pos.right)}px`
    this.wrap.style.bottom = `${Math.max(0, this.pos.bottom)}px`
  }

  // ---------------------------------------------------------------- 交互

  private bindDot(dot: HTMLButtonElement, _wrap: HTMLDivElement): void {
    let dragging = false
    let moved = false
    let startX = 0
    let startY = 0
    let startRight = 0
    let startBottom = 0

    dot.addEventListener('pointerdown', (e) => {
      dragging = true
      moved = false
      startX = e.clientX
      startY = e.clientY
      startRight = this.pos.right
      startBottom = this.pos.bottom
      try {
        dot.setPointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
    })

    dot.addEventListener('pointermove', (e) => {
      if (!dragging) return
      const dx = e.clientX - startX
      const dy = e.clientY - startY
      if (!moved && Math.abs(dx) + Math.abs(dy) < 5) return
      moved = true
      this.pos = {
        right: Math.max(0, startRight - dx),
        bottom: Math.max(0, startBottom - dy),
      }
      this.applyPos()
    })

    const end = (e: PointerEvent) => {
      if (!dragging) return
      dragging = false
      try {
        dot.releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      if (moved) {
        this.handlers.onPosChange({ ...this.pos })
      } else {
        // 没拖动 = 点击 → 切换展开
        this.expanded = !this.expanded
        if (this.view) this.paint(this.view)
      }
    }
    dot.addEventListener('pointerup', end)
    dot.addEventListener('pointercancel', end)
  }

  // ---------------------------------------------------------------- 渲染

  private paint(view: OverlayView): void {
    const { panel, dot } = this
    if (!panel || !dot) return

    // 询问中必须展开 —— 这是等用户回答的问题，不能让他自己去找
    const forcedOpen = view.asking
    const expanded = forcedOpen || this.expanded
    panel.hidden = !expanded

    const r = view.resume
    let dotText = '✓'
    let dotCls = 'dot'
    let title = '招聘捕手'

    if (view.pathPaused) {
      dotText = '⏸'
      dotCls = 'dot paused'
      title = '招聘捕手 · 本页已暂停采集'
    } else if (view.asking && r) {
      dotText = '?'
      dotCls = 'dot warn'
      title = '招聘捕手 · 等你决定这份简历要不要存'
    } else if (r) {
      dotText = '✓'
      dotCls = 'dot ok'
      title = `招聘捕手 · 已识别 ${r.name}（${r.chars} 字）`
    } else {
      dotText = '·'
      dotCls = 'dot'
      title = '招聘捕手 · 本页还没识别到简历'
    }

    dot.textContent = dotText
    dot.className = dotCls
    dot.title = title

    if (!expanded) {
      this.panelKey = null
      return
    }

    // 收起小圆点的形态：auto 模式下 showStatusChip=false 且没有反馈 → 不显示面板
    const wantsPanel =
      view.asking || view.pathPaused || !!view.feedback || !!r || view.showStatusChip
    if (!wantsPanel) {
      panel.hidden = true
      this.panelKey = null
      return
    }
    panel.hidden = false

    // 面板内容没变就别重建 DOM。
    // 为什么必须这样：扫描是高频的（MutationObserver 一抖就重绘），
    // 而询问卡里有个岗位下拉 —— 用户在展开下拉时如果 DOM 被重建，
    // 下拉会被直接关掉，根本选不中。
    const key = [
      view.mode,
      view.asking ? '1' : '0',
      view.pathPaused ? '1' : '0',
      r ? `${r.name}/${r.chars}/${r.lowConfidence ? 1 : 0}/${r.listPage ? 1 : 0}` : '-',
      view.selectedPositionId ?? '',
      (view.positions ?? []).map((p) => p.id).join(','),
      view.recommendedTitle ?? '',
      view.ruleSuggested?.positionId ?? '',
      view.feedback ? `${view.feedback.kind}:${view.feedback.text}` : '',
    ].join('|')
    if (key === this.panelKey) return
    this.panelKey = key
    panel.replaceChildren(...this.buildPanel(view))
  }

  private buildPanel(view: OverlayView): Node[] {
    const out: Node[] = []
    const r = view.resume

    if (view.pathPaused) {
      out.push(node('div', { class: 't' }, '本页已暂停采集'))
      out.push(
        node(
          'div',
          { class: 'sub' },
          '这一页不会再自动采集，也不会再弹询问卡。'
        )
      )
      out.push(
        node(
          'div',
          { class: 'acts' },
          btn('恢复本页采集', 'b pri', () => this.handlers.onResumePath())
        )
      )
      return out
    }

    if (view.asking && r) {
      out.push(
        node(
          'div',
          { class: 't' },
          r.listPage ? '这一页像是列表页' : '识别到一份简历'
        )
      )
      out.push(
        node(
          'div',
          { class: 'sub' },
          ...(r.listPage
            ? [
                '一屏多人，为避免存进包含多个人的脏数据，已跳过自动采集。',
                node('br'),
                '点开某位候选人的在线简历后，再点「保存到看板」。',
              ]
            : [
                node('span', { class: 'name' }, r.name),
                ` · ${r.chars} 字 · 尚未入库`,
              ])
        )
      )
      if (r.lowConfidence) {
        out.push(
          node(
            'div',
            { class: 'note' },
            '⚠ 正文偏短或未达自动识别门槛，可能不完整 —— 建议点开简历完整加载后再存。'
          )
        )
      }

      // ---- 挂到哪个岗位
      const positions = view.positions ?? []
      if (positions.length > 0) {
        const row = node('div', { class: 'pick' })
        row.append(node('label', { class: 'pick-l' }, '挂到岗位'))
        const sel = document.createElement('select')
        sel.className = 'pick-s'
        const none = document.createElement('option')
        none.value = ''
        none.textContent = '不指定（按规则自动挂）'
        sel.appendChild(none)
        for (const p of positions) {
          const o = document.createElement('option')
          o.value = p.id
          o.textContent = p.title
          sel.appendChild(o)
        }
        sel.value = view.selectedPositionId ?? ''
        sel.addEventListener('change', () => {
          this.handlers.onSelectPosition?.(sel.value)
        })
        row.append(sel)
        out.push(row)
      }

      // 平台推荐的职位：猎聘头部写着「推荐职位：项目经理」，拿来提示一下
      if (view.recommendedTitle) {
        const known = positions.some((p) => p.title === view.recommendedTitle)
        out.push(
          node(
            'div',
            { class: 'hintline' },
            `猎聘推荐：${view.recommendedTitle}`,
            known ? '' : '（你的岗位里没有，需要先去「岗位管理」加一个）'
          )
        )
      }

      const acts = node('div', { class: 'acts' })
      acts.append(
        btn('保存到看板', 'b pri', () => this.handlers.onSave(view.selectedPositionId || undefined)),
        btn('这次不存', 'b', () => this.handlers.onSkip('once')),
        btn('本页都不再问', 'b ghost', () => this.handlers.onSkip('path'))
      )
      out.push(acts)
    } else if (r) {
      out.push(
        node(
          'div',
          { class: 't' },
          ...(view.mode === 'auto' ? ['已自动保存'] : ['已识别到简历'])
        )
      )
      out.push(
        node(
          'div',
          { class: 'sub' },
          node('span', { class: 'name' }, r.name),
          ` · ${r.chars} 字 · ${view.mode === 'auto' ? '已进入本地队列' : '尚未入库'}`
        )
      )
      const acts = node('div', { class: 'acts' })
      acts.append(
        btn(view.mode === 'auto' ? '再存一次' : '保存到看板', 'b pri', () => this.handlers.onSave()),
        btn('这次不存', 'b', () => this.handlers.onSkip('once'))
      )
      out.push(acts)
    } else {
      out.push(node('div', { class: 't' }, '招聘捕手工作中'))
      out.push(
        node(
          'div',
          { class: 'sub' },
          view.mode === 'auto'
            ? '本页还没识别到简历。点开某位候选人的在线简历后会自动保存。'
            : '本页还没识别到简历。点开某位候选人的在线简历后会来问你。'
        )
      )
    }

    if (view.feedback) {
      out.push(node('div', { class: `fb ${view.feedback.kind}` }, view.feedback.text))
    }

    // 方案 C：用户选了岗，但规则原本推荐的是另一个 → 如实告知 + 给一个「也挂上」。
    // 默认只留用户选的那个（漏斗不被污染），但信息不能丢。
    const sug = view.ruleSuggested
    if (sug && !view.asking) {
      const row = node('div', { class: 'sug' })
      row.append(
        node('span', { class: 'sug-t' }, `规则原本推荐「${sug.title}」（${sug.score} 分）`)
      )
      row.append(
        btn('也挂上', 'b', () => this.handlers.onAttachSuggested?.(sug.positionId))
      )
      out.push(row)
    }

    return out
  }
}

// ---------------------------------------------------------------- DOM 小工具

function node(tag: string, attrs: Record<string, string> = {}, ...children: Array<Node | string>): HTMLElement {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  for (const c of children) el.append(typeof c === 'string' ? document.createTextNode(c) : c)
  return el
}

function btn(text: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = cls
  b.textContent = text
  b.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    onClick()
  })
  return b
}
