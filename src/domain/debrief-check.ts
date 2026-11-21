/**
 * Deterministic verification of the AI debrief against the facts it was written from.
 *
 * The prompt asks the model to use only the facts and only the engine-checked moves. This
 * file enforces that in code: it extracts the trucks, shipments, turns, site names and
 * numbers a narrative mentions and rejects anything the facts do not support. Pure, like
 * the rest of src/domain, so it runs in the Worker and in the tests.
 *
 * What is checked, per sentence of headline / wentWell / costUs / nextTime:
 * - Every truck (T-01) and shipment (S-01) id appears in the facts.
 * - Every turn ("turn 4", "turns 2-3", "turn two", "turns 1, 2 and 3") is a turn the facts
 *   mention (idle turns, move turns and arrivals, timeline turns, final turn, ...). Ranges
 *   are checked at their endpoints.
 * - Every capitalised site/depot name ("North Hub") is a name the facts use.
 * - Every number is one the facts contain or a simple derivation of them (see NUMBERS).
 * - A recommendation (see isRecommendation) that names a move turn must match a checked
 *   move: for a named truck, its idleTrucks firstMove/lastMove turn or a floodReview option
 *   turn for that truck. With several trucks named, the turn may match any of them; with no
 *   truck named, any checked move turn. Turns introduced by by/before/until/after/during/...
 *   or followed by flood/alert/closure words are time references, not move turns.
 * - Advice about moving stock out of the flood (or out of the flooded depot, named by
 *   floodReview.depot) is rejected unless floodReview.avoidable is
 *   true (sentences that say the loss was unavoidable/impossible are fine).
 *
 * NUMBERS: a bare number must be a number that appears anywhere in the facts (including
 * in timeline and reason text), or one of: the exercise constants 3 (depots), 5 (sites),
 * 12 (turns), 80 (target), 100 (true for every scenario; stock, demand, priorities, truck
 * homes and disruptions vary by seed and are checked against the facts); total unmet units; total idle truck-turns and each truck's;
 * the count of idle trucks; sums of in-transit units, reroute delay turns, flood loss plus
 * lost units; per-priority delivered/demand/unmet sums. A percentage must be the score
 * rate, weighted rate or target, 100 minus the rate, the gap between rate and target, or a
 * ratio of two fact numbers shown on the report: per-site delivered/demand and unmet/demand,
 * total unmet/demand, flood loss/demand and in-transit/demand (each rounded, floored or
 * ceilinged). Small counts (1-5) followed by a thing noun ("2 trucks", "3 sites") are
 * accepted without being in the facts, because prose counts are hard to verify without
 * false positives; counts of units are always checked.
 *
 * Known gaps (kept lenient on purpose): spelled-out numbers other than turns, claims about
 * who or what caused an event, and whether the headline's pass/fail wording matches the score.
 */
import type { DebriefFacts, DebriefNarrative } from './protocol.ts'

export type CheckResult = { ok: true } | { ok: false; problems: string[] }

const WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
]
const NUM = `(?:\\d+|${WORDS.join('|')})`
const toInt = (s: string) => {
  const i = WORDS.indexOf(s.toLowerCase())
  return i >= 0 ? i : Number(s)
}

type TurnRef = { turns: number[]; ends: number[]; start: number; end: number; text: string }

