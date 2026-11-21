import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyze } from '../src/domain/analysis.ts'
import { initial, transition, type Command, type Run } from '../src/domain/engine.ts'
import { DebriefFactsSchema } from '../src/domain/protocol.ts'

/** Records every frame, the way SimulationRoom stores one row per version. */
function play(script: (turn: number) => Command[]): Run[] {
  let s = initial('a', 'Analysis drill')
  const frames = [s]
  const apply = (cmd: Command, role: 'commander' | 'dispatcher') => {
    s = transition(s, cmd, role, 'Crew')
    frames.push(s)
  }
  apply({ type: 'start' }, 'commander')
  while (s.phase === 'running') {
    for (const cmd of script(s.tick)) apply(cmd, 'dispatcher')
    apply({ type: 'advance' }, 'commander')
  }
  return frames
}
const send = (truck: string, to: string, qty: number): Command => ({
  type: 'dispatch',
  truck,
  to,
  qty,
})

test('idle trucks, flood loss and the first dispatch are found', () => {
  const facts = analyze(play((turn) => (turn === 0 ? [send('T-01', 'harbor', 25)] : [])))
  assert.equal(facts.firstDispatchTurn, 0)
  assert.equal(facts.score.delivered, 25)
  // T-02 shares North Hub's stock and never moved, with work available all game.
  assert.deepEqual(
    facts.idleTrucks.find((t) => t.truck === 'T-02')?.turns,
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  )
  // East Hub still held all 40 units when the flood hit, so it lost the full 10.
  assert.equal(facts.floodLoss, 10)
  assert.deepEqual(facts.inTransitAtClose, [])
  assert.deepEqual(facts.rerouted, [])
})

test('a shipment slowed by the corridor closure is reported with its delay', () => {
  const facts = analyze(play((turn) => (turn === 2 ? [send('T-04', 'hill', 25)] : [])))
  // East Hub to Hill Hospital is 1 turn on the open network and 4 after the closure.
  assert.deepEqual(facts.rerouted, [
    { shipment: 'S-01', truck: 'T-04', to: 'Hill Hospital', extraTurns: 3 },
  ])
})

test('cargo still on the road at the deadline is reported', () => {
  const facts = analyze(play((turn) => (turn === 11 ? [send('T-02', 'city', 20)] : [])))
  assert.deepEqual(facts.inTransitAtClose, [
    { shipment: 'S-01', truck: 'T-02', to: 'City Center', qty: 20, arrival: 13 },
  ])
})

test('stock moved out of East Hub before turn 4 escapes the flood', () => {
  // Turn 0: T-04 takes 25 of East Hub's 40 to Hill Hospital (1 turn there, 1 back).
  // Turn 2: it takes the remaining 15 to the School Relief Center, leaving nothing to flood.
  const facts = analyze(
    play((turn) =>
      turn === 0 ? [send('T-04', 'hill', 25)] : turn === 2 ? [send('T-04', 'school', 15)] : [],
    ),
  )
  assert.equal(facts.floodLoss, 0)
  assert.equal(facts.score.delivered, 40)
})

test('staging scenario: nothing could move East Hub stock on turns 2-3', () => {
  // T-04 leaves on turn 1, is on the road through turn 3 and is home only after the flood.
  const facts = analyze(play((turn) => (turn === 1 ? [send('T-04', 'hill', 20)] : [])))
  assert.equal(facts.floodLoss, 10)
  const review = facts.floodReview!
  assert.equal(review.avoidable, true)
  // The only levers were the turn-0 and turn-1 decisions; none exists after turn 1.
  assert.equal(review.lastChanceTurn, 1)
  assert.deepEqual(
    review.options.map((o) => [o.turn, o.truck, o.instead]),
    [
      [0, 'T-04', null],
      [1, 'T-04', 'S-01'],
    ],
  )
  assert.equal(
    review.options.some((o) => o.turn >= 2),
    false,
    'no move from East Hub was possible on turns 2-3',
  )
  assert.equal(DebriefFactsSchema.safeParse(facts).success, true)
})

test('a flood loss nobody could have prevented says so and lists no options', () => {
  // Harbor fills first, so the biggest open demand left is 30. T-04 takes exactly 30 on
  // turn 0 and is on the road (outbound, then returning) until turn 4.
  const facts = analyze(
    play((turn) =>
      turn === 0
        ? [send('T-01', 'harbor', 25), send('T-02', 'harbor', 10), send('T-04', 'city', 30)]
        : [],
    ),
  )
  assert.equal(facts.floodLoss, 10)
  const review = facts.floodReview!
  assert.equal(review.avoidable, false)
  assert.equal(review.lastChanceTurn, null)
  assert.deepEqual(review.options, [])
  assert.match(review.reason!, /T-04 was outbound on turns 0-1/)
  assert.match(review.reason!, /T-04 was returning on turns 2-3/)
  assert.match(review.reason!, /unavoidable/)
})

test('a truck left idle at East Hub lists every turn up to its last chance', () => {
  const facts = analyze(play(() => []))
  const review = facts.floodReview!
  assert.equal(review.avoidable, true)
  assert.equal(review.lastChanceTurn, 3)
  assert.deepEqual(
    review.options.map((o) => o.turn),
    [0, 1, 2, 3],
  )
  assert.ok(review.options.every((o) => o.from === 'East Hub' && o.saves === 10))
  // Harbor Clinic has the most open demand (35); its route from East Hub gets slower once
  // the corridor closes on turn 2.
  assert.deepEqual(
    review.options.map((o) => o.arrival),
    [2, 3, 5, 6],
  )
  const t4 = facts.idleTrucks.find((t) => t.truck === 'T-04')!
  assert.deepEqual(t4.firstMove, { turn: 0, to: 'Harbor Clinic', qty: 35, arrival: 2 })
  assert.equal(t4.lastMove?.turn, t4.turns[t4.turns.length - 1])
})

test('no flood loss means no flood review', () => {
  const facts = analyze(
    play((turn) =>
      turn === 0 ? [send('T-04', 'hill', 25)] : turn === 2 ? [send('T-04', 'school', 15)] : [],
    ),
  )
  assert.equal(facts.floodReview, undefined)
})

test('facts are deterministic and satisfy the wire schema', () => {
  const frames = play((turn) => (turn === 0 ? [send('T-03', 'valley', 30)] : []))
  assert.deepEqual(analyze(frames), analyze(frames))
  assert.equal(DebriefFactsSchema.safeParse(analyze(frames)).success, true)
})
