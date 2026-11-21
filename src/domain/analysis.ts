/**
 * After-action analysis. Turns a run's replay frames into facts a reviewer
 * (or a model) can reason about. Pure and deterministic, like the engine, so
 * the same run always yields the same facts.
 *
 * Every "you could have done X" claim here is checked by asking the engine
 * (`transition`) whether X was legal on that board, so the advice cannot drift
 * from the rules. The model only explains what this file decides.
 */
import { availableDemand, initial, route, score, transition } from './engine.ts'
import type { DebriefFacts, Run, Shipment } from './protocol.ts'
import { disruptionsOf } from './scenario.ts'

export const TARGET_PERCENT = 80
const DEADLINE = 12
const PRIORITY = ['standard', 'standard', 'high', 'critical'] as const

/** The board as it stood when the commander ended each turn (the last frame of each tick). */
function endOfTurn(history: Run[]) {
  const byTick = new Map<number, Run>()
  for (const frame of history) byTick.set(frame.tick, frame)
  return byTick
}

type Move = { turn: number; to: string; qty: number; arrival: number; priority: number }

/**
 * Every dispatch `truckId` could legally make on this board: the largest load
 * the truck, its depot and the site's open demand allow, accepted by the
 * engine and arriving by the deadline.
 */
function feasibleMoves(s: Run, truckId: string): Move[] {
  const truck = s.fleet.find((v) => v.id === truckId)
  const depot = truck && s.sites.find((n) => n.id === truck.home)
  if (!truck || !depot || s.phase !== 'running' || truck.status !== 'ready') return []
  const moves: Move[] = []
  for (const site of s.sites) {
    if (site.kind !== 'relief') continue
    const qty = Math.min(truck.capacity, depot.stock, availableDemand(s, site.id))
    if (qty < 1) continue
    let after: Run
    try {
      after = transition(
        s,
        { type: 'dispatch', truck: truckId, to: site.id, qty },
        'dispatcher',
        '',
      )
    } catch {
      continue
    }
    const shipment = after.shipments[after.shipments.length - 1]
    if (shipment.arrival > DEADLINE) continue
    moves.push({
      turn: s.tick,
      to: site.id,
      qty,
      arrival: shipment.arrival,
      priority: site.priority,
    })
  }
  return moves
}

const tiebreak = (a: Move, b: Move) => a.arrival - b.arrival || a.to.localeCompare(b.to, 'en')

/** Most useful first for an idle truck: critical sites, then bigger loads, then sooner arrival. */
const byUsefulness = (a: Move, b: Move) =>
  b.priority - a.priority || b.qty - a.qty || tiebreak(a, b)

/** Most stock moved first: what matters when the aim is to empty a depot before the flood. */
const byVolume = (a: Move, b: Move) => b.qty - a.qty || b.priority - a.priority || tiebreak(a, b)

/** [1, 2, 3, 5] as "1-3, 5". */
function ranges(turns: number[]) {
  const parts: string[] = []
  for (let i = 0; i < turns.length; i++) {
    let j = i
    while (j + 1 < turns.length && turns[j + 1] === turns[j] + 1) j++
    parts.push(i === j ? String(turns[i]) : `${turns[i]}-${turns[j]}`)
    i = j
  }
  return parts.join(', ')
}

type FloodReview = NonNullable<DebriefFacts['floodReview']>

/**
 * Whether the flood loss could have been avoided. Only trucks homed at the
 * flooded depot can load its stock, so for every turn before the flood we ask
 * the engine what those trucks could have dispatched. An option is listed only if it
 * would have kept stock out of the flood.
 */