/** Finds "turn 4", "turns 2-3", "turn two to three", "turns 1, 2 and 3". */
export function extractTurns(text: string): TurnRef[] {
  const out: TurnRef[] = []
  const list = new RegExp(
    `\\bturns?[\\s-]+(${NUM}(?:\\s*,\\s*${NUM})*,?\\s+and\\s+${NUM})(?![\\w%])(?!\\s*(?:%|percent|units?|trucks?|sites?|shipments?))`,
    'gi',
  )
  const simple = new RegExp(
    `\\bturns?[\\s-]+(${NUM})(?:\\s*(-|–|—|to|through|thru|and|&)\\s*(${NUM})(?![\\w%])(?!\\s*(?:%|percent|units?|trucks?|sites?|shipments?)))?`,
    'gi',
  )
  const taken: [number, number][] = []
  const overlaps = (a: number, b: number) => taken.some(([x, y]) => a < y && b > x)
  for (const m of text.matchAll(list)) {
    const nums = [...m[1].matchAll(new RegExp(NUM, 'gi'))].map((x) => toInt(x[0]))
    out.push({ turns: nums, ends: nums, start: m.index, end: m.index + m[0].length, text: m[0] })
    taken.push([m.index, m.index + m[0].length])
  }
  for (const m of text.matchAll(simple)) {
    if (overlaps(m.index, m.index + m[0].length)) continue
    const a = toInt(m[1])
    if (m[3] === undefined) {
      out.push({ turns: [a], ends: [a], start: m.index, end: m.index + m[0].length, text: m[0] })
      continue
    }
    const b = toInt(m[3])
    const range = ['-', '–', '—', 'to', 'through', 'thru'].includes(m[2].toLowerCase())
    const turns = range && b >= a ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a, b]
    out.push({ turns, ends: [a, b], start: m.index, end: m.index + m[0].length, text: m[0] })
  }
  return out.sort((x, y) => x.start - y.start)
}

type Universe = {
  trucks: Set<string>
  shipments: Set<string>
  turns: Set<number>
  names: string[]
  numbers: Set<number>
  percents: Set<number>
  /** Checked move turns per truck: idle first/last move and flood options. */
  moves: Map<string, Set<number>>
  allMoveTurns: Set<number>
}

const pcts = (n: number, d: number) =>
  d > 0 ? [Math.round((100 * n) / d), Math.floor((100 * n) / d), Math.ceil((100 * n) / d)] : []

