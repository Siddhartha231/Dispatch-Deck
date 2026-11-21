import { DurableObject } from 'cloudflare:workers'
import { generateText, Output } from 'ai'
import { createDeepSpaceAI, DEEPSPACE_AI_DEFAULTS } from 'deepspace/worker'
import {
  DebriefNarrativeSchema,
  type DebriefFacts,
  type DebriefNarrative,
} from '../domain/protocol.ts'
import { generateVerified } from '../domain/debrief-check.ts'
import type { Env } from '../../worker'

/**
 * The after-action debrief: DispatchDeck's one paid integration.
 *
 * Why it earns its cost: the replay already records every decision, and the
 * deterministic analysis already finds idle trucks, reroutes and stranded
 * cargo. What a crew cannot easily do is connect those facts into "what we
 * should do differently". A model is good at exactly that, and it is fed
 * only the computed facts, so it has nothing to invent.
 *
 * Cost control, in layers:
 * 1. Only members of a completed run with at least one shipment can ask.
 * 2. Each run generates at most once; the result is stored in its
 *    SimulationRoom and concurrent requests share one model call.
 * 3. DebriefBudget caps generations per UTC day across the whole app.
 */
export const DEBRIEFS_PER_DAY = 40

/** DeepSpace's default model for one-shot generation. */
export const DEBRIEF_MODEL = DEEPSPACE_AI_DEFAULTS.directGeneration

const LIMITS = { headline: 160, item: 280, items: 3 }

const INSTRUCTIONS = `You review crews after a cooperative logistics training exercise.
The crew moved relief supplies from three depots to five relief sites over twelve turns,
aiming to deliver at least 80% of demand. Stock, demand, priorities and which road closes, which
depot floods and which site surges differ from scenario to scenario, so take every such detail
from the facts, never from assumption. Write a short, specific debrief from the facts provided.

Rules:
- Use only the facts given. Every number, turn and truck you mention must appear in them.
- Name trucks (T-01), sites and turns (turn 4) so the crew can find each moment in the replay.
- Credit what worked before what cost them. Be direct and constructive, not harsh.
- "headline": one sentence, under 25 words, with the outcome against the 80% target.
- "wentWell", "costUs", "nextTime": up to three short sentences each. Leave a list empty
  rather than pad it.
- Idle truck-turns, cargo still in transit at the deadline, reroute delays and flood losses
  are the main sources of lost delivery. Critical sites matter most.
- The engine has already decided what was possible. Advice in "costUs" and "nextTime" must
  come only from these checked alternatives: each idleTrucks entry's firstMove and lastMove,
  and floodReview.options. Never suggest a dispatch, truck, site, quantity or turn that is not
  listed there, and never suggest moving stock when no listed option does.
- If floodReview.avoidable is false, say the flood loss was unavoidable (you may repeat its
  reason) and give no advice about avoiding it. If it is true, the only advice allowed is its
  options; use lastChanceTurn as the final turn to act, and note "saves" is how many of the
  lost units the move would have kept (it can be less than the full loss). An option with
  "instead" set means a fuller load in place of that shipment, not an extra dispatch.
- If floodReview is absent, nothing was lost to the flood; do not mention it.`

/**
 * Calls the model through DeepSpace's AI proxy, billed to the app owner.
 *
 * Each draft is checked against the facts (src/domain/debrief-check.ts). A failing draft
 * gets one retry with the problems appended; a second failure throws, so the report shows
 * the deterministic findings without a narrative. Both calls count as one budgeted
 * generation (the budget is taken once, by the caller).
 */
export async function writeDebrief(env: Env, facts: DebriefFacts): Promise<DebriefNarrative> {
  const anthropic = createDeepSpaceAI(env, 'anthropic')
  const base = 'Facts from the run, as JSON:\n' + JSON.stringify(facts)
  return generateVerified(async (problems) => {
    const { output } = await generateText({
      model: anthropic(DEBRIEF_MODEL),
      system: INSTRUCTIONS,
      prompt: problems
        ? base +
          '\n\nYour previous draft had these errors: ' +
          problems.join('; ') +
          '. Fix them using only the facts.'
        : base,
      output: Output.object({ schema: DebriefNarrativeSchema, name: 'debrief' }),
      maxOutputTokens: 16000,
    })
    if (!output) throw new Error('The model returned no debrief.')
    return clamp(output)
  }, facts)
}

/** Enforces display limits after generation, keeping the model's schema simple. */
function clamp(n: DebriefNarrative): DebriefNarrative {
  const list = (xs: string[]) =>
    xs
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, LIMITS.items)
      .map((x) => x.slice(0, LIMITS.item))
  return {
    headline: n.headline.trim().slice(0, LIMITS.headline),
    wentWell: list(n.wentWell),
    costUs: list(n.costUs),
    nextTime: list(n.nextTime),
  }
}

/**
 * App-wide daily counter for paid debriefs. A single instance serializes
 * every request, so the cap holds under concurrency.
 */
export class DebriefBudget extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY, count INTEGER NOT NULL)',
    )
  }

  /** Reserves one debrief for today. Returns false once the day's cap is reached. */
  take(limit: number): boolean {
    const day = new Date().toISOString().slice(0, 10)
    const sql = this.ctx.storage.sql
    const used =
      sql.exec<{ count: number }>('SELECT count FROM usage WHERE day = ?', day).toArray()[0]
        ?.count ?? 0
    if (used >= limit) return false
    sql.exec('INSERT OR REPLACE INTO usage VALUES (?, ?)', day, used + 1)
    return true
  }
}
