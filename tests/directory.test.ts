import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  membershipId,
  onlyCompleted,
  parseFeatured,
  parseStoredSummary,
  uniqueRuns,
} from '../src/domain/directory.ts'
import type { RunSummary } from '../src/domain/protocol.ts'
import { bestEffort } from '../src/server/retry.ts'

const A = 'daee90ad-fce3-4cb4-88bf-3600e3eae74a'
const B = '11111111-2222-4333-8444-555555555555'

const summary = (id: string, phase: RunSummary['phase']) =>
  ({ id, title: id, tick: 0, phase, version: 0, score: {} }) as unknown as RunSummary

test('parseFeatured keeps valid ids, trims, lowercases and de-duplicates', () => {
  assert.deepEqual(parseFeatured(` ${A.toUpperCase()}, ${B},nope,,${A}`), [A, B])
  assert.deepEqual(parseFeatured(''), [])
  assert.deepEqual(parseFeatured(undefined), [])
})

test('parseStoredSummary reads the parsed JSON the RecordRoom returns, and the raw string', () => {
  const stored = {
    id: A,
    title: 'Drill',
    tick: 12,
    phase: 'completed',
    version: 17,
    score: { demand: 140, delivered: 120, rate: 86, weighted: 88, success: true },
  }
  // A json column comes back parsed; treating it as a string silently dropped every row.
  assert.equal(parseStoredSummary(stored)?.version, 17)
  assert.equal(parseStoredSummary(JSON.stringify(stored))?.version, 17)
  assert.equal(parseStoredSummary('{not json'), null)
  assert.equal(parseStoredSummary({ ...stored, version: undefined }), null)
  assert.equal(parseStoredSummary(undefined), null)
})

test('membershipId joins uid and run id', () => {
  assert.equal(membershipId('station:x', A), `station:x:${A}`)
})

test('onlyCompleted and uniqueRuns', () => {
  const list = [summary(A, 'completed'), summary(B, 'running'), summary(A, 'completed')]
  assert.deepEqual(
    onlyCompleted(list).map((s) => s.id),
    [A, A],
  )
  assert.deepEqual(
    uniqueRuns(list).map((s) => s.id),
    [A, B],
  )
})

test('bestEffort retries then gives up without throwing', async () => {
  let calls = 0
  const errors: unknown[] = []
  assert.equal(
    await bestEffort(
      async () => {
        calls++
        if (calls < 3) throw new Error('x')
      },
      { onError: (e) => errors.push(e) },
    ),
    true,
  )
  assert.equal(calls, 3)
  assert.equal(errors.length, 0)
  assert.equal(
    await bestEffort(() => Promise.reject(new Error('down')), {
      attempts: 2,
      onError: (e) => errors.push(e),
    }),
    false,
  )
  assert.equal(errors.length, 1)
})
