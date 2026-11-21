import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPublisher } from '../src/server/publisher.ts'

type Snap = { version: number }

/** A fake store whose writes complete only when the test releases them. */
function fakeStore() {
  const written: number[] = []
  const inflight: { snap: Snap; release: () => void; fail: () => void }[] = []
  let concurrent = 0
  let maxConcurrent = 0
  const write = (snap: Snap) =>
    new Promise<void>((resolve, reject) => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      inflight.push({
        snap,
        release: () => {
          concurrent--
          written.push(snap.version)
          resolve()
        },
        fail: () => {
          concurrent--
          reject(new Error('down'))
        },
      })
    })
  return { write, written, inflight, max: () => maxConcurrent }
}

const tick = () => new Promise((r) => setImmediate(r))

test('never overlaps writes and ends on the newest version', async () => {
  const store = fakeStore()
  const p = createPublisher<Snap>(store.write)
  const done = [1, 2, 3, 4].map((version) => p.submit({ version }))
  await tick()
  assert.equal(store.inflight.length, 1)
  assert.equal(store.inflight[0]!.snap.version, 1)
  store.inflight[0]!.release()
  await tick()
  // 2 and 3 were superseded while 1 was in flight.
  assert.equal(store.inflight.length, 2)
  assert.equal(store.inflight[1]!.snap.version, 4)
  store.inflight[1]!.release()
  await Promise.all(done)
  assert.deepEqual(store.written, [1, 4])
  assert.equal(store.max(), 1)
  assert.equal(p.published(), 4)
})

test('out-of-order submissions never move the store backwards', async () => {
  const store = fakeStore()
  const p = createPublisher<Snap>(store.write)
  const first = p.submit({ version: 5 })
  await tick()
  void p.submit({ version: 7 })
  void p.submit({ version: 6 })
  void p.submit({ version: 3 })
  store.inflight[0]!.release()
  await tick()
  assert.equal(store.inflight[1]!.snap.version, 7)
  store.inflight[1]!.release()
  await first
  await p.submit({ version: 6 })
  await p.submit({ version: 7 })
  assert.deepEqual(store.written, [5, 7])
  for (let i = 1; i < store.written.length; i++)
    assert.ok(store.written[i]! > store.written[i - 1]!)
})

test('a failed write is retried, reported once, and can be resubmitted', async () => {
  const store = fakeStore()
  const errors: unknown[] = []
  const p = createPublisher<Snap>(store.write, { attempts: 2, onError: (e) => errors.push(e) })
  const done = p.submit({ version: 1 })
  await tick()
  store.inflight[0]!.fail()
  await tick()
  assert.equal(store.inflight.length, 2)
  store.inflight[1]!.fail()
  await done
  assert.equal(errors.length, 1)
  assert.equal(p.published(), -1)
  const retry = p.submit({ version: 1 })
  await tick()
  store.inflight[2]!.release()
  await retry
  assert.deepEqual(store.written, [1])
})