/** Everything the facts support: valid trucks, turns, names, numbers and checked moves. */
export function universe(facts: DebriefFacts): Universe {
  const json = JSON.stringify(facts)
  const trucks = new Set(json.match(/\bT-\d\d\b/g) ?? [])
  const shipments = new Set(json.match(/\bS-\d\d\b/g) ?? [])

  const names = new Set<string>()
  for (const s of facts.sites) names.add(s.name)
  for (const t of facts.idleTrucks) {
    names.add(t.depot)
    if (t.firstMove) names.add(t.firstMove.to)
    if (t.lastMove) names.add(t.lastMove.to)
  }
  for (const x of facts.inTransitAtClose) names.add(x.to)
  for (const x of facts.rerouted) names.add(x.to)
  if (facts.floodReview?.depot) names.add(facts.floodReview.depot)
  for (const o of facts.floodReview?.options ?? []) {
    names.add(o.from)
    names.add(o.to)
  }

  const numbers = new Set<number>([0, 3, 5, 12, 80, 100, facts.target])
  const addText = (s: string) => {
    for (const m of s.replace(/(\d),(\d)/g, '$1$2').matchAll(/\d+(?:\.\d+)?/g))
      numbers.add(Number(m[0]))
  }
  const turns = new Set<number>([facts.finalTurn])
  if (facts.firstDispatchTurn !== null) turns.add(facts.firstDispatchTurn)
  const addTurnsFromText = (s: string) => {
    for (const r of extractTurns(s)) for (const t of r.turns) turns.add(t)
  }

  const moves = new Map<string, Set<number>>()
  const allMoveTurns = new Set<number>()
  const addMove = (truck: string, turn: number) => {
    if (!moves.has(truck)) moves.set(truck, new Set())
    moves.get(truck)!.add(turn)
    allMoveTurns.add(turn)
    turns.add(turn)
  }

  for (const t of facts.idleTrucks) {
    for (const x of t.turns) turns.add(x)
    numbers.add(t.turns.length)
    for (const m of [t.firstMove, t.lastMove]) {
      if (!m) continue
      addMove(t.truck, m.turn)
      turns.add(m.arrival)
    }
    if (!t.firstMove && !t.lastMove) for (const x of t.turns) addMove(t.truck, x)
  }
  const review = facts.floodReview
  if (review) {
    if (review.lastChanceTurn !== null) turns.add(review.lastChanceTurn)
    for (const o of review.options) {
      addMove(o.truck, o.turn)
      turns.add(o.arrival)
    }
    if (review.reason) addTurnsFromText(review.reason)
  }
  for (const x of facts.inTransitAtClose) turns.add(x.arrival)
  for (const e of facts.timeline) {
    turns.add(e.turn)
    addTurnsFromText(e.text)
    for (const m of e.text.matchAll(NAME_RE)) names.add(m[0])
  }

  // Every number that appears in the facts, as written.
  addText(json)

  // Derived numbers.
  const sc = facts.score
  const unmetTotal = sc.demand - sc.delivered
  const inTransit = facts.inTransitAtClose.reduce((t, x) => t + x.qty, 0)
  const idleTotal = facts.idleTrucks.reduce((t, x) => t + x.turns.length, 0)
  const reroutedTotal = facts.rerouted.reduce((t, x) => t + x.extraTurns, 0)
  for (const n of [
    unmetTotal,
    inTransit,
    idleTotal,
    reroutedTotal,
    facts.idleTrucks.length,
    facts.inTransitAtClose.length,
    facts.rerouted.length,
    facts.floodLoss + unmetTotal,
    sc.delivered + inTransit,
  ])
    numbers.add(n)
  const byPriority = new Map<string, { delivered: number; demand: number; unmet: number }>()
  for (const s of facts.sites) {
    const g = byPriority.get(s.priority) ?? { delivered: 0, demand: 0, unmet: 0 }
    g.delivered += s.delivered
    g.demand += s.demand
    g.unmet += s.unmet
    byPriority.set(s.priority, g)
  }
  for (const g of byPriority.values())
    for (const n of [g.delivered, g.demand, g.unmet]) numbers.add(n)

  const percents = new Set<number>([
    sc.rate,
    sc.weighted,
    facts.target,
    100 - sc.rate,
    Math.abs(facts.target - sc.rate),
    Math.abs(facts.target - sc.weighted),
    100,
  ])
  for (const s of facts.sites) {
    for (const p of [...pcts(s.delivered, s.demand), ...pcts(s.unmet, s.demand)]) percents.add(p)
  }
  for (const g of byPriority.values()) {
    for (const p of [...pcts(g.delivered, g.demand), ...pcts(g.unmet, g.demand)]) percents.add(p)
  }
  for (const n of [unmetTotal, facts.floodLoss, inTransit])
    for (const p of pcts(n, sc.demand)) percents.add(p)

  return {
    trucks,
    shipments,
    turns,
    names: [...names],
    numbers,
    percents,
    moves,
    allMoveTurns,
  }
}

const NAME_TYPES =
  'Hub|Clinic|Hospital|Center|Centre|Depot|Shelter|Station|Warehouse|Port|Camp|School|Harbor|Harbour|Relief'
const NAME_RE = new RegExp(
  `\\b(?:[A-Z][a-z]+\\s+)+(?:${NAME_TYPES})(?:\\s+(?:${NAME_TYPES}))*\\b`,
  'g',
)

function knownName(candidate: string, names: string[]) {
  const words = candidate.split(/\s+/)
  const lower = names.map((n) => n.toLowerCase())
  // Try the whole phrase, then drop leading words ("Send North Hub"), keeping at least two.
  for (let i = 0; i + 2 <= words.length; i++) {
    const part = words.slice(i).join(' ').toLowerCase()
    if (lower.some((n) => n.includes(part) || part.includes(n))) return true
  }
  return false
}

