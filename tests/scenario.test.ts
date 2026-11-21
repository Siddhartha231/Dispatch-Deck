import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { analyze } from '../src/domain/analysis.ts'
import { checkDebrief } from '../src/domain/debrief-check.ts'
import { initial, route, score, transition, type Command, type Run } from '../src/domain/engine.ts'
import { forkFrame, forkRun } from '../src/domain/fork.ts'
import { greedyRun } from '../src/domain/greedy.ts'
import {
  leaderboardFields,
  leaderboardEntry,
  rankOf,
  topEntries,
} from '../src/domain/leaderboard.ts'
import { hashSeed, mulberry32, rng } from '../src/domain/prng.ts'
import {
  CreateRunRequestSchema,
  RunSchema,
  type DebriefFacts,
  type Disruption,
  type RunSummary,
} from '../src/domain/protocol.ts'
import {
  CLASSIC_PLAN,
  CLASSIC_SEED,
  dailySeed,
  disruptionsOf,
  resolveSeed,
  scenarioLabel,
  scenarioOf,
} from '../src/domain/scenario.ts'
import { balanced, candidate, MAX_ATTEMPTS, newRun, scenarioPlan } from '../src/domain/scenarios.ts'

const advance = (s: Run) => transition(s, { type: 'advance' }, 'commander', 'Crew')
const start = (s: Run) => transition(s, { type: 'start' }, 'commander', 'Crew')
const send = (truck: string, to: string, qty: number): Command => ({
  type: 'dispatch',
  truck,
  to,
  qty,
})

