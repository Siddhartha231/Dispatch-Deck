import { Boxes, Clock, Flag, MapPin, Truck } from 'lucide-react'
import { score, type Run, type Shipment, type Site } from '../../domain/engine'
import { Network } from '../Network'
import { Legend } from '../ui'

const PRIORITY = ['', 'Standard', 'High', 'Critical']

export function Kpis({ s }: { s: Run }) {
  const total = s.sites.reduce((t, n) => t + n.stock, 0)
  const ready = s.fleet.filter((v) => v.status === 'ready').length
  return (
    <div className="kpis">
      <div>
        <Clock />
        <span>Simulation turn</span>
        <b>
          {s.tick}
          <small> / 12</small>
        </b>
      </div>
      <div>
        <Boxes />
        <span>Depot stock</span>
        <b>
          {total}
          <small> units</small>
        </b>
      </div>
      <div>
        <Truck />
        <span>Fleet ready</span>
        <b>
          {ready}
          <small> / {s.fleet.length}</small>
        </b>
      </div>
      <div>
        <Flag />
        <span>Fulfillment</span>
        <b>
          {score(s).rate}
          <small>%</small>
        </b>
      </div>
    </div>
  )
}

export function MapPanel({
  s,
  focus,
  highlight,
  onSelect,
  onShipment,
}: {
  s: Run
  focus: string
  highlight?: string[]
  onSelect: (site: Site) => void
  onShipment: (shipment: Shipment) => void
}) {
  const selected = s.sites.find((n) => n.id === focus)!
  return (
    <section className="panel map-panel">
      <div className="panel-head">
        <h2>
          <MapPin />
          Network map
        </h2>
        <span className="mono">TURN {String(s.tick).padStart(2, '0')}</span>
      </div>
      <Network
        state={s}
        onShipment={onShipment}
        selected={focus}
        highlight={highlight}
        onSelect={onSelect}
      />
      <div className="map-bottom">
        <Legend />
        <b>
          {selected.name} ·{' '}
          {selected.kind === 'depot'
            ? selected.stock + ' in stock'
            : selected.delivered + '/' + selected.demand + ' delivered'}
        </b>
      </div>
    </section>
  )
}

export function FleetPanel({
  s,
  truck,
  onPick,
}: {
  s: Run
  truck: string
  onPick: (truckId: string) => void
}) {
  const label = (id: string) => s.sites.find((n) => n.id === id)?.name ?? id
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          <Truck />
          Fleet manifest
        </h2>
        <span className="mono">{s.fleet.length} VEHICLES</span>
      </div>
      <div className="fleet">
        {s.fleet.map((v) => (
          <button
            key={v.id}
            className={v.id === truck ? 'selected' : ''}
            onClick={() => onPick(v.id)}
          >
            <b>{v.id}</b>
            <small>
              {label(v.home)} · {v.capacity} units
            </small>
            <span className={'vehicle ' + v.status}>
              {v.status === 'ready'
                ? 'ready'
                : v.status + ' · back T' + String(v.readyAt).padStart(2, '0')}
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}

export function DemandPanel({ s }: { s: Run }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          <Flag />
          Destination demand
        </h2>
      </div>
      <div className="demands">
        {s.sites
          .filter((n) => n.kind === 'relief')
          .map((n) => (
            <div key={n.id}>
              <span>
                {n.name}
                <small>{PRIORITY[n.priority]} priority</small>
              </span>
              <progress max={n.demand} value={n.delivered} />
              <b>
                {n.delivered}/{n.demand}
              </b>
            </div>
          ))}
      </div>
    </section>
  )
}

export function ReplayPanel({
  final,
  frame,
  frames,
  position,
  onScrub,
}: {
  final: Run
  frame: Run
  frames: number
  position: number
  onScrub: (index: number) => void
}) {
  const now = score(frame)
  const outcome =
    final.phase !== 'completed'
      ? 'Operation in progress'
      : score(final).success
        ? 'Delivery target met'
        : 'Delivery target missed'
  return (
    <section className="panel replay">
      <div>
        <div className="eyebrow ink">OPERATION REPLAY</div>
        <h2>{outcome}</h2>
        <p>
          Final target 80% · {now.delivered} of {now.demand} units delivered at this frame ·{' '}
          {now.weighted}% priority-weighted fulfillment
        </p>
      </div>
      <label>
        Replay frame {frame.version} / {final.version}
        <input
          aria-label="Replay frame"
          type="range"
          min="0"
          max={Math.max(0, frames - 1)}
          // Until the replay loads there is nothing to scrub; a key press then would be lost.
          disabled={frames === 0}
          value={position}
          onChange={(e) => onScrub(Number(e.target.value))}
        />
      </label>
    </section>
  )
}
