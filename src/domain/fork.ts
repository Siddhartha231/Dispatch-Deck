/**
 * What-if forks. A completed run's replay is a list of exact boards, so a fork
 * is just one of those boards restarted as a new run: the engine is pure, so
 * play continues from it with the same rules, and disruptions still fire on
 * their scheduled turns because they key off `tick`, which the board carries.
 * No platform imports.
 */
import type { ForkOrigin, Result, Run } from './protocol.ts'

const TITLE_MAX = 56

const fail = (status: number, error: string): Result<never> => ({ ok: false, status, error })

/**
 * The board to fork from. By default the last running board of `turn`: the
 * commander has made that turn's dispatches but not advanced the clock yet,
 * which is the board the analysis reasons about. With `before`, the board just
 * before that shipment was dispatched, so "send a fuller load instead" is
 * playable even when every truck was out by the end of the turn.
 */
export function forkFrame(history: Run[], turn: number, before?: string): Result<Run> {
  if (history.at(-1)?.phase !== 'completed')
    return fail(409, 'Only a completed operation can be forked.')
  let at = -1
  if (before) {
    const first = history.findIndex((f) => f.shipments.some((x) => x.id === before))
    if (first < 1) return fail(422, 'That shipment is not part of this replay.')
    at = first - 1
  } else {
    for (let i = history.length - 1; i >= 0; i--)
      if (history[i].tick === turn && history[i].phase === 'running') {
        at = i
        break
      }
  }
  const frame = history[at]
  if (!frame || frame.phase !== 'running' || frame.tick !== turn)
    return fail(422, `Turn ${turn} has no moment to play again in this replay.`)
  return { ok: true, value: frame }
}

/** "<title> — what-if from turn N", shortened to fit the run-title limit. */
export function forkTitle(title: string, turn: number) {
  const suffix = ` — what-if from turn ${turn}`
  const room = TITLE_MAX - suffix.length
  return (title.length > room ? title.slice(0, room - 1).trimEnd() + '…' : title) + suffix
}

/**
 * The first board of the fork. It gets its own id and starts its replay at
 * version 0 (so frame numbers and versions agree, as in a fresh run); every
 * command's version check then works against the fork's own history. The log
 * is kept so the story so far stays readable, with a note that marks the fork.
 */
export function forkRun(
  frame: Run,
  id: string,
  title: string,
  actor: string,
  origin: ForkOrigin,
): Run {
  const s = structuredClone(frame)
  s.id = id
  s.title = title
  s.version = 0
  s.log.push({
    seq: s.log.length + 1,
    tick: s.tick,
    kind: 'system',
    text: `What-if started from turn ${origin.turn} of "${frame.title}".`,
    actor,
  })
  return s
}
