import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyze } from '../src/domain/analysis.ts'
import {
  checkDebrief,
  extractTurns,
  generateVerified,
  UnverifiedDebriefError,
  WITHHELD_MESSAGE,
} from '../src/domain/debrief-check.ts'
import { initial, transition, type Command, type Run } from '../src/domain/engine.ts'
import type { DebriefFacts, DebriefNarrative } from '../src/domain/protocol.ts'

function play(script: (turn: number) => Command[]): Run[] {
  let s = initial('a', 'Debrief drill')
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

/** T-04 left on turn 1; turn 0 or the turn-1 load were the only ways to save East Hub stock. */
const avoidable = analyze(play((t) => (t === 1 ? [send('T-04', 'hill', 20)] : [])))
/** T-04 was on the road all through turns 0-3: the flood loss was unavoidable. */
const unavoidable = analyze(
  play((t) =>
    t === 0
      ? [send('T-01', 'harbor', 25), send('T-02', 'harbor', 10), send('T-04', 'city', 30)]
      : [],
  ),
)
/** No flood at all. */
const noFlood = analyze(
  play((t) => (t === 0 ? [send('T-04', 'hill', 25)] : t === 2 ? [send('T-04', 'school', 15)] : [])),
)

const narrative = (n: Partial<DebriefNarrative>): DebriefNarrative => ({
  headline: 'Narrative headline.',
  wentWell: [],
  costUs: [],
  nextTime: [],
  ...n,
})
const problemsOf = (n: DebriefNarrative, f: DebriefFacts) => {
  const r = checkDebrief(n, f)
  return r.ok ? [] : r.problems
}

test('extractTurns reads digits, words, ranges and lists', () => {
  const t = (s: string) => extractTurns(s).map((r) => r.turns)
  assert.deepEqual(t('on turn 4'), [[4]])
  assert.deepEqual(t('after the Turn-two alert'), [[2]])
  assert.deepEqual(t('turns 2-3 and turn eleven'), [[2, 3], [11]])
  assert.deepEqual(t('turns two to four'), [[2, 3, 4]])
  assert.deepEqual(t('turns 1, 2 and 3'), [[1, 2, 3]])
  assert.deepEqual(t('on turn 3, 25 units left'), [[3]])
  assert.deepEqual(t('at turn 3 and 25 units'), [[3]])
})

test('a faithful debrief of an avoidable flood loss passes', () => {
  const n = narrative({
    headline: 'The crew delivered 13% of demand against the 80% target.',
    wentWell: [
      'T-04 delivered 20 units to Hill Hospital by turn 2, so the critical site is nearly full.',
      'Dispatching started on turn 1.',
    ],
    costUs: [
      'T-01, T-02 and T-03 sat idle for all 12 turns while Harbor Clinic had 35 units of open demand.',
      'East Hub lost 10 units to the flood on turn 4.',
    ],
    nextTime: [
      'Send T-04 on turn 0 with 35 units to Harbor Clinic; that would have kept 10 units out of the flood.',
      'T-04 could have taken the fuller 35-unit load on turn 1 instead of S-01; turn 1 was the last chance.',
      'Use T-01 on turn 0 to reach Harbor Clinic by turn 2.',
    ],
  })
  assert.deepEqual(problemsOf(n, avoidable), [])
})

test('a faithful debrief of an unavoidable flood loss passes', () => {
  const n = narrative({
    headline: 'The crew delivered 43% against the 80% target, with 65 of 150 units delivered.',
    wentWell: ['Harbor Clinic, a critical site, was fully supplied by turn 2.'],
    costUs: [
      'East Hub lost 10 units to the flood on turn 4, and that loss was unavoidable: T-04 was outbound on turns 0-1 and returning on turns 2-3.',
      'Hill Hospital, a critical site, received nothing, leaving 25 units unmet.',
    ],
    nextTime: [
      'T-03 could have left South Depot on turn 0 with 25 units for Hill Hospital.',
      'Keep T-01 and T-02 moving after turn 4; both could have sent 25 units to Hill Hospital that turn.',
    ],
  })
  assert.deepEqual(problemsOf(n, unavoidable), [])
})

test('the real bad debrief: moving East Hub stock after the turn-two alert', () => {
  const n = narrative({
    headline: 'The crew delivered 43% against the 80% target.',
    costUs: ['East Hub stock was lost because nobody moved it after the turn two alert.'],
    nextTime: ['Move East Hub stock with T-04 after the turn-two alert to dodge the flood.'],
  })
  const problems = problemsOf(n, unavoidable)
  assert.ok(problems.some((p) => /unavoidable/.test(p)))
  assert.ok(problems.some((p) => p.startsWith('nextTime')))
  // Still wrong when the facts say avoidable but only turns 0 and 1 were options.
  const bad = narrative({ nextTime: ['T-04 could have moved East Hub stock on turn 2.'] })
  assert.match(problemsOf(bad, avoidable).join('\n'), /turn 2 with T-04 is not a checked move/)
})

test('unavoidable loss with flood advice is rejected, but saying so is not', () => {
  const advice = narrative({ nextTime: ['Evacuate East Hub before the flood.'] })
  assert.equal(checkDebrief(advice, unavoidable).ok, false)
  assert.equal(checkDebrief(advice, noFlood).ok, false)
  const fine = narrative({
    costUs: [
      'Nothing could have saved the East Hub stock from the flood; the loss was unavoidable.',
    ],
  })
  assert.deepEqual(problemsOf(fine, unavoidable), [])
})

test('unknown trucks, shipments, turns, sites and numbers are caught', () => {
  const run = (n: Partial<DebriefNarrative>) => problemsOf(narrative(n), avoidable).join()
  assert.match(run({ costUs: ['T-09 sat idle at North Hub.'] }), /truck T-09/)
  assert.match(run({ costUs: ['S-07 arrived late.'] }), /shipment S-07/)
  assert.match(run({ costUs: ['Nothing moved on turn 15.'] }), /turn 15/)
  assert.match(run({ wentWell: ['Westside Clinic was supplied early.'] }), /Westside Clinic/)
  assert.match(run({ headline: 'The crew delivered 91% of demand.' }), /91%/)
  assert.match(run({ costUs: ['T-04 delivered 77 units.'] }), /number 77/)
})

test('derived percentages and totals are allowed', () => {
  // Hill Hospital: 20 of 25 delivered = 80%; total unmet = 130; 100 - 13 = 87.
  const n = narrative({
    headline:
      'Hill Hospital reached 80% delivery but 87% of total demand went unmet; 130 units remain.',
    costUs: ['Overall the crew was 67 points short of the 80% target.'],
  })
  assert.deepEqual(problemsOf(n, avoidable), [])
  assert.equal(
    checkDebrief(narrative({ headline: 'Delivery was 55% of demand.' }), avoidable).ok,
    false,
  )
})

test('descriptive costUs sentences are not treated as advice', () => {
  const n = narrative({
    costUs: ['T-04 was dispatched on turn 1 rather than turn 0, which cost the flood stock.'],
  })
  assert.deepEqual(problemsOf(n, avoidable), [])
})

test('by/before turn references are deadlines, not move turns', () => {
  const n = narrative({
    nextTime: ['T-04 should leave on turn 0, well before the flood on turn 4.'],
  })
  assert.deepEqual(problemsOf(n, avoidable), [])
})

test('a hand-written fact set with no idle moves rejects truck advice', () => {
  const facts: DebriefFacts = { ...noFlood, idleTrucks: [], floodReview: undefined }
  const n = narrative({ nextTime: ['Send T-01 on turn 3.'] })
  assert.equal(checkDebrief(n, facts).ok, false)
  assert.equal(checkDebrief(narrative({ wentWell: ['T-04 delivered 40 units.'] }), facts).ok, true)
})

test('generateVerified returns a good first draft with one call', async () => {
  let calls = 0
  const good = narrative({ headline: 'Delivered 13% against the 80% target.' })
  const out = await generateVerified(
    async () => (calls++, good),
    avoidable,
    () => {},
  )
  assert.equal(calls, 1)
  assert.equal(out, good)
})

test('generateVerified retries once with the problems, then accepts a fixed draft', async () => {
  const prompts: (string[] | null)[] = []
  const bad = narrative({ nextTime: ['Send T-09 on turn 0.'] })
  const good = narrative({ nextTime: ['Send T-04 on turn 0 to Harbor Clinic.'] })
  const out = await generateVerified(
    async (p) => (prompts.push(p), prompts.length === 1 ? bad : good),
    avoidable,
    () => {},
  )
  assert.equal(out, good)
  assert.equal(prompts[0], null)
  assert.match(prompts[1]!.join(), /T-09/)
})

test('generateVerified gives up after two bad drafts and never calls a third time', async () => {
  let calls = 0
  const bad = narrative({ nextTime: ['Send T-09 on turn 0.'] })
  const warnings: unknown[][] = []
  await assert.rejects(
    generateVerified(
      async () => (calls++, bad),
      avoidable,
      (...a) => warnings.push(a),
    ),
    (e: unknown) =>
      e instanceof UnverifiedDebriefError &&
      e.message === WITHHELD_MESSAGE &&
      e.problems.length > 0,
  )
  assert.equal(calls, 2)
  assert.equal(warnings.length, 2)
})

test('generateVerified does not retry a model failure', async () => {
  let calls = 0
  await assert.rejects(
    generateVerified(
      async () => {
        calls++
        throw new Error('boom')
      },
      avoidable,
      () => {},
    ),
    /boom/,
  )
  assert.equal(calls, 1)
})
