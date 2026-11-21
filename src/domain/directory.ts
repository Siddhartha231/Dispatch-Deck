import { RunIdSchema, RunSummarySchema, type RunSummary } from './protocol.ts'

/**
 * Reads the `summary` field of a directory record. The column is declared as
 * JSON, so the RecordRoom hands it back already parsed; older code paths and
 * tests may still see the raw string. Anything malformed or pre-versioned is
 * null, so the caller can fall back to the run's own room.
 */
export function parseStoredSummary(value: unknown): RunSummary | null {
  let candidate = value
  if (typeof value === 'string') {
    try {
      candidate = JSON.parse(value)
    } catch {
      return null
    }
  }
  const parsed = RunSummarySchema.safeParse(candidate)
  return parsed.success ? parsed.data : null
}

/** Most featured replays the directory will list. */
export const FEATURED_LIMIT = 6

/** Parses the comma-separated `FEATURED_RUNS` setting: valid run ids only, no repeats. */
export function parseFeatured(raw: string | undefined): string[] {
  const ids = (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => RunIdSchema.safeParse(s).success)
  return [...new Set(ids)].slice(0, FEATURED_LIMIT)
}

/** The record id of one operator's membership in one run. */
export const membershipId = (uid: string, runId: string) => `${uid}:${runId}`

/** Featured replays are completed runs only, in the configured order. */
export const onlyCompleted = (summaries: RunSummary[]) =>
  summaries.filter((s) => s.phase === 'completed')

/** Drops repeated runs, keeping the first (newest) occurrence. */
export function uniqueRuns(summaries: RunSummary[]): RunSummary[] {
  const seen = new Set<string>()
  return summaries.filter((s) => !seen.has(s.id) && !!seen.add(s.id))
}
