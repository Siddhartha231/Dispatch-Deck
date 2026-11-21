import { useEffect, useState } from 'react'
import { Radio, Share2, Users } from 'lucide-react'
import type { Command, Run, Shipment, Site } from '../../domain/engine'
import type { Identity } from '../api'
import { Station } from '../Station'
import { Header, Modal } from '../ui'
import { DispatchForm, planShipment, type Draft } from './DispatchForm'
import { forkFrame } from '../../domain/fork'
import { scenarioOf } from '../../domain/scenario'
import { DebriefPanel } from './DebriefPanel'
import { Feed } from './Feed'
import { ForkBanner, ForkBar, ScoreCompare, useFork } from './Fork'
import { DemandPanel, FleetPanel, Kpis, MapPanel, ReplayPanel } from './Panels'
import { useOperation, type Operation } from './useOperation'

type Props = {
  id: string
  report: boolean
  user: Identity | null
  setUser: (user: Identity) => void
}

export default function RunPage({ id, report, user, setUser }: Props) {
  const op = useOperation(id, user, report)
  const [station, setStation] = useState(false)

  if (!user)
    return (
      <>
        <Header user={user} />
        <main className="shell gate">
          <Radio />
          <h1>Incoming operation</h1>
          <p>Open your operator station to view the shared command room.</p>
          <button className="primary" onClick={() => setStation(true)}>
            Open station
          </button>
          {station && <Station onDone={setUser} onClose={() => setStation(false)} />}
        </main>
      </>
    )

  if (!op.state)
    return (
      <>
        <Header user={user} />
        <main className="shell gate">
          <h1>Command room</h1>
          <p role="status">{op.error || 'Connecting to the operation…'}</p>
          {op.error && (
            <button className="secondary" onClick={op.reconnect}>
              Reconnect
            </button>
          )}
        </main>
      </>
    )

  return <Board id={id} report={report} user={user} op={op} state={op.state} />
}