const RECOMMEND =
  /\b(should|shouldn't|could have|could've|would have|next time|instead|consider|must|need to|ought|try to|plan to|aim to|let [A-Z])\b|^\s*(?:and |then |also )?(?:send|dispatch|move|hold|load|keep|use|release|ship|stage|pre-?position|start|get|clear|empty|evacuate|have)\b/i

const UNAVOIDABLE =
  /\b(unavoidable|inevitable|impossible|could not|couldn't|cannot|can't|unable|not possible|wasn't possible|was not possible|no (?:option|move|truck|way|dispatch|stock)|nothing)\b/i
const FLOOD_ADVICE_VERB =
  /\b(mov\w*|evacuat\w*|clear\w*|empt\w*|relocat\w*|dispatch\w*|send\w*|sent|ship\w*|pull\w*|sav\w*|protect\w*|prevent\w*|avoid\w*|stag\w*|drain\w*|offload\w*|rescu\w*|haul\w*|load\w*)\b/i
const TIME_BEFORE =
  /\b(by|before|until|till|after|since|during|when|through|arriv\w*|at|from)\s*$|\b(?:flood\w*|alerts?|clos\w*|deadline)\W+(?:\w+\W+){0,2}$/i
const TIME_AFTER = /^\s*(?:\w+\s+)?(?:flood\w*|alerts?|clos\w*|deadline|hit|struck|strikes)\b/i

/** Whether a sentence recommends an action rather than describing what happened. */
function isRecommendation(sentence: string, section: string) {
  if (section === 'nextTime') return true
  if (section !== 'costUs') return false
  return RECOMMEND.test(sentence)
}

function sentences(text: string) {
  return text
    .split(/(?<=[.!?;])\s+(?=[A-Z"'(])/)
    .map((s) => s.trim())
    .filter(Boolean)
}

const THING =
  '(?:trucks?|sites?|depots?|shipments?|dispatch(?:es)?|options?|moves?|times?|steps?|turns?)'

/** Checks one sentence; returns the problems found. */
function checkSentence(
  sentence: string,
  section: string,
  u: Universe,
  facts: DebriefFacts,
): string[] {
  const problems: string[] = []
  const tag = (msg: string) => `${section}: ${msg} (in "${sentence}")`

  const trucks = [...new Set(sentence.match(/\bT-\d\d\b/g) ?? [])]
  for (const t of trucks) if (!u.trucks.has(t)) problems.push(tag(`truck ${t} is not in the facts`))
  for (const s of new Set(sentence.match(/\bS-\d\d\b/g) ?? []))
    if (!u.shipments.has(s)) problems.push(tag(`shipment ${s} is not in the facts`))

  for (const m of sentence.matchAll(NAME_RE)) {
    if (!knownName(m[0], u.names))
      problems.push(tag(`"${m[0]}" is not a site or depot in the facts`))
  }

  const refs = extractTurns(sentence)
  for (const r of refs)
    for (const t of r.ends)
      if (!u.turns.has(t)) problems.push(tag(`turn ${t} does not appear in the facts`))

  // Numbers, after removing ids and turn references.
  let rest = sentence
  const blank = (a: number, b: number) => {
    rest = rest.slice(0, a) + ' '.repeat(b - a) + rest.slice(b)
  }
  for (const r of refs) blank(r.start, r.end)
  for (const m of sentence.matchAll(/\b[TS]-\d\d\b/g)) blank(m.index, m.index + m[0].length)
  rest = rest.replace(/(\d),(\d)/g, '$1$2')
  for (const m of rest.matchAll(/(\d+(?:\.\d+)?)(\s*%|\s+percent|\s+per cent)?/gi)) {
    const n = Number(m[1])
    if (m[2]) {
      if (!u.percents.has(n) && !u.percents.has(Math.round(n)))
        problems.push(tag(`${m[1]}% is not a figure the facts support`))
      continue
    }
    if (u.numbers.has(n)) continue
    const after = rest.slice(m.index + m[0].length)
    if (Number.isInteger(n) && n >= 1 && n <= 5 && new RegExp(`^\\s+${THING}\\b`, 'i').test(after))
      continue
    problems.push(tag(`the number ${m[1]} does not appear in the facts`))
  }

  if (!isRecommendation(sentence, section)) return problems

  // Recommended move turns must match a checked move.
  const moveTurns = refs.flatMap((r) => {
    const before = sentence.slice(0, r.start)
    const after = sentence.slice(r.end)
    if (TIME_BEFORE.test(before) || TIME_AFTER.test(after)) return []
    return r.ends
  })
  const feasible =
    trucks.length > 0 ? new Set(trucks.flatMap((t) => [...(u.moves.get(t) ?? [])])) : u.allMoveTurns
  for (const t of new Set(moveTurns)) {
    if (!feasible.has(t))
      problems.push(
        tag(
          trucks.length
            ? `advice to act on turn ${t} with ${trucks.join('/')} is not a checked move`
            : `advice to act on turn ${t} is not a checked move`,
        ),
      )
  }
  if (trucks.length && !moveTurns.length && !u.allMoveTurns.size)
    problems.push(tag('advice names a truck but the facts list no checked move'))

  // Flood advice only when the engine found it avoidable.
  const depot = facts.floodReview?.depot ?? 'East Hub'
  const floodAdvice =
    (/\bflood\w*/i.test(sentence) || sentence.toLowerCase().includes(depot.toLowerCase())) &&
    FLOOD_ADVICE_VERB.test(sentence) &&
    !UNAVOIDABLE.test(sentence)
  if (floodAdvice && facts.floodReview?.avoidable !== true)
    problems.push(
      tag(
        facts.floodReview
          ? `advises moving ${depot} stock, but the flood loss was unavoidable`
          : 'advises about the flood, but nothing was lost to it',
      ),
    )
  return problems
}

/** Verifies a debrief narrative against the facts it was written from. */
export function checkDebrief(narrative: DebriefNarrative, facts: DebriefFacts): CheckResult {
  const u = universe(facts)
  const problems: string[] = []
  const sections: [string, string[]][] = [
    ['headline', [narrative.headline]],
    ['wentWell', narrative.wentWell],
    ['costUs', narrative.costUs],
    ['nextTime', narrative.nextTime],
  ]
  for (const [section, items] of sections)
    for (const item of items)
      for (const s of sentences(item)) problems.push(...checkSentence(s, section, u, facts))
  const unique = [...new Set(problems)]
  return unique.length ? { ok: false, problems: unique } : { ok: true }
}

export const WITHHELD_MESSAGE =
  'The debrief was withheld because it could not be verified against the replay.'

/** Thrown when two drafts in a row failed verification. */
export class UnverifiedDebriefError extends Error {
  problems: string[]
  constructor(problems: string[]) {
    super(WITHHELD_MESSAGE)
    this.name = 'UnverifiedDebriefError'
    this.problems = problems
  }
}

/**
 * Generates a draft, verifies it, and retries once with the problems as feedback. At most
 * two calls to `generate`. `generate(null)` is the first draft; `generate(problems)` the
 * second. Errors from `generate` propagate unchanged and are not retried.
 */
export async function generateVerified(
  generate: (previousProblems: string[] | null) => Promise<DebriefNarrative>,
  facts: DebriefFacts,
  warn: (...args: unknown[]) => void = console.warn,
): Promise<DebriefNarrative> {
  const first = await generate(null)
  const a = checkDebrief(first, facts)
  if (a.ok) return first
  warn('Debrief draft 1 failed verification:', a.problems)
  const second = await generate(a.problems)
  const b = checkDebrief(second, facts)
  if (b.ok) return second
  warn('Debrief draft 2 failed verification:', b.problems)
  throw new UnverifiedDebriefError(b.problems)
}
