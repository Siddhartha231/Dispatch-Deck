import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyze } from '../src/domain/analysis.ts'
import { initial, score, transition, type Command, type Run } from '../src/domain/engine.ts'
import { forkFrame, forkRun, forkTitle } from '../src/domain/fork.ts'
import { RunSchema } from '../src/domain/protocol.ts'

const send = (truck: string, to: string, qty: number): Command => ({
  type: 'dispatch',
  truck,
  to,
  qty,
})

/** Plays a script from a first board, recording every frame like SimulationRoom does. */
function play(first: Run, script: (s: Run) => Command[]): Run[] {
  let s = first
  const frames = [s]
  const apply = (cmd: Command, role: 'commander' | 'dispatcher') => {
    s = transition(s, cmd, role, 'Crew')
    frames.push(s)
  }
  if (s.phase === 'lobby') apply({ type: 'start' }, 'commander')
  while (s.phase === 'running') {
    for (const cmd of script(s)) apply(cmd, 'dispatcher')
    apply({ type: 'advance' }, 'commander')
  }
  return frames
}

/** T-04 sends a small load on turn 0, then nothing else happens. */
const original = play(initial('src', 'Drill'), (s) =>
  s.tick === 0 ? [send('T-04', 'school', 20)] : [],
)
const origin = { id: 'src', turn: 0 }

test('the default fork point is the last running board of that turn', () => {
  const frame = forkFrame(original, 0)
  assert.ok(frame.ok)
  assert.equal(frame.value.tick, 0)
  assert.equal(frame.value.phase, 'running')
  assert.equal(frame.value.shipments.length, 1, 'turn 0 dispatches are already made')
  assert.equal(frame.value.fleet.find((v) => v.id === 'T-04')?.status, 'outbound')
})

test('forking just before a shipment makes the alternative playable', () => {
  const frame = forkFrame(original, 0, 'S-01')
  assert.ok(frame.ok)
  assert.equal(frame.value.shipments.length, 0)
  const fork = forkRun(frame.value, 'new', 'Drill: what-if from turn 0', 'Kim', origin)
  // T-04 can now take a fuller load than the 20 units the original sent.
  const full = transition(fork, send('T-04', 'harbor', 35), 'dispatcher', 'Kim')
  assert.equal(full.shipments[0].qty, 35)
  assert.equal(full.sites.find((n) => n.id === 'east')?.stock, 5)
})

test('a fork is a valid board with its own id and a version-0 history', () => {
  const frame = forkFrame(original, 3)
  assert.ok(frame.ok)
  const fork = forkRun(frame.value, 'new', 'Drill: what-if from turn 3', 'Kim', {
    id: 'src',
    turn: 3,
  })
  assert.equal(RunSchema.safeParse(fork).success, true)
  assert.equal(fork.id, 'new')
  assert.equal(fork.version, 0)
  assert.equal(fork.tick, 3)
  assert.equal(fork.phase, 'running')
  assert.equal(fork.log.at(-1)?.kind, 'system')
  assert.match(fork.log.at(-1)!.text, /What-if started from turn 3/)
  assert.equal(fork.log.at(-1)!.seq, frame.value.log.length + 1)
  assert.equal(frame.value.id, 'src', 'the source board is not modified')
  assert.equal(frame.value.version > 0, true)
})

test('disruptions after the fork point still fire on their turns', () => {
  const frame = forkFrame(original, 1)
  assert.ok(frame.ok)
  let s = forkRun(frame.value, 'new', 'x', 'Kim', { id: 'src', turn: 1 })
  assert.equal(s.roads.find((r) => r.id === 'east-corridor')?.blocked, false)
  s = transition(s, { type: 'advance' }, 'commander', 'Kim')
  assert.equal(s.tick, 2)
  assert.equal(s.roads.find((r) => r.id === 'east-corridor')?.blocked, true)
  while (s.tick < 4) s = transition(s, { type: 'advance' }, 'commander', 'Kim')
  assert.ok(s.log.some((e) => /Flooding at East Hub/.test(e.text)))
  while (s.tick < 6) s = transition(s, { type: 'advance' }, 'commander', 'Kim')
  assert.equal(s.sites.find((n) => n.id === 'city')?.demand, 40)
  while (s.phase === 'running') s = transition(s, { type: 'advance' }, 'commander', 'Kim')
  assert.equal(s.tick, 12, 'the deadline is still turn 12')
})

