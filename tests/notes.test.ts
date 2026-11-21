import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeNotes } from '../src/domain/notes.ts'

const note = (recordId: string) => ({ recordId, data: { text: recordId, author: 'A' } })
const ids = (notes: { recordId: string }[]) => notes.map((n) => n.recordId)

test('mergeNotes keeps a note that arrived mid-fetch, newest first', () => {
  const merged = mergeNotes([note('live')], [note('b'), note('a')])
  assert.deepEqual(ids(merged), ['live', 'b', 'a'])
})

test('mergeNotes adds notes missed while offline and never duplicates', () => {
  const merged = mergeNotes([note('a')], [note('c'), note('b'), note('a')])
  assert.deepEqual(ids(merged), ['c', 'b', 'a'])
})

test('mergeNotes with nothing on screen returns the fetched page', () => {
  assert.deepEqual(ids(mergeNotes([], [note('b'), note('a')])), ['b', 'a'])
})
