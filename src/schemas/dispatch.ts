import type { CollectionSchema } from 'deepspace/schema'

/**
 * Every collection here denies every client role. Browsers never read or write them
 * directly; the Worker checks identity and membership, then writes as a
 * trusted app action (src/server/records.ts).
 */
const closed = { read: false, create: false, update: false, delete: false }
const permissions = { '*': closed, viewer: closed, member: closed, admin: closed }

/** The operations directory. One record per run, keyed by the run id. */
export const runs: CollectionSchema = {
  name: 'runs',
  permissions,
  columns: [
    { name: 'title', storage: 'text', interpretation: 'plain', required: true, maxLength: 56 },
    // The latest RunSummary as JSON, refreshed after each committed command, so
    // listing the directory is one query instead of one Durable Object call per run.
    { name: 'summary', storage: 'text', interpretation: 'json', maxLength: 2000 },
    // Leaderboard index (src/domain/leaderboard.ts): filter on seed and phase, order by rank.
    // `seed` is unset on what-if forks, so they are never ranked.
    { name: 'seed', storage: 'text', interpretation: 'plain', maxLength: 32 },
    { name: 'phase', storage: 'text', interpretation: 'plain', maxLength: 16 },
    { name: 'rank', storage: 'number', interpretation: 'plain' },
  ],
}

/** Crew notes, stored in one RecordRoom scope per run (`notes:<runId>`). */
export const notes: CollectionSchema = {
  name: 'notes',
  permissions,
  columns: [
    { name: 'text', storage: 'text', interpretation: 'plain', required: true, maxLength: 280 },
    { name: 'author', storage: 'text', interpretation: 'plain', required: true, maxLength: 60 },
  ],
}

/**
 * Who belongs to which run, in the directory scope. One record per operator and
 * run (recordId `<uid>:<runId>`) so "Your operations" is one query filtered on
 * `uid`. Written by the Worker when a run is created, forked or joined.
 */
export const memberships: CollectionSchema = {
  name: 'memberships',
  permissions,
  columns: [
    { name: 'uid', storage: 'text', interpretation: 'plain', required: true, maxLength: 80 },
    { name: 'runId', storage: 'text', interpretation: 'plain', required: true, maxLength: 40 },
    { name: 'role', storage: 'text', interpretation: 'plain', required: true, maxLength: 20 },
    { name: 'joinedAt', storage: 'text', interpretation: 'plain', required: true, maxLength: 40 },
  ],
}