test('a fork after the flood does not fire it twice', () => {
  const frame = forkFrame(original, 5)
  assert.ok(frame.ok)
  const east = frame.value.sites.find((n) => n.id === 'east')!.stock
  let s = forkRun(frame.value, 'new', 'x', 'Kim', { id: 'src', turn: 5 })
  while (s.phase === 'running') s = transition(s, { type: 'advance' }, 'commander', 'Kim')
  assert.equal(s.sites.find((n) => n.id === 'east')!.stock, east)
})

test('replaying commands on a fork scores and analyzes its own history', () => {
  const frame = forkFrame(original, 0, 'S-01')
  assert.ok(frame.ok)
  const first = forkRun(frame.value, 'new', 'Drill: what-if from turn 0', 'Kim', origin)
  const history = play(first, (s) => (s.tick === 0 ? [send('T-04', 'harbor', 35)] : []))
  assert.deepEqual(
    history.map((f) => f.version),
    history.map((_, i) => i),
    'frame numbers equal versions',
  )
  const final = history.at(-1)!
  assert.equal(final.phase, 'completed')
  assert.equal(score(final).delivered, 35)
  assert.ok(score(final).delivered > score(original.at(-1)!).delivered)

  const facts = analyze(history)
  assert.equal(facts.title, 'Drill: what-if from turn 0')
  assert.equal(facts.score.delivered, 35)
  assert.equal(facts.floodLoss, 5, 'East Hub kept 5 units for the flood')
  assert.ok(facts.floodReview)
})

test('analysis copes with histories that start after turn 4', () => {
  const frame = forkFrame(original, 6)
  assert.ok(frame.ok)
  const first = forkRun(frame.value, 'new', 'late', 'Kim', { id: 'src', turn: 6 })
  const history = play(first, (s) => (s.tick === 6 ? [send('T-03', 'valley', 30)] : []))
  const facts = analyze(history)
  assert.equal(facts.floodLoss, 0, 'the flood happened before this history began')
  assert.equal(facts.floodReview, undefined)
  // 20 units were already delivered before the fork, and carry over.
  assert.equal(facts.score.delivered, 50)
  assert.ok(facts.idleTrucks.every((t) => t.turns.every((turn) => turn >= 6)))
})

test('forks are refused where there is nothing to play', () => {
  assert.deepEqual(forkFrame(original.slice(0, 3), 0), {
    ok: false,
    status: 409,
    error: 'Only a completed operation can be forked.',
  })
  const closed = forkFrame(original, 12)
  assert.ok(!closed.ok && closed.status === 422)
  const unknown = forkFrame(original, 0, 'S-09')
  assert.ok(!unknown.ok && unknown.status === 422)
  // A run closed early can still be forked from the board before it closed.
  let e = transition(initial('e', 'Early'), { type: 'start' }, 'commander', 'Crew')
  const early = [e]
  for (const cmd of [{ type: 'advance' }, { type: 'advance' }, { type: 'finish' }] as const)
    early.push((e = transition(e, cmd, 'commander', 'Crew')))
  const atClose = forkFrame(early, 2)
  assert.ok(atClose.ok && atClose.value.phase === 'running')
})

test('fork titles stay within the run-title limit', () => {
  assert.equal(forkTitle('Drill', 4), 'Drill — what-if from turn 4')
  const long = forkTitle('x'.repeat(56), 10)
  assert.ok(long.length <= 56)
  assert.ok(long.endsWith(' — what-if from turn 10'))
})
