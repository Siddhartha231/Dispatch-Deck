import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initial, availableDemand, transition, route, score } from '../src/domain/engine.ts'
const create = () => initial('test', 'Coastal Supply Crisis')
const start = () => transition(create(), { type: 'start' }, 'commander', 'Coast')
const advance = (s: ReturnType<typeof start>) =>
  transition(s, { type: 'advance' }, 'commander', 'Coast')
const send = (s: ReturnType<typeof start>, qty = 25) =>
  transition(s, { type: 'dispatch', qty, truck: 'T-01', to: 'harbor' }, 'dispatcher', 'Ridge')
test('initial quantities and protected lifecycle', () => {
  const s = create()
  assert.equal(score(s).demand, 140)
  assert.equal(
    s.sites.reduce((t, n) => t + n.stock, 0),
    150,
  )
  assert.throws(() => transition(s, { type: 'start' }, 'dispatcher', 'A'))
  assert.throws(() => send(s))
  assert.throws(() => transition(start(), { type: 'advance' }, 'observer', 'A'))
})
test('reserve stock, outstanding demand and truck in one immutable transition', () => {
  const old = start(),
    s = send(old)
  assert.equal(old.sites[0].stock, 60)
  assert.equal(s.sites[0].stock, 35)
  assert.equal(availableDemand(s, 'harbor'), 10)
  assert.throws(() => send(s))
  assert.throws(() =>
    transition(
      s,
      { type: 'dispatch', qty: 11, truck: 'T-02', to: 'harbor' },
      'dispatcher',
      'Other',
    ),
  )
  for (const qty of [0, -1, 1.5, NaN, 26]) assert.throws(() => send(old, qty))
})
test('scheduled arrival and return remain consistent across a road closure', () => {
  const before = advance(start()),
    s = transition(
      before,
      { type: 'dispatch', qty: 25, truck: 'T-04', to: 'hill' },
      'commander',
      'Coast',
    )
  // T-04 leaves on turn 1 and reaches Hill Hospital on turn 2, the turn the
  // east corridor closes, so it drives home the long way: 4 turns.
  const arrived = advance(s)
  assert.equal(arrived.fleet[3].status, 'returning')
  assert.equal(arrived.shipments[0].delivered, true)
  assert.equal(route(arrived.roads, 'east', 'hill')?.cost, 4)
  assert.equal(arrived.fleet[3].readyAt, 6)
  let later = arrived
  for (let turn = 3; turn < 6; turn++) later = advance(later)
  assert.equal(later.fleet[3].status, 'returning')
  assert.equal(advance(later).fleet[3].status, 'ready')
})
test('every site stays reachable from every depot after all closures', () => {
  let s = start()
  for (let i = 0; i < 11; i++) s = advance(s)
  for (const depot of s.sites.filter((n) => n.kind === 'depot'))
    for (const site of s.sites)
      assert.ok(route(s.roads, depot.id, site.id), depot.id + '→' + site.id)
})
test('Dijkstra honors blocked edges, deterministic ties, and disconnection', () => {
  const roads = [
    ['a', 's', 'x'],
    ['b', 'x', 't'],
    ['c', 's', 'y'],
    ['d', 'y', 't'],
  ].map(([id, a, b]) => ({ id, a, b, cost: 1, blocked: false }))
  assert.deepEqual(route(roads.reverse(), 's', 't')?.edges, ['a', 'b'])
  assert.equal(route(roads, 's', 'z'), null)
})
test('all disruptions occur once, turn twelve freezes score and state', () => {
  let s = send(start())
  for (let i = 0; i < 12; i++) s = advance(s)
  assert.equal(s.phase, 'completed')
  assert.equal(s.log.filter((e) => e.kind === 'alert').length, 3)
  assert.equal(s.sites.find((n) => n.id === 'east')?.stock, 30)
  assert.deepEqual(score(s), { demand: 150, delivered: 25, rate: 17, weighted: 23, success: false })
  assert.throws(() => advance(s))
})
test('command replay yields the same state and event sequence', () => {
  const a = advance(send(start())),
    b = advance(send(start()))
  assert.deepEqual(a, b)
  assert.deepEqual(
    a.log.map((e) => e.seq),
    [1, 2, 3],
  )
})
