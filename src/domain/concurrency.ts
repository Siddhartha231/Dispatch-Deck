import { route, type Command, type Run } from './engine.ts'

/**
 * Decides whether a command planned against an older board (`seen`) may still
 * be applied to the current one (`latest`). Returns the reason it may not, or
 * null.
 *
 * Clock commands (start, advance, finish) belong to the commander and act on
 * the whole board, so they must be issued against the latest version.
 *
 * A dispatch only depends on its own truck, depot stock, destination demand,
 * the turn and the route. The engine re-checks the first three against
 * `latest` inside the same transaction and answers 409 if another operator
 * took them. That leaves the turn and the route: if either changed, the
 * operator planned with an arrival estimate that no longer holds. Two
 * dispatchers sending different trucks in the same turn therefore both
 * commit, while two orders for the same truck still conflict.
 *
 * Roads currently change only when the turn advances, so the route check is a
 * guard for future events that close a road mid-turn.
 */
export function staleReason(seen: Run, latest: Run, cmd: Command): string | null {
  if (seen.version === latest.version) return null
  if (cmd.type !== 'dispatch')
    return 'Another operator changed the board. Review the latest state and try again.'
  if (seen.tick !== latest.tick)
    return 'Time advanced since you planned this shipment. Review the new turn and dispatch again.'
  const truck = latest.fleet.find((v) => v.id === cmd.truck)
  if (!truck) return null // The engine rejects unknown trucks with a clearer message.
  const planned = route(seen.roads, truck.home, cmd.to)?.edges.join('/')
  const current = route(latest.roads, truck.home, cmd.to)?.edges.join('/')
  return planned === current
    ? null
    : 'The route to this destination changed. Review the new estimate and dispatch again.'
}
