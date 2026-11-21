import { Boxes, Truck } from 'lucide-react'
import { availableDemand, route, type Command, type Role, type Run } from '../../domain/engine'

export type Draft = { truck: string; dest: string; qty: number }

/** What the client can check before sending; the server re-checks all of it. */
export function planShipment(s: Run, draft: Draft) {
  const vehicle = s.fleet.find((v) => v.id === draft.truck)!
  const source = s.sites.find((n) => n.id === vehicle.home)!
  const path = route(s.roads, vehicle.home, draft.dest)
  const max = Math.min(vehicle.capacity, source.stock, availableDemand(s, draft.dest))
  return { vehicle, path, max }
}

export function DispatchForm({
  s,
  role,
  busy,
  draft,
  setDraft,
  onDestination,
  onSubmit,
}: {
  s: Run
  role: Role
  busy: boolean
  draft: Draft
  setDraft: (draft: Draft) => void
  onDestination: (siteId: string) => void
  onSubmit: (command: Command) => void
}) {
  const { vehicle, path, max } = planShipment(s, draft)
  const label = (id: string) => s.sites.find((n) => n.id === id)?.name ?? id
  const permitted =
    role !== 'observer' &&
    s.phase === 'running' &&
    vehicle.status === 'ready' &&
    Number.isInteger(draft.qty) &&
    draft.qty >= 1 &&
    draft.qty <= max &&
    !!path

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          <Boxes />
          Dispatch cargo
        </h2>
      </div>
      <form
        className="dispatch"
        onSubmit={(e) => {
          e.preventDefault()
          onSubmit({ type: 'dispatch', truck: draft.truck, to: draft.dest, qty: draft.qty })
        }}
      >
        <label>
          Fleet vehicle
          <select
            value={draft.truck}
            onChange={(e) => setDraft({ ...draft, truck: e.target.value })}
          >
            {s.fleet.map((v) => (
              <option key={v.id} value={v.id}>
                {v.id} · {label(v.home)} · {v.status}
              </option>
            ))}
          </select>
        </label>
        <label>
          Destination
          <select
            value={draft.dest}
            onChange={(e) => {
              setDraft({ ...draft, dest: e.target.value })
              onDestination(e.target.value)
            }}
          >
            {s.sites
              .filter((n) => n.kind === 'relief')
              .map((n) => (
                <option value={n.id} key={n.id}>
                  {n.name} · {availableDemand(s, n.id)} open
                </option>
              ))}
          </select>
        </label>
        <label>
          Cargo units
          <input
            type="number"
            min="1"
            max={max}
            value={Number.isNaN(draft.qty) ? '' : draft.qty}
            onChange={(e) => setDraft({ ...draft, qty: e.target.valueAsNumber })}
          />
        </label>
        <div className="route-info">
          <b>Route estimate</b>
          <span>
            {path
              ? path.cost + ' turns · arrives on turn ' + (s.tick + path.cost)
              : 'No open route'}
          </span>
          <small>
            {max} units available for this assignment
            {path && ' · truck back about turn ' + (s.tick + 2 * path.cost)}
          </small>
        </div>
        {path && s.tick + path.cost > 12 && (
          <p className="warning">Arrival falls after the deadline.</p>
        )}
        <button className="primary" disabled={busy || !permitted}>
          <Truck size={17} />
          {busy ? 'Committing…' : 'Dispatch shipment'}
        </button>
        {s.phase === 'lobby' && <small>The commander must start the operation first.</small>}
        {role === 'observer' && <small>Join as a dispatcher to reserve cargo.</small>}
      </form>
    </section>
  )
}
