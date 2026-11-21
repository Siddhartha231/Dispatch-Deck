/**
 * What a run's directory record carries so a scenario's leaderboard is one
 * indexed query instead of a scan: its `seed`, `phase` and a single numeric
 * `rank`. Pure; no platform imports.
 */
import type { LeaderboardResponse, RunSummary } from './protocol.ts'

export const LEADERBOARD_SIZE = 10

/** One number that orders runs by rate, then by weighted rate. Both are whole percents 0-100. */
export const rankOf = (score: Pick<RunSummary['score'], 'rate' | 'weighted'>) =>
  score.rate * 1000 + score.weighted

/**
 * The top-level directory fields written beside the summary. `seed` is left out
 * for what-if forks, which restart from a mid-run board and are not comparable
 * with a fresh run, so they never appear on a leaderboard.
 */
export function leaderboardFields(summary: RunSummary): {
  phase: string
  rank: number
  seed?: string
} {
  return {
    phase: summary.phase,
    rank: rankOf(summary.score),
    ...(summary.scenario && !summary.forkedFrom && { seed: summary.scenario.seed }),
  }
}

/** A leaderboard row for a stored summary. */
export function leaderboardEntry(s: RunSummary): LeaderboardResponse['entries'][number] {
  return {
    id: s.id,
    title: s.title,
    rate: s.score.rate,
    weighted: s.score.weighted,
    delivered: s.score.delivered,
    demand: s.score.demand,
  }
}

/** Orders rows best first (rate, then weighted, then earlier id for a stable tie) and keeps the top ten. */
export function topEntries(entries: LeaderboardResponse['entries']) {
  return [...entries]
    .sort((a, b) => b.rate - a.rate || b.weighted - a.weighted || a.id.localeCompare(b.id, 'en'))
    .slice(0, LEADERBOARD_SIZE)
}
