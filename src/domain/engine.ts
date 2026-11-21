/**
 * The Coastal Supply Crisis rules. Pure and deterministic: the same commands
 * from the same start always produce the same boards, which is what makes
 * replay and the after-action analysis exact. No platform imports.
 */
import type { Command, Disruption, Entry, Road, Role, Run, Site, Truck } from './protocol.ts'
import { buildRun, CLASSIC_PLAN, disruptionsOf } from './scenario.ts'

export type { Command, Entry, Road, Role, Run, Shipment, Site, Truck } from './protocol.ts'

/**
 * A command the rules reject. 422 means the command itself is invalid, 409
 * means it conflicts with the current board (a truck already taken, stock or
 * demand already reserved), and 403 means the caller's role forbids it.
 */
export class RuleError extends Error {
  status: number
  constructor(message: string, status = 422) {
    super(message)
    this.status = status
  }
}
/** The classic scenario's starting board. Seeded scenarios are dealt by `newRun` (scenarios.ts). */
export function initial(id: string, title: string): Run {
  return buildRun(id, title, CLASSIC_PLAN)
}
/** The name a closure alert uses for a road. */
function roadName(s: Run, road: Road) {
  if (road.id === 'east-corridor') return 'East corridor'
  const name = (id: string) => s.sites.find((n) => n.id === id)?.name ?? id
  return name(road.a) + ' to ' + name(road.b) + ' road'
}

