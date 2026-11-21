import { useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'
import type { DebriefFacts, DebriefResponse } from '../../domain/protocol.ts'
import { deck, message } from '../api'
import type { ForkAction } from './Fork'

/** "0, 1, 2, 5" → "0–2, 5". */
function ranges(turns: number[]) {
  const parts: string[] = []
  for (let i = 0; i < turns.length; i++) {
    let j = i
    while (j + 1 < turns.length && turns[j + 1] === turns[j] + 1) j++
    parts.push(i === j ? String(turns[i]) : `${turns[i]}–${turns[j]}`)
    i = j
  }
  return parts.join(', ')
}

/** One finding; `fork` is the replay point where its suggested alternative can be played. */
type Finding = { text: string; fork?: { turn: number; before?: string } }

/** The deterministic findings, written as plain sentences. */
function findings(f: DebriefFacts) {
  const lines: Finding[] = []
  for (const t of f.idleTrucks) {
    const m = t.firstMove
    lines.push({
      text:
        `${t.truck} sat at ${t.depot} with stock and reachable demand on turn${t.turns.length > 1 ? 's' : ''} ${ranges(t.turns)}` +
        (m
          ? ` (on turn ${m.turn} it could have taken ${m.qty} units to ${m.to}, arriving turn ${m.arrival}).`
          : '.'),
      fork: m ? { turn: m.turn } : undefined,
    })
  }
  for (const s of f.inTransitAtClose)
    lines.push({
      text: `${s.truck} was still carrying ${s.qty} units to ${s.to} (due turn ${s.arrival}).`,
    })
  for (const r of f.rerouted)
    lines.push({
      text: `${r.truck}'s trip to ${r.to} took ${r.extraTurns} extra turn${r.extraTurns > 1 ? 's' : ''} after the closure.`,
    })
  if (f.floodLoss) {
    lines.push({
      text: `The flood destroyed ${f.floodLoss} units still at ${f.floodReview?.depot ?? 'East Hub'}.`,
    })
    const r = f.floodReview
    if (r && !r.avoidable) lines.push({ text: r.reason ?? 'The flood loss was unavoidable.' })
    if (r?.avoidable)
      for (const o of r.options)
        lines.push({
          text: o.instead
            ? `On turn ${o.turn}, ${o.truck} could have carried ${o.qty} units to ${o.to} instead of ${o.instead}, keeping ${o.saves} units out of the flood.`
            : `On turn ${o.turn}, ${o.truck} could have taken ${o.qty} units from ${o.from} to ${o.to}, keeping ${o.saves} units out of the flood.`,
          // A fuller load replaces a shipment, so restart just before that shipment left.
          fork: { turn: o.turn, before: o.instead ?? undefined },
        })
  }
  for (const s of f.sites.filter((s) => s.priority === 'critical' && s.unmet > 0))
    lines.push({ text: `${s.name} (critical) ended ${s.unmet} units short.` })
  return lines
}

export function DebriefPanel({ id, fork }: { id: string; fork?: ForkAction }) {
  const [debrief, setDebrief] = useState<DebriefResponse | null>(null)
  const [writing, setWriting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    deck
      .debrief(id)
      .then((d) => active && setDebrief(d))
      .catch((e) => active && setError(message(e)))
    return () => {
      active = false
    }
  }, [id])

  async function write() {
    setWriting(true)
    setError('')
    try {
      setDebrief(await deck.writeDebrief(id))
    } catch (e) {
      setError(message(e))
    } finally {
      setWriting(false)
    }
  }

  if (!debrief)
    return (
      <section className="panel debrief">
        <p role="status">{error || 'Analyzing the run…'}</p>
      </section>
    )

  const facts = findings(debrief.facts)
  const n = debrief.narrative
  return (
    <section className="panel debrief" aria-labelledby="debrief-title">
      <div className="panel-head">
        <h2 id="debrief-title">
          <Sparkles />
          After-action debrief
        </h2>
        <span className="mono">
          {debrief.facts.score.rate}% · TARGET {debrief.facts.target}%
        </span>
      </div>

      <h3>What the replay shows</h3>
      {facts.length ? (
        <ul>
          {facts.map((line) => (
            <li key={line.text}>
              {line.text}
              {fork && line.fork && (
                <button
                  className="text-btn"
                  disabled={fork.busy}
                  onClick={() => fork.fork(line.fork!.turn, line.fork!.before)}
                >
                  Try this
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p>No idle trucks, stranded cargo, reroute delays or flood losses.</p>
      )}

      {n ? (
        <div className="narrative">
          <p className="headline">{n.headline}</p>
          {(
            [
              ['What went well', n.wentWell],
              ['What cost us', n.costUs],
              ['Next time', n.nextTime],
            ] as const
          ).map(
            ([title, items]) =>
              items.length > 0 && (
                <div key={title}>
                  <h3>{title}</h3>
                  <ul>
                    {items.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ),
          )}
          <small>Written by {debrief.model} from the findings above.</small>
        </div>
      ) : debrief.canGenerate ? (
        <button className="primary" disabled={writing} onClick={write}>
          <Sparkles size={16} />
          {writing ? 'Writing the debrief…' : 'Write the AI debrief'}
        </button>
      ) : (
        <p className="crew">{debrief.note}</p>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
