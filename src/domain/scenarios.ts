/**
 * Seeded scenario generation. `scenarioPlan(seed)` is a pure function of the
 * seed string: the same seed always deals the same stock, demand, priorities,
 * truck homes and disruption schedule, in the browser and in the Worker.
 *
 * Balance is guaranteed by rejection sampling: candidate `n` for a seed is
 * derived from `seed#n`, and the first one the reference greedy crew can win
 * (at least the 80% target) but cannot perfect (under 100%) is dealt. If no
 * candidate within MAX_ATTEMPTS qualifies, the classic plan is dealt instead.
 * The seed "classic" is always the original hand-built exercise.
 */
import { greedyRun } from './greedy.ts'
import { score } from './engine.ts'
import { rng } from './prng.ts'
import {
  buildRun,
  CLASSIC_PLAN,
  CLASSIC_SEED,
  connected,
  DEPOTS,
  LINKS,
  RELIEF,
  scenarioLabel,
  type Plan,
} from './scenario.ts'
import type { Disruption, Run } from './protocol.ts'

export const MAX_ATTEMPTS = 40
const TOTAL_STOCK = [140, 170] as const
const TOTAL_DEMAND = [125, 155] as const

/** One unvetted candidate plan for (seed, attempt). Deterministic. */
export function candidate(seed: string, attempt: number): Plan {
  const r = rng(`${seed}#${attempt}`)
  const step5 = (lo: number, hi: number) => 5 * r.int(lo / 5, hi / 5)

  let stock: Record<string, number>
  do stock = Object.fromEntries(DEPOTS.map((d) => [d, step5(35, 65)]))
  while (sum(stock) < TOTAL_STOCK[0] || sum(stock) > TOTAL_STOCK[1])

  const base = CLASSIC_PLAN.demand
  let demand: Record<string, number>
  do demand = Object.fromEntries(RELIEF.map((s) => [s, Math.max(15, base[s] + step5(-10, 10))]))
  while (sum(demand) < TOTAL_DEMAND[0] || sum(demand) > TOTAL_DEMAND[1])

  // Priorities are 1 standard, 2 high, 3 critical; every mix keeps at least one critical site.
  const mix = r.pick([
    [3, 3, 2, 2, 1],
    [3, 2, 2, 1, 1],
    [3, 3, 2, 1, 1],
    [3, 3, 3, 2, 1],
  ])
  const shuffled = r.shuffle(mix)
  const priority = Object.fromEntries(RELIEF.map((s, i) => [s, shuffled[i]]))

  // Four trucks, every depot has at least one.
  const homes = r.shuffle([...DEPOTS, r.pick(DEPOTS)])

  // A closure that cannot cut the map in two.
  const safe = LINKS.map(([id]) => id).filter((id) =>
    connected(
      LINKS.map(([rid, a, b, cost]) => ({ id: rid, a, b, cost, blocked: rid === id })),
      [{ id: 'north' }, { id: 'south' }, { id: 'east' }, ...RELIEF.map((id) => ({ id }))],
    ),
  )
  const disruptions: Disruption[] = [
    { kind: 'closure', turn: r.int(1, 4), road: r.pick(safe) },
    { kind: 'flood', turn: r.int(3, 5), site: r.pick(DEPOTS), loss: r.int(6, 14) },
    { kind: 'surge', turn: r.int(5, 8), site: r.pick(RELIEF), qty: step5(5, 15) },
  ]
  // Within a turn the engine fires in array order; keep the schedule readable by turn.
  disruptions.sort((a, b) => a.turn - b.turn)
  return { stock, demand, priority, homes, disruptions }
}

const sum = (o: Record<string, number>) => Object.values(o).reduce((t, n) => t + n, 0)

/** Whether the reference crew wins but cannot perfect this plan. */
export function balanced(plan: Plan): boolean {
  // The scenario field carries the schedule; without it the engine would play the classic one.
  const result = score(greedyRun(buildRun('balance', 'Balance', plan, { seed: '', label: '' })))
  return result.success && result.rate < 100
}

export type Dealt = {
  plan: Plan
  /** The attempt number that passed, or null for classic and for the classic fallback. */
  attempt: number | null
  fallback: boolean
}

const cache = new Map<string, Dealt>()

/** The plan for a seed: deterministic, balanced, memoised. Callers must not mutate it. */
export function scenarioPlan(seed: string): Dealt {
  if (seed === CLASSIC_SEED) return { plan: CLASSIC_PLAN, attempt: null, fallback: false }
  const hit = cache.get(seed)
  if (hit) return hit
  let dealt: Dealt = { plan: CLASSIC_PLAN, attempt: null, fallback: true }
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const plan = candidate(seed, attempt)
    if (balanced(plan)) {
      dealt = { plan, attempt, fallback: false }
      break
    }
  }
  if (cache.size >= 256) cache.clear()
  cache.set(seed, dealt)
  return dealt
}

/**
 * A fresh lobby board for `seed`. Classic carries no scenario field, so it is
 * byte-identical to the original board; every other seed records its label and
 * disruption schedule on the run, which forks and replays then carry along.
 */
export function newRun(id: string, title: string, seed: string = CLASSIC_SEED): Run {
  const { plan } = scenarioPlan(seed)
  return seed === CLASSIC_SEED
    ? buildRun(id, title, plan)
    : buildRun(id, title, plan, { seed, label: scenarioLabel(seed) })
}