function Board({
  id,
  report,
  user,
  op,
  state,
}: {
  id: string
  report: boolean
  user: Identity
  op: Operation
  state: Run
}) {
  const [frame, setFrame] = useState(-1)
  const fork = useFork(id)
  const [inspect, setInspect] = useState<Shipment | null>(null)
  const [copied, setCopied] = useState(false)
  const [finish, setFinish] = useState(false)
  const [draft, setDraft] = useState<Draft>({ truck: 'T-01', dest: 'harbor', qty: 25 })
  const [focus, setFocus] = useState('harbor')
  // An invite link carries its code in the fragment, which browsers never send to the server.
  // Pasting a link into a tab already on this run changes only the hash, so listen for that too.
  const [linkInvite, setLinkInvite] = useState(inviteInHash)
  useEffect(() => {
    const sync = () => setLinkInvite(inviteInHash())
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])

  // On the report page the slider picks a historical frame; -1 means "latest".
  const s = report && frame >= 0 ? (op.history[frame] ?? state) : state
  const { path } = planShipment(s, draft)
  const live = !report && s.phase !== 'completed'
  // Members of a finished run can restart its replay as a what-if.
  const canFork = report && state.phase === 'completed' && op.role !== 'observer'

  async function share() {
    const page = location.origin + '/runs/' + id + (report ? '/report' : '')
    const link = op.invite && !report ? page + '#invite=' + op.invite : page
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      op.setError('Copy the address from your browser to invite your crew.')
    }
  }

  async function joinWithLink() {
    if (!linkInvite || !(await op.join(linkInvite))) return
    // The code has done its job; keep it out of the address bar and history.
    history.replaceState(null, '', location.pathname)
    setLinkInvite(null)
  }

  function selectSite(n: Site) {
    setFocus(n.id)
    if (n.kind === 'relief') return setDraft({ ...draft, dest: n.id })
    const truck =
      s.fleet.find((v) => v.home === n.id && v.status === 'ready') ??
      s.fleet.find((v) => v.home === n.id)
    if (truck) setDraft({ ...draft, truck: truck.id })
  }

  function pickTruck(truckId: string) {
    const truck = s.fleet.find((v) => v.id === truckId)!
    setDraft({ ...draft, truck: truckId })
    setFocus(truck.home)
    const shipment = s.shipments.find((h) => h.truck === truckId && !h.delivered)
    if (shipment) setInspect(shipment)
  }

  return (
    <>
      <Header user={user} />
      <main className="shell board">
        <div className="page-line">
          <a href="/dashboard">Operations desk / {report ? 'Report' : 'Command room'}</a>
          <span>
            <span className="dot" />
            {op.status.toUpperCase()} · {op.peers.length} ONLINE
            {/* The board can be restored over HTTP while the socket is down, so offer a retry until it is Live. */}
            {op.status !== 'Live' && (
              <button className="secondary" onClick={op.reconnect}>
                Reconnect
              </button>
            )}
          </span>
        </div>

        <div className="board-head">
          <div>
            <div className="eyebrow ink">
              <span className="rule" />
              {report ? 'AFTER-ACTION REVIEW' : 'COASTAL RESPONSE NETWORK'}
            </div>
            {op.forkedFrom && <ForkBanner origin={op.forkedFrom} />}
            <h1>{s.title}</h1>
            <p>
              <span className="badge">{scenarioOf(state).label}</span>{' '}
              {report
                ? 'Review delivery outcomes and replay your crew’s decisions.'
                : user.name + ' · ' + op.role + ' · ' + s.phase}
            </p>
          </div>
          <div className="actions">
            <button className="secondary" onClick={share}>
              <Share2 size={16} />
              {copied
                ? 'Link copied'
                : op.invite && !report
                  ? 'Copy invite link'
                  : 'Copy view link'}
            </button>
            {!report && s.phase === 'completed' && (
              <a className="primary" href={'/runs/' + id + '/report'}>
                Open report
              </a>
            )}
            {report && (
              <a className="secondary" href={'/runs/' + id}>
                Command room
              </a>
            )}
            {live && op.role === 'observer' && linkInvite && (
              <button className="primary" disabled={op.busy} onClick={joinWithLink}>
                Join as dispatcher
              </button>
            )}
            {live && op.role === 'commander' && (
              <button
                className="primary"
                disabled={op.busy}
                onClick={() => op.command({ type: s.phase === 'lobby' ? 'start' : 'advance' })}
              >
                {s.phase === 'lobby' ? 'Start operation' : 'Advance time'}
              </button>
            )}
          </div>
        </div>

        <Kpis s={s} />
        {op.error && (
          <div role="alert" className="alert">
            {op.error}{' '}
            {op.pending && <button onClick={op.retryPending}>Retry {describe(op.pending)}</button>}
          </div>
        )}
        {op.feedback && (
          <div role="status" className="feedback">
            {op.feedback}
          </div>
        )}
        {report && (
          <ReplayPanel
            final={state}
            frame={s}
            frames={op.history.length}
            position={frame < 0 ? Math.max(0, op.history.length - 1) : frame}
            onScrub={setFrame}
          />
        )}
        {report && op.forkedFrom && <ScoreCompare origin={op.forkedFrom} fork={state} />}
        {canFork && (
          <ForkBar
            turn={s.tick}
            playable={forkFrame(op.history, s.tick).ok}
            action={fork}
            error={fork.error}
          />
        )}
        {report && state.phase === 'completed' && (
          <DebriefPanel id={id} fork={canFork ? fork : undefined} />
        )}

        <div className="work-grid">
          <div>
            <MapPanel
              s={s}
              focus={focus}
              highlight={inspect?.edges ?? path?.edges}
              onSelect={selectSite}
              onShipment={setInspect}
            />
            <FleetPanel s={s} truck={draft.truck} onPick={pickTruck} />
            <DemandPanel s={s} />
          </div>
          <aside>
            {live && (
              <DispatchForm
                s={s}
                role={op.role}
                busy={op.busy}
                draft={draft}
                setDraft={setDraft}
                onDestination={setFocus}
                onSubmit={op.command}
              />
            )}
            <Feed
              s={s}
              notes={op.notes}
              // Crew can keep talking on the report page: that's where the debrief happens.
              canPost={op.role !== 'observer'}
              busy={op.busy}
              onPost={op.addNote}
              onInspect={setInspect}
            />
            <section className="panel">
              <div className="panel-head">
                <h2>
                  <Users />
                  On station
                </h2>
              </div>
              <p className="crew">{op.peers.join(' · ') || 'Connecting to crew…'}</p>
            </section>
            {live && op.role === 'observer' && !linkInvite && (
              <p className="crew">
                You are observing. Ask the commander for an invite link to dispatch.
              </p>
            )}
            {live && op.role === 'commander' && (
              <button className="text-btn" disabled={op.busy} onClick={op.rotateInvite}>
                Replace invite link
              </button>
            )}
            {!report && op.role === 'commander' && s.phase === 'running' && (
              <button className="text-btn" onClick={() => setFinish(true)}>
                Finish operation early
              </button>
            )}
          </aside>
        </div>
      </main>

      {finish && (
        <Modal title="Finish this operation?" onClose={() => setFinish(false)}>
          <p>
            Undelivered shipments will remain in transit. The current fulfillment score becomes
            final.
          </p>
          <button
            className="primary"
            onClick={() => {
              setFinish(false)
              void op.command({ type: 'finish' })
            }}
          >
            Finish and score
          </button>
        </Modal>
      )}
      {inspect && <ShipmentModal s={s} shipment={inspect} onClose={() => setInspect(null)} />}
    </>
  )
}

function ShipmentModal({
  s,
  shipment,
  onClose,
}: {
  s: Run
  shipment: Shipment
  onClose: () => void
}) {
  const label = (id: string) => s.sites.find((n) => n.id === id)?.name ?? id
  return (
    <Modal title={'Shipment ' + shipment.id} onClose={onClose}>
      <p>
        {shipment.truck} · {shipment.qty} units · {shipment.delivered ? 'Delivered' : 'In transit'}
      </p>
      <h3>
        {label(shipment.from)} to {label(shipment.to)}
      </h3>
      <p>
        Departed turn {shipment.departure} · Arrival turn {shipment.arrival}
      </p>
      <p>Roads used: {shipment.edges.join(' / ')}</p>
    </Modal>
  )
}

/** A short label for an order, used on the retry button. */
function describe(c: Command) {
  if (c.type === 'dispatch') return `dispatch of ${c.qty} units on ${c.truck}`
  return c.type === 'advance' ? 'turn advance' : c.type
}

const inviteInHash = () => new URLSearchParams(location.hash.slice(1)).get('invite')