/** Plays a lobby board to the deadline, recording every frame like SimulationRoom does. */
function play(first: Run, script: (turn: number) => Command[] = () => []): Run[] {
  let s = first
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

const SEEDS = Array.from({ length: 200 }, (_, i) => 'seed-' + i)

// -- PRNG ---------------------------------------------------------------------

test('the PRNG is deterministic per seed and differs between seeds', () => {
  const a = mulberry32(hashSeed('harbor-storm'))
  const b = mulberry32(hashSeed('harbor-storm'))
  const c = mulberry32(hashSeed('harbor-storn'))
  const xs = Array.from({ length: 20 }, () => a())
  assert.deepEqual(
    xs,
    Array.from({ length: 20 }, () => b()),
  )
  assert.notDeepEqual(
    xs,
    Array.from({ length: 20 }, () => c()),
  )
  assert.ok(xs.every((x) => x >= 0 && x < 1))
  assert.notEqual(hashSeed('a'), hashSeed('b'))
})

test('rng ints stay in range, pick picks members, shuffle permutes', () => {
  const r = rng('range')
  for (let i = 0; i < 500; i++) {
    const n = r.int(3, 7)
    assert.ok(Number.isInteger(n) && n >= 3 && n <= 7)
  }
  assert.ok([1, 2, 3].includes(r.pick([1, 2, 3])))
  assert.deepEqual(r.shuffle([1, 2, 3, 4, 5]).sort(), [1, 2, 3, 4, 5])
  assert.deepEqual(rng('x').shuffle([1, 2, 3, 4, 5]), rng('x').shuffle([1, 2, 3, 4, 5]))
})

// -- Classic compatibility -----------------------------------------------------

type Fixture = { commands: Command[]; frames: Run[] }
const classic: Fixture = JSON.parse(
  readFileSync(new URL('./fixtures/classic.json', import.meta.url), 'utf8'),
)

test('classic is byte-identical to the board and event text captured before scenarios existed', () => {
  // classic.json was recorded from the original initial() and engine, with no scenario field.
  const first = newRun('classic-fixture', 'Classic fixture', CLASSIC_SEED)
  assert.equal(JSON.stringify(first), JSON.stringify(classic.frames[0]))
  assert.equal(JSON.stringify(initial('classic-fixture', 'Classic fixture')), JSON.stringify(first))
  assert.equal('scenario' in first, false)
  let s = start(first)
  const frames = [first, s]
  for (const cmd of classic.commands) {
    s = transition(s, cmd, 'commander', 'Crew')
    frames.push(s)
  }
  assert.equal(JSON.stringify(frames), JSON.stringify(classic.frames))
  assert.deepEqual(
    s.log.filter((e) => e.kind === 'alert').map((e) => e.text),
    [
      'East corridor closed. New dispatches must reroute.',
      'Flooding at East Hub. 10 units of stock lost.',
      'City Center requested 10 additional units.',
    ],
  )
})

test('a stored run with no scenario field still plays the classic schedule', () => {
  const stored = RunSchema.parse(JSON.parse(JSON.stringify(classic.frames[0])))
  assert.equal(stored.scenario, undefined)
  assert.deepEqual(disruptionsOf(stored), CLASSIC_PLAN.disruptions)
  assert.deepEqual(scenarioOf(stored), { seed: 'classic', label: 'Classic' })
  const done = play(stored).at(-1)!
  assert.equal(done.sites.find((n) => n.id === 'east')?.stock, 30)
})

// -- Generation ----------------------------------------------------------------

test('every seed is dealt deterministically, balanced and without falling back', () => {
  for (const seed of SEEDS) {
    const dealt = scenarioPlan(seed)
    assert.equal(dealt.fallback, false, seed)
    assert.ok(dealt.attempt! < MAX_ATTEMPTS)
    // Same attempt number rebuilds the same plan, and it is the first that passes.
    assert.deepEqual(candidate(seed, dealt.attempt!), dealt.plan)
    for (let a = 0; a < dealt.attempt!; a++) assert.equal(balanced(candidate(seed, a)), false)
    const result = score(greedyRun(newRun('b', 'B', seed)))
    assert.ok(result.success, seed + ' ' + JSON.stringify(result))
    assert.ok(result.rate < 100, seed + ' is not trivially perfect')
  }
})

test('generated boards keep the map and respect the scenario invariants', () => {
  const map = JSON.stringify(
    initial('m', 'M').sites.map((n) => [n.id, n.name, n.short, n.x, n.y, n.kind]),
  )
  const kinds = new Set<string>()
  for (const seed of SEEDS) {
    const run = newRun('i', 'I', seed)
    assert.equal(RunSchema.safeParse(run).success, true)
    assert.equal(
      JSON.stringify(run.sites.map((n) => [n.id, n.name, n.short, n.x, n.y, n.kind])),
      map,
    )
    assert.deepEqual(
      run.roads,
      initial('i', 'I').roads,
      'the road network is the same fixed topology',
    )
    // Four trucks, every depot has at least one, classic capacities.
    assert.deepEqual(
      run.fleet.map((v) => v.capacity),
      [25, 25, 30, 40],
    )
    const depots = run.sites.filter((n) => n.kind === 'depot').map((n) => n.id)
    for (const d of depots)
      assert.ok(
        run.fleet.some((v) => v.home === d),
        seed + ' ' + d,
      )
    // Priorities keep the 1-3 scale with at least one critical site.
    const relief = run.sites.filter((n) => n.kind === 'relief')
    assert.ok(relief.every((n) => [1, 2, 3].includes(n.priority)))
    assert.ok(
      relief.some((n) => n.priority === 3),
      seed,
    )
    const stock = run.sites.reduce((t, n) => t + n.stock, 0)
    assert.ok(stock >= 140 && stock <= 170, seed + ' stock ' + stock)
    // Disruptions: one of each kind, on valid targets, in turn order.
    const ds = run.scenario!.disruptions
    assert.deepEqual(ds.map((d) => d.kind).sort(), ['closure', 'flood', 'surge'])
    for (const d of ds) {
      kinds.add(d.kind)
      assert.ok(d.turn >= 1 && d.turn <= 11)
      if (d.kind === 'closure') assert.ok(run.roads.some((r) => r.id === d.road))
      if (d.kind === 'flood') assert.ok(depots.includes(d.site) && d.loss > 0)
      if (d.kind === 'surge') assert.ok(relief.some((n) => n.id === d.site) && d.qty > 0)
    }
    assert.deepEqual(
      ds.map((d) => d.turn),
      ds.map((d) => d.turn).sort((a, b) => a - b),
    )
    assert.equal(run.scenario!.seed, seed)
    assert.equal(run.scenario!.label, 'Seed: ' + seed)
  }
  assert.equal(kinds.size, 3)
})

test('every site stays reachable from every depot after all closures, on every seed', () => {
  for (const seed of SEEDS) {
    let s = start(newRun('r', 'R', seed))
    for (let i = 0; i < 11; i++) s = advance(s)
    assert.equal(s.roads.filter((r) => r.blocked).length, 1, seed)
    for (const depot of s.sites.filter((n) => n.kind === 'depot'))
      for (const site of s.sites)
        assert.ok(route(s.roads, depot.id, site.id), `${seed}: ${depot.id} to ${site.id}`)
  }
})

test('seeds vary the game: plans differ, and the same seed repeats', () => {
  const plans = new Set(SEEDS.map((seed) => JSON.stringify(scenarioPlan(seed).plan)))
  assert.ok(plans.size >= 190, 'distinct plans: ' + plans.size)
  const a = newRun('x', 'X', 'harbor-storm')
  const b = newRun('x', 'X', 'harbor-storm')
  assert.equal(JSON.stringify(a), JSON.stringify(b))
  assert.notEqual(JSON.stringify(a), JSON.stringify(newRun('x', 'X', 'harbor-storn')))
  // The returned board is a fresh copy: changing it must not change what the next caller gets.
  a.scenario!.disruptions.length = 0
  a.sites[0].stock = 0
  assert.equal(JSON.stringify(newRun('x', 'X', 'harbor-storm')), JSON.stringify(b))
})

test('generation is fast', () => {
  const t = performance.now()
  for (let i = 0; i < 100; i++) scenarioPlan('fresh-' + i)
  const each = (performance.now() - t) / 100
  assert.ok(each < 25, `${each.toFixed(1)} ms per fresh seed`)
})

// -- Disruptions fire from data ---------------------------------------------------

test('the engine fires the run’s own schedule, with its names in the alert text', () => {
  const run = newRun('d', 'D', 'harbor-storm')
  const of = <K extends Disruption['kind']>(kind: K) =>
    run.scenario!.disruptions.find((d) => d.kind === kind) as Extract<Disruption, { kind: K }>
  const [closure, flood, surge] = [of('closure'), of('flood'), of('surge')]
  const final = play(run).at(-1)!
  const alerts = final.log.filter((e) => e.kind === 'alert')
  assert.equal(alerts.length, 3)
  for (const e of alerts) assert.ok(e.tick >= 1)
  assert.equal(alerts.find((e) => /closed/.test(e.text))?.tick, closure.turn)
  assert.equal(alerts.find((e) => /Flooding/.test(e.text))?.tick, flood.turn)
  assert.equal(alerts.find((e) => /requested/.test(e.text))?.tick, surge.turn)
  const name = (id: string) => run.sites.find((n) => n.id === id)!.name
  assert.ok(alerts.some((e) => e.text.startsWith('Flooding at ' + name(flood.site) + '. ')))
  assert.ok(
    alerts.some((e) => e.text === `${name(surge.site)} requested ${surge.qty} additional units.`),
  )
  assert.equal(final.roads.find((r) => r.id === closure.road)!.blocked, true)
  assert.equal(
    final.sites.find((n) => n.id === surge.site)!.demand,
    run.sites.find((n) => n.id === surge.site)!.demand + surge.qty,
  )
  // Nothing else closed: the schedule is the only source of disruption.
  assert.equal(final.roads.filter((r) => r.blocked).length, 1)
  assert.equal(
    final.sites.find((n) => n.id === flood.site)!.stock,
    run.sites.find((n) => n.id === flood.site)!.stock -
      Math.min(flood.loss, run.sites.find((n) => n.id === flood.site)!.stock),
  )
})

test('a hand-written schedule is obeyed, and a flood takes only what the depot holds', () => {
  const run = newRun('h', 'H', 'hand')
  run.scenario!.disruptions = [
    { kind: 'flood', turn: 1, site: 'south', loss: 500 },
    { kind: 'closure', turn: 1, road: 'north-valley' },
  ]
  const s = advance(start(run))
  assert.equal(s.sites.find((n) => n.id === 'south')!.stock, 0)
  assert.equal(s.roads.find((r) => r.id === 'north-valley')!.blocked, true)
  assert.deepEqual(
    s.log.filter((e) => e.kind === 'alert').map((e) => e.text),
    [
      `Flooding at South Depot. ${run.sites.find((n) => n.id === 'south')!.stock} units of stock lost.`,
      'North Hub to Valley Shelter road closed. New dispatches must reroute.',
    ],
  )
})

test('a fork continues the same scenario, firing the disruptions still ahead', () => {
  const seed = 'fork-me'
  const frames = play(newRun('src', 'Source', seed))
  const ds = frames[0].scenario!.disruptions
  const turn = Math.min(...ds.map((d) => d.turn)) // fork before the first disruption fires
  const picked = forkFrame(frames, turn - 1)
  assert.ok(picked.ok)
  const fork = forkRun(picked.value, 'fork', 'Fork', 'Crew', { id: 'src', turn: turn - 1 })
  assert.deepEqual(fork.scenario, frames[0].scenario)
  let s = fork
  while (s.phase === 'running') s = advance(s)
  assert.equal(
    s.log.filter((e) => e.kind === 'alert').length,
    3,
    'all three scheduled disruptions fire in the fork',
  )
  assert.deepEqual(
    s.log.filter((e) => e.kind === 'alert').map((e) => e.text),
    frames
      .at(-1)!
      .log.filter((e) => e.kind === 'alert')
      .map((e) => e.text),
  )
})

// -- Analysis and debrief checking on a non-classic seed ---------------------------------

/** First seed whose flood depot satisfies `ok` (so the test is deterministic, not lucky). */
function seedWhere(ok: (run: Run) => boolean) {
  for (let i = 0; i < 200; i++) if (ok(newRun('s', 'S', 'probe-' + i))) return 'probe-' + i
  throw new Error('no seed found')
}
const floodOf = (run: Run) =>
  run.scenario!.disruptions.find((d) => d.kind === 'flood') as {
    site: string
    turn: number
    loss: number
  }

test('the flood review reads the scenario: depot, turn and loss', () => {
  const seed = seedWhere((r) => floodOf(r).site !== 'east' && floodOf(r).turn !== 4)
  const first = newRun('a', 'Analysis drill', seed)
  const flood = floodOf(first)
  const depot = first.sites.find((n) => n.id === flood.site)!
  const facts = analyze(play(first))
  assert.equal(facts.floodLoss, Math.min(flood.loss, depot.stock))
  assert.equal(facts.floodReview?.depot, depot.name)
  assert.equal(facts.floodReview?.turn, flood.turn)
  // Doing nothing wastes every truck homed at the flooded depot, so the loss was avoidable.
  assert.equal(facts.floodReview?.avoidable, true)
  assert.ok(facts.floodReview!.options.length > 0)
  for (const o of facts.floodReview!.options) {
    assert.equal(o.from, depot.name)
    assert.ok(o.turn < flood.turn)
    assert.equal(first.fleet.find((v) => v.id === o.truck)!.home, flood.site)
  }
  assert.ok(facts.timeline.some((e) => e.text.startsWith('Flooding at ' + depot.name)))
  assert.doesNotMatch(JSON.stringify(facts.timeline), /East corridor/)
})

test('an unavoidable flood loss names the flooded depot', () => {
  const first = newRun('u', 'Drill', 'hand-built')
  first.scenario!.disruptions = [{ kind: 'flood', turn: 3, site: 'south', loss: 10 }]
  first.fleet.forEach((v, i) => (v.home = ['north', 'north', 'south', 'east'][i]))
  first.sites.find((n) => n.id === 'south')!.stock = 50
  first.sites.find((n) => n.id === 'school')!.demand = 30
  // T-03 is South Depot's only truck: out to the school on turn 0, back on turn 4, after the flood.
  const facts = analyze(play(first, (turn) => (turn === 0 ? [send('T-03', 'school', 30)] : [])))
  assert.equal(facts.floodLoss, 10)
  assert.equal(facts.floodReview?.avoidable, false)
  assert.equal(facts.floodReview?.depot, 'South Depot')
  assert.match(facts.floodReview!.reason!, /^South Depot stock could not be moved: T-03 was /)
})

test('the debrief check uses the scenario’s flooded depot, not East Hub', () => {
  const seed = seedWhere((r) => floodOf(r).site === 'north')
  const first = newRun('c', 'Check', seed)
  const facts: DebriefFacts = analyze(play(first))
  const depot = facts.floodReview!.depot!
  assert.equal(depot, 'North Hub')
  const hopeless: DebriefFacts = {
    ...facts,
    floodReview: {
      ...facts.floodReview!,
      avoidable: false,
      options: [],
      lastChanceTurn: null,
      reason: 'Nothing could move.',
    },
  }
  const advice = checkDebrief(
    {
      headline: 'We fell short.',
      wentWell: [],
      costUs: [],
      nextTime: [`Move ${depot} stock out before the flood.`],
    },
    hopeless,
  )
  assert.equal(advice.ok, false)
  assert.ok(!advice.ok && advice.problems.some((p) => p.includes(`advises moving ${depot} stock`)))
  // The same sentence about a depot that did not flood is just ordinary advice about names.
  const ok = checkDebrief(
    {
      headline: 'We fell short.',
      wentWell: [],
      costUs: [],
      nextTime: ['The flood loss was unavoidable.'],
    },
    hopeless,
  )
  assert.deepEqual(ok, { ok: true })
  // And advice built from the engine's own options passes.
  const o = facts.floodReview!.options[0]
  const good = checkDebrief(
    {
      headline: 'We fell short.',
      wentWell: [],
      costUs: [],
      nextTime: [
        `On turn ${o.turn}, send ${o.truck} from ${o.from} to ${o.to} with ${o.qty} units.`,
      ],
    },
    facts,
  )
  assert.deepEqual(good, { ok: true })
})

// -- Names, seeds and requests ----------------------------------------------------------

test('labels, daily seeds and seed resolution', () => {
  assert.equal(scenarioLabel('classic'), 'Classic')
  assert.equal(scenarioLabel('daily-2026-11-21'), 'Daily · 21 Nov 2026')
  assert.equal(scenarioLabel('daily-2026-13-40'), 'Seed: daily-2026-13-40')
  assert.equal(scenarioLabel('harbor-storm'), 'Seed: harbor-storm')
  assert.equal(dailySeed(new Date('2026-11-21T23:59:59Z')), 'daily-2026-11-21')
  assert.equal(dailySeed(new Date('2026-11-22T00:00:00Z')), 'daily-2026-11-22')
  const now = new Date('2026-11-21T10:00:00Z')
  assert.equal(resolveSeed(undefined, now), 'classic')
  assert.equal(resolveSeed('daily', now), 'daily-2026-11-21')
  assert.equal(resolveSeed('classic', now), 'classic')
  assert.equal(resolveSeed('harbor-storm', now), 'harbor-storm')
  assert.equal(newRun('l', 'L', 'daily-2026-11-21').scenario!.label, 'Daily · 21 Nov 2026')
})

test('create requests validate and normalise the seed', () => {
  const base = { id: crypto.randomUUID(), title: 'Run' }
  const parse = (seed?: unknown) => CreateRunRequestSchema.safeParse({ ...base, seed })
  assert.equal(CreateRunRequestSchema.safeParse(base).success, true, 'seed is optional')
  assert.equal(
    CreateRunRequestSchema.parse({ ...base, seed: '  Harbor-Storm ' }).seed,
    'harbor-storm',
  )
  for (const ok of ['daily', 'classic', 'a', 'x'.repeat(32), 'daily-2026-11-21', 'one two'])
    assert.equal(parse(ok).success, true, ok)
  for (const bad of ['', '   ', 'x'.repeat(33), '-start', 'semi;colon', '<b>', 'é', 7])
    assert.equal(parse(bad).success, false, String(bad))
})

// -- Leaderboard helpers ----------------------------------------------------------------

const summary = (over: Partial<RunSummary> & { rate: number; weighted: number }): RunSummary => ({
  id: over.id ?? 'r',
  title: 'T',
  tick: 12,
  phase: over.phase ?? 'completed',
  score: { demand: 150, delivered: 100, rate: over.rate, weighted: over.weighted, success: true },
  version: 30,
  ...(over.forkedFrom && { forkedFrom: over.forkedFrom }),
  scenario: over.scenario ?? { seed: 'harbor-storm', label: 'Seed: harbor-storm' },
})

test('the leaderboard index ranks by rate then weighted, and never ranks forks', () => {
  assert.ok(rankOf({ rate: 90, weighted: 10 }) > rankOf({ rate: 89, weighted: 100 }))
  assert.ok(rankOf({ rate: 90, weighted: 50 }) > rankOf({ rate: 90, weighted: 49 }))
  assert.deepEqual(leaderboardFields(summary({ rate: 90, weighted: 80 })), {
    phase: 'completed',
    rank: 90080,
    seed: 'harbor-storm',
  })
  const fork = leaderboardFields(
    summary({ rate: 90, weighted: 80, forkedFrom: { id: 'x', turn: 3 } }),
  )
  assert.equal('seed' in fork, false)
  const rows = Array.from({ length: 14 }, (_, i) =>
    leaderboardEntry(summary({ id: 'r' + String(i).padStart(2, '0'), rate: 80 + i, weighted: 50 })),
  )
  const top = topEntries(rows)
  assert.equal(top.length, 10)
  assert.deepEqual(
    top.map((e) => e.rate),
    [93, 92, 91, 90, 89, 88, 87, 86, 85, 84],
  )
})
