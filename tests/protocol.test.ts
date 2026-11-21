import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initial, transition } from '../src/domain/engine.ts'
import {
  CommandSchema,
  CreateRunRequestSchema,
  EnvelopeSchema,
  NoteRequestSchema,
  RunSchema,
  ServerMessageSchema,
  StationRequestSchema,
} from '../src/domain/protocol.ts'

test('engine boards satisfy the wire schema', () => {
  const start = transition(initial('t', 'Test'), { type: 'start' }, 'commander', 'Lead')
  const moved = transition(
    start,
    { type: 'dispatch', truck: 'T-01', to: 'harbor', qty: 25 },
    'dispatcher',
    'Ridge',
  )
  for (const s of [initial('t', 'Test'), start, moved])
    assert.equal(RunSchema.safeParse(s).success, true)
})

test('envelopes need a well-formed key, a version and a known command', () => {
  const key = crypto.randomUUID()
  assert.equal(
    EnvelopeSchema.safeParse({ key, version: 0, command: { type: 'start' } }).success,
    true,
  )
  assert.equal(
    EnvelopeSchema.safeParse({ key: 'short', version: 0, command: { type: 'start' } }).success,
    false,
  )
  assert.equal(
    EnvelopeSchema.safeParse({ key, version: -1, command: { type: 'start' } }).success,
    false,
  )
  assert.equal(
    EnvelopeSchema.safeParse({ key, version: 0, command: { type: 'teleport' } }).success,
    false,
  )
  assert.equal(EnvelopeSchema.safeParse({ key, version: 0 }).success, false)
})

test('dispatch commands need a truck, destination and numeric cargo', () => {
  assert.equal(
    CommandSchema.safeParse({ type: 'dispatch', truck: 'T-01', to: 'harbor', qty: 5 }).success,
    true,
  )
  assert.equal(
    CommandSchema.safeParse({ type: 'dispatch', truck: 'T-01', to: 'harbor', qty: '5' }).success,
    false,
  )
  assert.equal(CommandSchema.safeParse({ type: 'dispatch', truck: 'T-01', qty: 5 }).success, false)
})

test('request bodies trim and bound user text', () => {
  assert.deepEqual(NoteRequestSchema.parse({ text: '  On it.  ' }), { text: 'On it.' })
  assert.equal(NoteRequestSchema.safeParse({ text: '   ' }).success, false)
  assert.equal(NoteRequestSchema.safeParse({ text: 'x'.repeat(281) }).success, false)
  assert.equal(StationRequestSchema.safeParse({ name: 'Coast Runner' }).success, true)
  assert.equal(StationRequestSchema.safeParse({ name: '<script>' }).success, false)
  assert.equal(
    CreateRunRequestSchema.safeParse({ id: 'not-a-uuid', title: 'Drill' }).success,
    false,
  )
})

test('socket messages are a closed set', () => {
  const note = { recordId: 'n1', data: { text: 'Hi', author: 'Ridge' } }
  assert.equal(ServerMessageSchema.safeParse({ type: 'note', note }).success, true)
  assert.equal(ServerMessageSchema.safeParse({ type: 'presence', peers: ['A'] }).success, true)
  assert.equal(ServerMessageSchema.safeParse({ type: 'notes' }).success, false)
})
