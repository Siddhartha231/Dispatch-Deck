import { useEffect, useRef, useState } from 'react'
import { GitFork } from 'lucide-react'
import { score } from '../../domain/engine'
import type { ForkOrigin, Run } from '../../domain/protocol.ts'
import { deck, message } from '../api'

/**
 * Starts what-ifs from this run's replay. Each distinct fork point keeps its own
 * new run id until the page is left, so a retried click (after a dropped
 * response, say) lands on the run that may already exist instead of making a
 * second one.
 */
export function useFork(sourceId: string) {
  const ids = useRef(new Map<string, string>())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function fork(turn: number, before?: string) {
    if (busy) return
    const point = `${turn}:${before ?? ''}`
    const id = ids.current.get(point) ?? crypto.randomUUID()
    ids.current.set(point, id)
    setBusy(true)
    setError('')
    try {
      const created = await deck.fork(sourceId, { id, turn, ...(before && { before }) })
      location.assign('/runs/' + created.id)
    } catch (e) {
      setError(message(e))
      setBusy(false)
    }
  }
  return { fork, busy, error }
}

export type ForkAction = { fork: (turn: number, before?: string) => void; busy: boolean }

/** Fork button tied to the replay slider's current turn. */
export function ForkBar({
  turn,
  playable,
  action,
  error,
}: {
  turn: number
  playable: boolean
  action: ForkAction
  error: string
}) {
  return (
    <section className="panel fork-bar">
      <p>
        {playable
          ? `Start from the board at the end of turn ${turn}, before the clock advances, and play it again as a new operation you command.`
          : 'This frame has no turn left to play. Scrub to an earlier turn to try something different.'}
      </p>
      <button
        className="secondary"
        disabled={!playable || action.busy}
        onClick={() => action.fork(turn)}
      >
        <GitFork size={16} />
        {action.busy ? 'Starting…' : `Play a what-if from turn ${turn}`}
      </button>
      {error && <p role="alert">{error}</p>}
    </section>
  )
}

/** The original run, read when this run is a what-if of it. */
function useOrigin(origin: ForkOrigin | null) {
  const [run, setRun] = useState<Run | null>(null)
  useEffect(() => {
    if (!origin) return
    let active = true
    deck
      .state(origin.id)
      .then((r) => active && setRun(r.state))
      .catch(() => {})
    return () => {
      active = false
    }
  }, [origin])
  return run
}

/** "What-if of <title> from turn N", with a link back to the original's report. */
export function ForkBanner({ origin }: { origin: ForkOrigin }) {
  const original = useOrigin(origin)
  return (
    <p className="fork-banner">
      <GitFork size={15} />
      What-if of{' '}
      <a href={'/runs/' + origin.id + '/report'}>{original?.title ?? 'the original run'}</a> from
      turn {origin.turn}
    </p>
  )
}

/** The original's final score beside this what-if's, once both runs are over. */
export function ScoreCompare({ origin, fork }: { origin: ForkOrigin; fork: Run }) {
  const original = useOrigin(origin)
  if (!original || original.phase !== 'completed' || fork.phase !== 'completed') return null
  const rows = [
    ['Original run', score(original)],
    ['This what-if', score(fork)],
  ] as const
  const diff = score(fork).rate - score(original).rate
  return (
    <section className="panel score-compare" aria-label="Original and what-if scores">
      {rows.map(([label, s]) => (
        <div key={label}>
          <span>{label}</span>
          <b>{s.rate}% delivered</b>
          <small>
            {s.delivered} of {s.demand} units · {s.weighted}% priority-weighted
          </small>
        </div>
      ))}
      <p>
        {diff === 0
          ? 'Same delivery rate as the original.'
          : `${Math.abs(diff)} points ${diff > 0 ? 'better' : 'worse'} than the original.`}
      </p>
    </section>
  )
}
