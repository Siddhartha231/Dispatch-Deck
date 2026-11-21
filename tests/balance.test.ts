import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initial, score } from '../src/domain/engine.ts'
import { greedyRun } from '../src/domain/greedy.ts'

/**
 * The reference greedy crew (src/domain/greedy.ts): each turn, every ready
 * truck carries what it can to the highest-priority open demand it can reach
 * before the deadline. If this cannot reach the target, the classic scenario is
 * too hard for real players. Seeded scenarios are checked in scenario.test.ts.
 */
test('a straightforward greedy crew can meet the 80% target', () => {
  const result = score(greedyRun(initial('g', 'Greedy')))
  assert.equal(result.success, true, JSON.stringify(result))
})

test('the target is not trivially exceeded by the greedy crew', () => {
  // Leave room for better coordination to matter.
  assert.ok(score(greedyRun(initial('g', 'Greedy'))).rate < 100)
})
