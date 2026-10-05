import { useEffect, useState } from 'react'
import type { ApplicationStatus, CandidateDetail, MatchAssignedBy } from '@ria/shared'
import { PLATFORM_LABEL, STATUS_COLOR, STATUS_LABEL, STATUS_ORDER } from '@ria/shared'
import { PlatformTag, ScoreBadge, StatusTag } from './Badges'
import {
  deleteCandidate,
  loadPrintOptions,
  printUrl,
  savePrintOptions,
  type PrintOptions,
} from '../api'

/**
 * 岗位归属是「谁定的」。
 * 老数据没有 assignedBy，一律不显示 —— 没有值就是没有值，不猜。
 */
const ASSIGNED_BY_TEXT: Record<MatchAssignedBy, string> = {
  manual: '手动指定',
  'pick-from-recommend': '按平台推荐',
  rule: '自动匹配',
  model: '模型判定',
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function CandidateDrawer({
  detail,
  loading,
  error,
  onClose,
  onStatusChange,
  onDeleted,
}: {
  detail: CandidateDetail | null
  loading: boolean
  error: string | null
  onClose: () => void
  onStatusChange: (positionId: string, status: ApplicationStatus) => void
  /**
   * 删除成功后的刷新回调。刻意给默认值：
   * 老调用方（比如冒烟测试）不传它也照样渲染，不会因此挂掉。
   */
  onDeleted?: () => void
}) {
  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="drawer-mask" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        {loading && <div className="drawer-loading">载入中…</div>}
        {error && <div className="drawer-loading err">{error}</div>}
        {detail && (
          <DrawerBody
            detail={detail}
            onClose={onClose}
            onStatusChange={onStatusChange}
            onDeleted={onDeleted}
          />
        )}
      </div>
    </div>
  )
}

