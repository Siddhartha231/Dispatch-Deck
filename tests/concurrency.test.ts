import { test } from 'node:test'
import assert from 'node:assert/strict'
import { staleReason } from '../src/domain/concurrency.ts'
import { initial, RuleError, transition, type Command, type Run } from '../src/domain/engine.ts'

/** Applies an order the way SimulationRoom.command does: policy, then rules. */
function commit(
  seen: Run,
  latest: Run,
  cmd: Command,
  role: 'commander' | 'dispatcher' = 'dispatcher',
) {
  const stale = staleReason(seen, latest, cmd)
  if (stale) throw new RuleError(stale, 409)
  return transition(latest, cmd, role, 'Test')
}

const running = () => transition(initial('t', 'Test'), { type: 'start' }, 'commander', 'Lead')
const dispatch = (truck: string, to: string, qty: number): Command => ({
  type: 'dispatch',
  truck,
  to,
  qty,
})
const status = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    return e instanceof RuleError ? e.status : 'unexpected'
  }
  return 200
}

test('different trucks planned on the same board both commit', () => {
  const seen = running()
  const first = commit(seen, seen, dispatch('T-01', 'harbor', 25))
  const second = commit(seen, first, dispatch('T-03', 'valley', 30))
  assert.equal(second.shipments.length, 2)
  assert.equal(second.version, seen.version + 2)
})

test('the same truck planned twice conflicts with 409', () => {
  const seen = running()
  const first = commit(seen, seen, dispatch('T-01', 'harbor', 25))
  assert.equal(
    status(() => commit(seen, first, dispatch('T-01', 'city', 20))),
    409,
  )
})

test('demand another operator already reserved conflicts with 409', () => {
  const seen = running()
  // Harbor needs 35. T-01 reserves 25, so a second 25-unit order no longer fits.
  const first = commit(seen, seen, dispatch('T-01', 'harbor', 25))
  assert.equal(
    status(() => commit(seen, first, dispatch('T-02', 'harbor', 25))),
    409,
  )
  assert.equal(commit(seen, first, dispatch('T-02', 'harbor', 10)).shipments.length, 2)
})

test('invalid cargo is a 422, not a conflict', () => {
  const s = running()
  assert.equal(
    status(() => commit(s, s, dispatch('T-01', 'harbor', 26))),
    422,
  )
  assert.equal(
    status(() => commit(s, s, dispatch('T-01', 'harbor', 1.5))),
    422,
  )
})

test('a dispatch planned before the turn advanced is stale', () => {
  const seen = running()
  const later = transition(seen, { type: 'advance' }, 'commander', 'Lead')
  assert.match(staleReason(seen, later, dispatch('T-01', 'harbor', 25)) ?? '', /Time advanced/)
})

test('a route change since planning makes a dispatch stale', () => {
  const seen = running()
  const latest = structuredClone(seen)
  latest.version++
  latest.roads.find((r) => r.id === 'east-corridor')!.blocked = true
  assert.match(staleReason(seen, latest, dispatch('T-04', 'hill', 25)) ?? '', /route/)
  // An unrelated destination keeps its route, so the order still applies.
  assert.equal(staleReason(seen, latest, dispatch('T-04', 'school', 20)), null)
})

test('clock commands need the latest version', () => {
  const seen = running()
  const latest = commit(seen, seen, dispatch('T-01', 'harbor', 25))
  assert.equal(
    status(() => commit(seen, latest, { type: 'advance' }, 'commander')),
    409,
  )
  assert.equal(commit(latest, latest, { type: 'advance' }, 'commander').tick, 1)
})