/** Applies one scheduled disruption to `s` (already a private copy) and logs its alert. */
function disrupt(s: Run, d: Disruption, log: (kind: Entry['kind'], text: string) => void) {
  if (d.kind === 'closure') {
    const road = s.roads.find((r) => r.id === d.road)
    if (!road) return
    road.blocked = true
    log('alert', roadName(s, road) + ' closed. New dispatches must reroute.')
    return
  }
  const site = s.sites.find((n) => n.id === d.site)
  if (!site) return
  if (d.kind === 'flood') {
    const loss = Math.min(d.loss, site.stock)
    site.stock -= loss
    log('alert', 'Flooding at ' + site.name + '. ' + loss + ' units of stock lost.')
  } else {
    site.demand += d.qty
    log('alert', site.name + ' requested ' + d.qty + ' additional units.')
  }
}
export const availableDemand = (s: Run, id: string) => {
  const site = s.sites.find((x) => x.id === id)
  return site
    ? site.demand -
        site.delivered -
        s.shipments.filter((x) => !x.delivered && x.to === id).reduce((n, x) => n + x.qty, 0)
    : 0
}
export function route(roads: Road[], from: string, to: string) {
  const next = [{ at: from, cost: 0, edges: [] as string[] }],
    seen = new Set<string>()
  while (next.length) {
    next.sort((a, b) => a.cost - b.cost || a.edges.join('/').localeCompare(b.edges.join('/'), 'en'))
    const path = next.shift()!
    if (seen.has(path.at)) continue
    if (path.at === to) return path
    seen.add(path.at)
    for (const r of roads) {
      if (r.blocked || (r.a !== path.at && r.b !== path.at)) continue
      const at = r.a === path.at ? r.b : r.a
      if (!seen.has(at)) next.push({ at, cost: path.cost + r.cost, edges: [...path.edges, r.id] })
    }
  }
  return null
}
export function score(s: Run) {
  const sum = (f: (n: Site) => number) => s.sites.reduce((t, n) => t + f(n), 0)
  const demand = sum((n) => n.demand),
    delivered = sum((n) => n.delivered)
  return {
    demand,
    delivered,
    rate: Math.round((100 * delivered) / demand),
    weighted: Math.round(
      (100 * sum((n) => n.priority * n.delivered)) / sum((n) => n.priority * n.demand),
    ),
    success: delivered * 5 >= demand * 4,
  }
}
export function transition(before: Run, cmd: Command, role: Role, actor: string): Run {
  if (role === 'observer' || (cmd.type !== 'dispatch' && role !== 'commander'))
    throw new RuleError('Your role cannot issue that command.', 403)
  const s = structuredClone(before)
  const log = (kind: Entry['kind'], text: string) =>
    s.log.push({ seq: s.log.length + 1, tick: s.tick, kind, text, actor })
  if (cmd.type === 'start') {
    if (s.phase !== 'lobby') throw new RuleError('This run has already started.')
    s.phase = 'running'
    log('system', 'Relief operation started.')
  } else {
    if (s.phase !== 'running') throw new RuleError('This operation is not active.')
    if (cmd.type === 'dispatch') {
      const truck = s.fleet.find((v) => v.id === cmd.truck),
        dest = s.sites.find((v) => v.id === cmd.to && v.kind === 'relief')
      if (!truck || !dest) throw new RuleError('Choose a fleet vehicle and a relief destination.')
      if (!Number.isSafeInteger(cmd.qty) || cmd.qty < 1 || cmd.qty > truck.capacity)
        throw new RuleError(`Cargo must be a whole number from 1 to ${truck.capacity}.`)
      if (truck.status !== 'ready')
        throw new RuleError(`${truck.id} is already on assignment.`, 409)
      const origin = s.sites.find((n) => n.id === truck.home)!
      if (cmd.qty > origin.stock)
        throw new RuleError(`${origin.name} has only ${origin.stock} units left.`, 409)
      const open = availableDemand(s, dest.id)
      if (cmd.qty > open)
        throw new RuleError(`${dest.name} has only ${open} units of open demand.`, 409)
      const path = route(s.roads, origin.id, dest.id)
      if (!path) throw new RuleError('No open route reaches this destination.')
      origin.stock -= cmd.qty
      truck.status = 'outbound'
      // Estimate: there and back on today's roads. Recomputed on arrival.
      truck.readyAt = s.tick + 2 * path.cost
      const id = 'S-' + String(s.shipments.length + 1).padStart(2, '0')
      s.shipments.push({
        id,
        truck: truck.id,
        from: origin.id,
        to: dest.id,
        qty: cmd.qty,
        edges: path.edges,
        departure: s.tick,
        arrival: s.tick + path.cost,
        delivered: false,
      })
      log('dispatch', truck.id + ' dispatched ' + cmd.qty + ' units to ' + dest.name + '.')
    } else if (cmd.type === 'advance') {
      s.tick++
      log('system', 'Advanced to turn ' + s.tick + '.')
      // Scheduled disruptions come first, so trucks plan their way home on
      // this turn's roads. Cargo already on the road keeps its reserved route.
      for (const d of disruptionsOf(s)) if (d.turn === s.tick) disrupt(s, d, log)
      for (const sh of s.shipments) {
        if (sh.delivered || sh.arrival > s.tick) continue
        sh.delivered = true
        const dest = s.sites.find((n) => n.id === sh.to)!
        dest.delivered += sh.qty
        const truck = s.fleet.find((v) => v.id === sh.truck)!
        truck.status = 'returning'
        // Drive home on the fastest road open now. The scenario network stays
        // connected after every closure (see tests), so a route always exists.
        const home = route(s.roads, sh.to, truck.home)
        truck.readyAt = s.tick + (home?.cost ?? sh.arrival - sh.departure)
        log('arrival', sh.truck + ' delivered ' + sh.qty + ' units to ' + dest.name + '.')
      }
      for (const v of s.fleet)
        if (v.status === 'returning' && s.tick >= v.readyAt) {
          v.status = 'ready'
          log('arrival', v.id + ' returned to base.')
        }
    } else if (cmd.type !== 'finish') throw new RuleError('Unknown command.')
    if (cmd.type === 'finish' || s.tick === 12) {
      s.phase = 'completed'
      log('system', 'Operation closed. Final delivery report available.')
    }
  }
  s.version++
  return s
}
