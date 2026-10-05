import { useCallback, useEffect, useState } from 'react'
import type { AskAnswer } from '@ria/shared'
import { askQuestion } from '../api'
import { CandidateCard } from '../components/CandidateCard'

/**
 * 智能问答（#/qa）
 * 当前是规则引擎：先把问句解析成检索条件，再查库，最后拼出人话结论。
 * 好处是结果一定来自真实数据；接上大模型后解析与成文交给模型，检索这一层不变。
 */
export function QaPage({
  initialQuestion,
  onOpenCandidate,
}: {
  initialQuestion?: string
  onOpenCandidate: (candidateId: string) => void
}) {
  const [input, setInput] = useState(initialQuestion ?? '')
  const [data, setData] = useState<AskAnswer | null>(null)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async (q: string) => {
    setLoading(true)
    setError(null)
    setInput(q)
    try {
      const res = await askQuestion(q)
      setData(res)
      if (res.suggestions.length) setSuggestions(res.suggestions)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  // 首次进入：先拿一组「猜你想问」；带 ?q= 进来则直接问
  useEffect(() => {
    const hasQuery = input.trim().length > 0
    if (hasQuery) void run(input)
    else
      askQuestion('')
        .then((res) => setSuggestions(res.suggestions))
        .catch(() => undefined)
    // 只在挂载 / 带参变化时执行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuestion])

  const asked = Boolean(data?.question)

  return (
    <>
      <div className="page-head">
        <div>
          <h2>智能问答</h2>
          <p className="muted">
            直接问人话。会先解析出岗位 / 城市 / 学历 / 进度 / 分数等条件，再回库检索。
          </p>
        </div>
      </div>

      <form
        className="qa-box"
        onSubmit={(e) => {
          e.preventDefault()
          if (input.trim()) void run(input.trim())
        }}
      >
        <input
          className="qa-input"
          type="search"
          placeholder="比如：视觉算法岗 85 分以上有哪些人？"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button className="btn-primary" type="submit" disabled={loading || !input.trim()}>
          {loading ? '检索中…' : '提问'}
        </button>
      </form>

      {suggestions.length > 0 && (
        <div className="qa-suggest">
          <span className="qa-suggest-label">猜你想问：</span>
          {suggestions.map((s) => (
            <button key={s} type="button" className="chip-btn" onClick={() => void run(s)}>
              {s}
            </button>
          ))}
        </div>
      )}

      {error && <div className="notice notice-bad">查询失败：{error}</div>}

      {asked && data && (
        <section className="qa-answer">
          <div className="qa-question">{data.question}</div>

          {data.filterLabels.length > 0 ? (
            <div className="qa-parse">
              <span className="qa-parse-label">解析为</span>
              {data.filterLabels.map((l) => (
                <span className="qa-tag" key={l}>
                  {l}
                </span>
              ))}
            </div>
          ) : (
            <div className="qa-parse">
              <span className="qa-tag qa-tag-warn">没解析出条件，按关键词检索</span>
            </div>
          )}

          <div className="qa-text">
            {data.answer.split('\n').map((line, i) => (
              <p key={i}>{line}</p>
            ))}
          </div>

          <div className="qa-engine">引擎：{data.engine}</div>
        </section>
      )}

      {asked && data && data.candidates.length > 0 && (
        <section className="list" style={{ marginTop: 16 }}>
          <div className="list-hd">
            <span>命中候选人</span>
            <span className="muted">
              显示 {data.candidates.length} / {data.total} 人
            </span>
          </div>
          <div className="cards">
            {data.candidates.map((r) => (
              <CandidateCard
                key={r.candidate.id}
                row={r}
                active={false}
                onClick={() => onOpenCandidate(r.candidate.id)}
              />
            ))}
          </div>
        </section>
      )}
    </>
  )
}