function reviewFlood(
  history: Run[],
  turns: Map<number, Run>,
  lost: number,
  name: (id: string) => string,
  flood: { site: string; turn: number },
): FloodReview {
  const final = history[history.length - 1]
  const trucks = final.fleet.filter((t) => t.home === flood.site)
  const options: FloodReview['options'] = []

  // Extra dispatches: a truck that was ready at the end of a turn and was not used.
  for (let turn = 0; turn < flood.turn; turn++) {
    const frame = turns.get(turn)
    if (!frame) continue
    for (const truck of trucks) {
      const move = feasibleMoves(frame, truck.id).sort(byVolume)[0]
      if (move)
        options.push({
          turn,
          truck: truck.id,
          from: name(flood.site),
          to: name(move.to),
          qty: move.qty,
          arrival: move.arrival,
          saves: Math.min(lost, move.qty),
          instead: null,
        })
    }
  }

  // Fuller loads: a dispatch from the flooded depot that left with less than the engine would have allowed.
  for (const sh of final.shipments) {
    if (sh.from !== flood.site || sh.departure >= flood.turn) continue
    const at = history.findIndex((f) => f.shipments.some((x) => x.id === sh.id))
    const before = history[at - 1]
    if (!before) continue
    const better = feasibleMoves(before, sh.truck).sort(byVolume)[0]
    if (better && better.qty > sh.qty)
      options.push({
        turn: sh.departure,
        truck: sh.truck,
        from: name(flood.site),
        to: name(better.to),
        qty: better.qty,
        arrival: better.arrival,
        saves: Math.min(lost, better.qty - sh.qty),
        instead: sh.id,
      })
  }

  const useful = options.filter((o) => o.saves > 0).sort((a, b) => a.turn - b.turn)
  if (useful.length)
    return {
      lost,
      avoidable: true,
      depot: name(flood.site),
      turn: flood.turn,
      lastChanceTurn: Math.max(...useful.map((o) => o.turn)),
      options: useful,
      reason: null,
    }

  const busy: string[] = []
  for (const truck of trucks) {
    const byStatus = new Map<string, number[]>()
    for (let turn = 0; turn < flood.turn; turn++) {
      const status = turns.get(turn)?.fleet.find((v) => v.id === truck.id)?.status
      if (status && status !== 'ready')
        byStatus.set(status, [...(byStatus.get(status) ?? []), turn])
    }
    for (const [status, at] of byStatus)
      busy.push(`${truck.id} was ${status} on turn${at.length > 1 ? 's' : ''} ${ranges(at)}`)
  }
  return {
    lost,
    avoidable: false,
    depot: name(flood.site),
    turn: flood.turn,
    lastChanceTurn: null,
    options: [],
    reason:
      (busy.length
        ? `${name(flood.site)} stock could not be moved: ${busy.join('; ')}.`
        : `No relief site reachable in time had open demand for ${name(flood.site)} stock.`) +
      ' The loss was unavoidable.',
  }
}

export function analyze(history: Run[]): DebriefFacts {
  if (!history.length) throw new Error('A run has at least its starting frame.')
  const final = history[history.length - 1]
  const turns = endOfTurn(history)
  const name = (id: string) => final.sites.find((n) => n.id === id)?.name ?? id
  const openNetwork = initial(final.id, final.title).roads

  const idleTrucks = final.fleet
    .map((truck) => {
      const idle: Move[] = []
      for (const [tick, frame] of turns) {
        if (tick >= DEADLINE) continue
        const best = feasibleMoves(frame, truck.id).sort(byUsefulness)[0]
        if (best) idle.push(best)
      }
      const show = (m: Move) => ({ turn: m.turn, to: name(m.to), qty: m.qty, arrival: m.arrival })
      return {
        truck: truck.id,
        depot: name(truck.home),
        turns: idle.map((m) => m.turn),
        firstMove: idle.length ? show(idle[0]) : null,
        lastMove: idle.length ? show(idle[idle.length - 1]) : null,
      }
    })
    .filter((t) => t.turns.length > 0)

  const rerouted = final.shipments.flatMap((sh: Shipment) => {
    const actual = sh.arrival - sh.departure
    const best = route(openNetwork, sh.from, sh.to)?.cost ?? actual
    return actual > best
      ? [{ shipment: sh.id, truck: sh.truck, to: name(sh.to), extraTurns: actual - best }]
      : []
  })

  // The scenario's flood destroys up to `loss` unallocated units at one depot on its turn.
  const flood = disruptionsOf(final).find((d) => d.kind === 'flood')
  const beforeFlood = flood && turns.get(flood.turn - 1)
  const floodLoss =
    flood && beforeFlood && final.tick >= flood.turn
      ? Math.min(flood.loss, beforeFlood.sites.find((n) => n.id === flood.site)?.stock ?? 0)
      : 0

  const dispatches = final.log.filter((e) => e.kind === 'dispatch')
  return {
    title: final.title,
    finalTurn: final.tick,
    target: TARGET_PERCENT,
    score: score(final),
    shipments: final.shipments.length,
    firstDispatchTurn: dispatches.length ? dispatches[0].tick : null,
    sites: final.sites
      .filter((n) => n.kind === 'relief')
      .map((n) => ({
        name: n.name,
        priority: PRIORITY[n.priority],
        delivered: n.delivered,
        demand: n.demand,
        unmet: n.demand - n.delivered,
      })),
    idleTrucks,
    inTransitAtClose: final.shipments
      .filter((sh) => !sh.delivered)
      .map((sh) => ({
        shipment: sh.id,
        truck: sh.truck,
        to: name(sh.to),
        qty: sh.qty,
        arrival: sh.arrival,
      })),
    rerouted,
    floodLoss,
    floodReview:
      flood && floodLoss > 0 ? reviewFlood(history, turns, floodLoss, name, flood) : undefined,
    timeline: final.log
      .filter((e) => e.kind !== 'system')
      .map((e) => ({ turn: e.tick, kind: e.kind, text: e.text })),
  }
}
