import type { Note } from './protocol.ts'

/**
 * Merges a freshly fetched notes page into the notes already on screen.
 *
 * Notes carry no timestamp, so order comes from arrival: `fetched` is the
 * server's newest-first page, and anything shown that it lacks reached us over
 * the socket while the fetch was in flight, so it is newer and goes in front.
 * Merging by `recordId` (instead of replacing the array) means a note pushed
 * mid-fetch is never dropped and a note seen twice is never duplicated.
 */
export function mergeNotes(current: Note[], fetched: Note[]): Note[] {
  const known = new Set(fetched.map((n) => n.recordId))
  return [...current.filter((n) => !known.has(n.recordId)), ...fetched]
}