function DrawerBody({
  detail,
  onClose,
  onStatusChange,
  onDeleted,
}: {
  detail: CandidateDetail
  onClose: () => void
  onStatusChange: (positionId: string, status: ApplicationStatus) => void
  onDeleted?: () => void
}) {
  const { candidate: c, matches, sources } = detail
  const [showResume, setShowResume] = useState(false)
  const [showExport, setShowExport] = useState(false)
  // 记住上次的导出选项 —— 每次都要重勾很烦
  const [printOpts, setPrintOpts] = useState<PrintOptions>(() => loadPrintOptions())
  const best = matches[0]

  /** 删除确认条上「有值才显示」的那行上下文：职位 · 公司 · 城市 */
  const where = [c.currentTitle, c.currentCompany, c.city].filter(Boolean).join(' · ')

  // ---- 删除 ----
  const [showDelete, setShowDelete] = useState(false)
  // 单个删除时默认勾上「不再采集此人」：删掉的多半是不想再看到的人，
  // 顺手设成不再采集才不会下次采集又被塞回来。（批量那边刻意相反）
  const [forget, setForget] = useState(true)
  const [delBusy, setDelBusy] = useState(false)
  const [delErr, setDelErr] = useState<string | null>(null)

  const handleDelete = async () => {
    setDelBusy(true)
    setDelErr(null)
    try {
      await deleteCandidate(c.id, forget)
      onClose()
      onDeleted?.()
    } catch (e) {
      setDelErr((e as Error).message)
    } finally {
      setDelBusy(false)
    }
  }

  /** [标签, 值, 悬浮提示?, 语气?] —— 语气 warn 用于「非统招」这类要一眼看到的信息 */
  const info: Array<[string, string | undefined, string?, 'warn'?]> = [
    ['性别 / 年龄', [c.gender === 'M' ? '男' : c.gender === 'F' ? '女' : undefined, c.age ? `${c.age} 岁` : undefined].filter(Boolean).join(' / ') || undefined],
    ['所在城市', c.city],
    ['学历', c.degree],
    // 学历性质 —— 招聘软件普遍识别不了，这里抓到了就必须显示出来。
    // 原文依据放 title 里：判错了 HR 能一眼看出「是原文这么写的」。
    [
      '学历性质',
      c.educationMode,
      c.educationEvidence ? `原文：${c.educationEvidence}` : '未在简历中找到统招/全日制等字样',
      c.educationMode === '非统招' ? 'warn' : undefined,
    ],
    [
      '毕业院校',
      c.school ? `${c.school}${c.schoolTier ? ` · ${c.schoolTier}` : ''}` : undefined,
    ],
    ['专业', c.major],
    ['工作年限', c.yearsOfExperience !== undefined ? `${c.yearsOfExperience} 年` : undefined],
    ['当前公司', c.currentCompany],
    ['当前职位', c.currentTitle],
    ['期望薪资', c.expectedSalary],
    ['求职意向', c.intention],
    // 平台自己推荐的职位（猎聘头部的「推荐职位：X」）—— 帮 HR 判断该挂哪个岗
    ['平台推荐职位', c.recommendedPosition],
    ['手机', c.phone],
    ['邮箱', c.email],
    ['首次入库', fmtTime(c.createdAt)],
    ['最近更新', fmtTime(c.updatedAt)],
  ]

  return (
    <>
      <header className="drawer-hd">
        <div>
          <h2>{c.name}</h2>
          <div className="drawer-sub">
            {c.currentCompany ? `${c.currentCompany}${c.currentTitle ? ' · ' + c.currentTitle : ''}` : '公司 / 职位待解析'}
          </div>
        </div>
        <div className="drawer-hd-right">
          <ScoreBadge score={best?.score} />
          <button
            className="btn-inline"
            onClick={() => setShowExport((v) => !v)}
            title="把这份简历排成 PDF，交给业务部门"
          >
            导出 PDF
          </button>
          {/* 删除是次要但危险的操作：给它一个偏红的次要样式，不用实心红抢注意力 */}
          <button
            className="btn-inline btn-danger"
            onClick={() => {
              setDelErr(null)
              setShowDelete((v) => !v)
            }}
            title="从库里删掉这份简历"
          >
            删除
          </button>
          <button className="btn-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
      </header>

      {showExport && (
        <div className="export-bar">
          <div className="export-title">
            导出 PDF —— 在浏览器打印对话框里选「另存为 PDF」
          </div>
          <div className="export-opts">
            <label>
              <input
                type="checkbox"
                checked={printOpts.score !== false}
                onChange={(e) => setPrintOpts({ ...printOpts, score: e.target.checked })}
              />
              匹配度与命中点
            </label>
            <label>
              <input
                type="checkbox"
                checked={printOpts.source !== false}
                onChange={(e) => setPrintOpts({ ...printOpts, source: e.target.checked })}
              />
              来源与采集时间
            </label>
            <label>
              <input
                type="checkbox"
                checked={printOpts.raw !== false}
                onChange={(e) => setPrintOpts({ ...printOpts, raw: e.target.checked })}
              />
              附未结构化原文
            </label>
          </div>
          <div className="export-acts">
            <select
              value={printOpts.positionId ?? best?.positionId ?? ''}
              onChange={(e) => setPrintOpts({ ...printOpts, positionId: e.target.value || undefined })}
            >
              <option value="">应聘岗位：按分数最高的那个</option>
              {matches.map((m) => (
                <option key={m.positionId} value={m.positionId}>
                  {m.positionTitle}
                </option>
              ))}
            </select>
            <button
              className="btn-primary"
              onClick={() => {
                savePrintOptions(printOpts)
                window.open(printUrl(c.id, printOpts), '_blank')
              }}
            >
              生成并打开
            </button>
          </div>
        </div>
      )}

      {/* 删除确认条：照 export-bar 的模式就地展开，不用 window.confirm ——
          因为要在确认的同时勾「不再采集此人」，还得先把「删的是谁」摆清楚。 */}
      {showDelete && (
        <div className="export-bar del-bar">
          <div className="export-title">删除这份简历？</div>

          <div className="del-who">
            <div>{where || c.name}</div>
            {/* 进度挂在「候选人 × 岗位」上，不挂在候选人身上 —— 取分数最高的那个匹配的进度 */}
            {best && <div>当前进度：{STATUS_LABEL[best.status]}</div>}
            {matches.length > 0 && (
              <div>关联岗位：{matches.map((m) => m.positionTitle).join('、')}</div>
            )}
          </div>

          {delErr && <div className="notice notice-bad">{delErr}</div>}

          <div className="export-opts">
            <label>
              <input
                type="checkbox"
                checked={forget}
                onChange={(e) => setForget(e.target.checked)}
              />
              同时设为「不再采集此人」（推荐）
            </label>
          </div>
          <div className="del-hint">勾了之后，即使以后又打开他的简历，扩展也不会再存进来。</div>

          <div className="export-acts">
            <button
              className="btn-inline btn-danger-solid"
              disabled={delBusy}
              onClick={() => void handleDelete()}
            >
              {delBusy ? '删除中…' : '确认删除'}
            </button>
            <button
              className="btn-ghost btn-inline"
              disabled={delBusy}
              onClick={() => {
                setShowDelete(false)
                setDelErr(null)
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}

      <div className="drawer-body">
        {c.parseState === 'raw' && (
          <div className="notice">
            这份简历是采集原文，尚未经过大模型结构化，字段由规则粗提取，可能有遗漏。
          </div>
        )}

        <section className="sec">
          <h3>基本信息</h3>
          <div className="kv">
            {info
              .filter(([, v]) => v)
              .map(([k, v, hint, tone]) => (
                <div className="kv-item" key={k}>
                  <span className="kv-k">{k}</span>
                  <span className={`kv-v${tone ? ` kv-${tone}` : ''}`} title={hint}>
                    {v}
                  </span>
                </div>
              ))}
          </div>
        </section>

        {c.skills.length > 0 && (
          <section className="sec">
            <h3>技能标签</h3>
            <div className="chips">
              {c.skills.map((s) => (
                <span className="chip" key={s}>
                  {s}
                </span>
              ))}
            </div>
          </section>
        )}

        {c.summary && (
          <section className="sec">
            <h3>模型摘要</h3>
            <p className="para">{c.summary}</p>
          </section>
        )}

        <section className="sec">
          <h3>岗位匹配（{matches.length}）</h3>
          {matches.map((m) => (
            <div className="match" key={m.id}>
              <div className="match-hd">
                <b>{m.positionTitle}</b>
                <span className="match-score">{m.score} 分</span>
              </div>

              <div className="match-row">
                <span className="match-label">推进进度</span>
                <select
                  value={m.status}
                  onChange={(e) => onStatusChange(m.positionId, e.target.value as ApplicationStatus)}
                >
                  {STATUS_ORDER.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </option>
                  ))}
                </select>
                <span
                  className="tag"
                  style={{ background: STATUS_COLOR[m.status].bg, color: STATUS_COLOR[m.status].fg }}
                >
                  当前：{STATUS_LABEL[m.status]}
                </span>
                {m.assignedBy && (
                  <span className="muted">· {ASSIGNED_BY_TEXT[m.assignedBy]}</span>
                )}
                {m.note && <span className="muted">{m.note}</span>}
              </div>

              {m.hitPoints.length > 0 && (
                <ul className="pts pts-hit">
                  {m.hitPoints.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              )}
              {m.missPoints.length > 0 && (
                <ul className="pts pts-miss">
                  {m.missPoints.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </section>

        <section className="sec">
          <h3>来源与留痕（{sources.length}）</h3>
          {sources.map((s) => (
            <div className="src" key={s.id}>
              <div className="src-top">
                <PlatformTag platform={s.platform} />
                <span className="muted">{PLATFORM_LABEL[s.platform]}</span>
                <span className="muted">采集于 {fmtTime(s.capturedAt)}</span>
                {/* 老数据没有这个字段，一律按自动采集显示 —— 区分「机器采的」和「我手动存的」 */}
                <span className="muted">
                  {s.captureMethod === 'manual' ? '手动保存' : '自动采集'}
                </span>
                {s.lowConfidence && <span className="tag tag-warn">置信度低</span>}
              </div>
              <div className="src-id">平台内 ID：{s.platformCandidateId}</div>
              {s.resumeUrl && (
                <a className="src-link" href={s.resumeUrl} target="_blank" rel="noreferrer">
                  打开原始简历页 ↗
                </a>
              )}
            </div>
          ))}
        </section>

        {c.resumeText && (
          <section className="sec">
            <h3>
              简历原文
              <button className="btn-ghost btn-inline" onClick={() => setShowResume((v) => !v)}>
                {showResume ? '收起' : '展开'}
              </button>
            </h3>
            {showResume && <pre className="resume">{c.resumeText}</pre>}
          </section>
        )}
      </div>
    </>
  )
}
