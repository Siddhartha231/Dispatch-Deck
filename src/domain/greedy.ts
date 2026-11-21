/**
 * The reference crew. Each turn, every ready truck carries what it can to the
 * highest-priority open demand it can reach before the deadline. The scenario
 * generator only deals a seed this crew can win (see scenarios.ts), and the
 * balance tests use it as the bar a straightforward human crew must clear.
 * Pure; no platform imports.
 */
import { availableDemand, route, transition } from './engine.ts'
import type { Run } from './protocol.ts'
import { DEADLINE } from './scenario.ts'

/** Plays `start` (a lobby board) to the deadline with the greedy policy and returns the final board. */
export function greedyRun(start: Run): Run {
  let s = transition(start, { type: 'start' }, 'commander', 'Greedy')
  while (s.phase === 'running') {
    for (const { id } of s.fleet) {
      const truck = s.fleet.find((v) => v.id === id)!
      const home = s.sites.find((n) => n.id === truck.home)!
      if (truck.status !== 'ready' || home.stock === 0) continue
      const best = s.sites
        .filter((n) => n.kind === 'relief')
        .map((n) => ({
          site: n,
          path: route(s.roads, home.id, n.id),
          open: availableDemand(s, n.id),
        }))
        .filter((o) => o.path && o.open > 0 && s.tick + o.path.cost <= DEADLINE)
        .sort((a, b) => b.site.priority - a.site.priority || a.path!.cost - b.path!.cost)[0]
      if (!best) continue
      const qty = Math.min(truck.capacity, home.stock, best.open)
      s = transition(s, { type: 'dispatch', truck: id, to: best.site.id, qty }, 'dispatcher', 'G')
    }
    s = transition(s, { type: 'advance' }, 'commander', 'Greedy')
  }
  return s
}
