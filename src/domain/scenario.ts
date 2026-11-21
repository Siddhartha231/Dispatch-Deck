/**
 * What a scenario is made of, and how a plan becomes a starting board.
 *
 * The map (sites, positions, roads) is fixed: the client's map art depends on
 * it. A scenario varies only the numbers on it: depot stock, relief demand and
 * priority, which depot each truck calls home, and the disruption schedule.
 * The classic plan is the original hand-built exercise, kept exactly. No
 * platform imports.
 */
import type { Disruption, Road, Run, Site, Truck } from './protocol.ts'

export const CLASSIC_SEED = 'classic'
export const DEADLINE = 12
export const DEPOTS = ['north', 'south', 'east'] as const
export const RELIEF = ['harbor', 'valley', 'city', 'hill', 'school'] as const
/** Truck capacities by fleet position (T-01 first). */
export const CAPACITIES = [25, 25, 30, 40]

/** The numbers a seed decides. */
export type Plan = {
  stock: Record<string, number>
  demand: Record<string, number>
  /** 1 standard, 2 high, 3 critical. */
  priority: Record<string, number>
  /** The home depot of each truck, T-01 first. */
  homes: string[]
  disruptions: Disruption[]
}

export const CLASSIC_PLAN: Plan = {
  stock: { north: 60, south: 50, east: 40 },
  demand: { harbor: 35, valley: 30, city: 30, hill: 25, school: 20 },
  priority: { harbor: 3, valley: 2, city: 1, hill: 3, school: 2 },
  homes: ['north', 'north', 'south', 'east'],
  disruptions: [
    { kind: 'closure', turn: 2, road: 'east-corridor' },
    { kind: 'flood', turn: 4, site: 'east', loss: 10 },
    { kind: 'surge', turn: 6, site: 'city', qty: 10 },
  ],
}

/** The fixed map: the roads, as [id, a, b, travel turns]. */
export const LINKS: [string, string, string, number][] = [
  ['north-valley', 'north', 'valley', 1],
  ['north-harbor', 'north', 'harbor', 2],
  ['north-city', 'north', 'city', 2],
  ['valley-south', 'valley', 'south', 1],
  ['south-city', 'south', 'city', 2],
  ['south-school', 'south', 'school', 2],
  ['city-harbor', 'city', 'harbor', 1],
  ['east-corridor', 'east', 'hill', 1],
  ['east-city', 'east', 'city', 2],
  ['harbor-hill', 'harbor', 'hill', 1],
  ['school-east', 'school', 'east', 2],
]

function depot(id: string, name: string, short: string, x: number, y: number, stock: number): Site {
  return { id, name, short, x, y, stock, kind: 'depot', demand: 0, delivered: 0, priority: 0 }
}
function relief(
  id: string,
  name: string,
  short: string,
  x: number,
  y: number,
  demand: number,
  priority: number,
): Site {
  return { id, name, short, x, y, demand, priority, kind: 'relief', stock: 0, delivered: 0 }
}

/** The starting board for a plan. With no `scenario`, it is byte-identical to the original board. */
export function buildRun(
  id: string,
  title: string,
  plan: Plan,
  scenario?: { seed: string; label: string },
): Run {
  const { stock: st, demand: dm, priority: pr } = plan
  const sites = [
    depot('north', 'North Hub', 'NH', 220, 100, st.north),
    depot('south', 'South Depot', 'SD', 171, 331, st.south),
    depot('east', 'East Hub', 'EH', 558, 246, st.east),
    relief('harbor', 'Harbor Clinic', 'HC', 442, 91, dm.harbor, pr.harbor),
    relief('valley', 'Valley Shelter', 'VS', 114, 209, dm.valley, pr.valley),
    relief('city', 'City Center', 'CC', 342, 219, dm.city, pr.city),
    relief('hill', 'Hill Hospital', 'HH', 585, 136, dm.hill, pr.hill),
    relief('school', 'School Relief Center', 'SC', 422, 343, dm.school, pr.school),
  ]
  const fleet: Truck[] = plan.homes.map((home, i) => ({
    id: 'T-0' + (i + 1),
    home,
    capacity: CAPACITIES[i],
    status: 'ready',
    readyAt: 0,
  }))
  const run: Run = {
    id,
    title,
    tick: 0,
    version: 0,
    phase: 'lobby',
    sites,
    roads: LINKS.map(([id, a, b, cost]) => ({ id, a, b, cost, blocked: false })),
    fleet,
    shipments: [],
    log: [],
  }
  if (scenario) run.scenario = { ...scenario, disruptions: structuredClone(plan.disruptions) }
  return run
}

/** The schedule the engine fires for a run: its own, or the classic one for older runs. */
export const disruptionsOf = (run: Pick<Run, 'scenario'>): Disruption[] =>
  run.scenario?.disruptions ?? CLASSIC_PLAN.disruptions

/** Whether every site can reach every other over the roads that are not blocked. */
export function connected(roads: readonly Road[], sites: readonly Pick<Site, 'id'>[]): boolean {
  const seen = new Set([sites[0].id])
  for (let grew = true; grew; ) {
    grew = false
    for (const r of roads) {
      if (r.blocked || seen.has(r.a) === seen.has(r.b)) continue
      seen.add(r.a).add(r.b)
      grew = true
    }
  }
  return seen.size === sites.length
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAILY = /^daily-(\d{4})-(\d{2})-(\d{2})$/

/** The seed of the daily scenario for a UTC day. */
export const dailySeed = (now: Date) => 'daily-' + now.toISOString().slice(0, 10)

/** "Classic", "Daily · 21 Nov 2026" or "Seed: harbor-storm". */
export function scenarioLabel(seed: string): string {
  if (seed === CLASSIC_SEED) return 'Classic'
  const m = DAILY.exec(seed)
  if (m) {
    const month = Number(m[2])
    const day = Number(m[3])
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31)
      return `Daily · ${day} ${MONTHS[month - 1]} ${m[1]}`
  }
  return 'Seed: ' + seed
}

/**
 * The seed a create request means: omitted is classic (as before seeds existed),
 * "daily" is today's UTC scenario, anything else is used as written.
 */
export function resolveSeed(requested: string | undefined, now: Date): string {
  if (requested === undefined) return CLASSIC_SEED
  return requested === 'daily' ? dailySeed(now) : requested
}

/** The scenario a run is playing, for display; older runs without one are classic. */
export const scenarioOf = (run: Pick<Run, 'scenario'>) =>
  run.scenario
    ? { seed: run.scenario.seed, label: run.scenario.label }
    : { seed: CLASSIC_SEED, label: scenarioLabel(CLASSIC_SEED) }
