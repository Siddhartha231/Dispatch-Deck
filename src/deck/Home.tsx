import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Boxes, ChevronRight, Compass, Flag, MapPin, Plus, Radio, Route, Truck } from 'lucide-react'
import { dailySeed, scenarioLabel } from '../domain/scenario'
import { newRun } from '../domain/scenarios'
import type { DirectoryResponse, LeaderboardResponse, RunSummary } from '../domain/protocol.ts'
import { deck, message, type Identity } from './api'
import { FieldGuide } from './FieldGuide'
import { Network } from './Network'
import { Station } from './Station'
import { Header, Legend, Modal } from './ui'

/** The landing-page tiles: today's scenario's numbers. */
const stats = (units: number) =>
  [
    [Truck, '4', 'Fleet vehicles'],
    [Boxes, String(units), 'Supply units'],
    [MapPin, '5', 'Relief sites'],
    [Flag, '12', 'Turns to deadline'],
  ] as const

export function Home({
  user,
  setUser,
}: {
  user: Identity | null
  setUser: (user: Identity) => void
}) {
  const [station, setStation] = useState(false)
  const [create, setCreate] = useState(false)
  const [guide, setGuide] = useState(false)
  const [site, setSite] = useState('')
  const [error, setError] = useState('')
  const createAfterStation = useRef(false)

  useEffect(() => {
    const syncGuide = () => setGuide(location.hash === '#briefing')
    syncGuide()
    window.addEventListener('hashchange', syncGuide)
    return () => window.removeEventListener('hashchange', syncGuide)
  }, [])

  function launch() {
    if (user) return setCreate(true)
    createAfterStation.current = true
    setStation(true)
  }

  function closeGuide() {
    setGuide(false)
    if (location.hash) history.replaceState(null, '', location.pathname)
  }

  // The server deals "today's scenario" from its own UTC clock; this preview can differ only
  // within moments of midnight or on a wrong device clock.
  const today = dailySeed(new Date())
  const sample = useMemo(() => newRun('chart', 'Coastal Supply Crisis', today), [today])
  const supply = sample.sites.reduce((n, x) => n + x.stock, 0)
  const selected = sample.sites.find((x) => x.id === site)
  return (
    <>
      <Header user={user} />
      <main className="shell">
        <div className="page-line">
          <span>
            <span className="dot" /> COASTAL RESPONSE NETWORK
          </span>
          <span>OPERATIONS / SCENARIO DESK</span>
        </div>

        <section className="hero">
          <div className="hero-copy">
            <div className="eyebrow">
              <span className="rule" /> LOGISTICS SIMULATION
            </div>
            <h1>
              Coastal
              <br />
              Supply Crisis<span>.</span>
            </h1>
            <p>
              Command a relief fleet across a fractured coastline. Coordinate your crew, reroute
              supplies, and reach five communities before the deadline.
            </p>
            <div className="hero-actions">
              <button className="primary" onClick={launch}>
                <Plus size={18} />
                Create operation
              </button>
              <button className="dark-btn" onClick={() => setGuide(true)}>
                Read field guide
              </button>
            </div>
          </div>
          <div className="chart">
            <div className="chart-title">
              <span>
                <Compass size={16} /> Scenario map
              </span>
              <small>{scenarioLabel(today).toUpperCase()}</small>
            </div>
            <Network compact state={sample} selected={site} onSelect={(n) => setSite(n.id)} />
            <div className="chart-foot">
              {selected ? (
                <span>
                  {selected.name} ·{' '}
                  {selected.kind === 'depot'
                    ? selected.stock + ' units in stock'
                    : selected.demand + ' units requested'}
                </span>
              ) : (
                <Legend />
              )}
            </div>
          </div>
        </section>

        <div className="stats">
          {stats(supply).map(([Icon, num, label]) => (
            <div key={label}>
              <Icon size={22} />
              <strong>{num}</strong>
              <span>{label}</span>
            </div>
          ))}
        </div>

        <OperationsDesk
          user={user}
          error={create ? '' : error}
          setError={setError}
          openStation={() => {
            createAfterStation.current = false
            setStation(true)
          }}
        />
        {user && <TodaysBest />}
        <footer>
          <span>DispatchDeck</span> Coastal operations simulator
        </footer>
      </main>

      {station && (
        <Station
          onClose={() => setStation(false)}
          onDone={(u) => {
            setUser(u)
            setStation(false)
            if (createAfterStation.current) setCreate(true)
          }}
        />
      )}
      {create && <CreateOperation onClose={() => setCreate(false)} />}
      {guide && <FieldGuide onClose={closeGuide} />}
    </>
  )
}

function OperationsDesk({
  user,
  error,
  setError,
  openStation,
}: {
  user: Identity | null
  error: string
  setError: (error: string) => void
  openStation: () => void
}) {
  const [runs, setRuns] = useState<DirectoryResponse | null>(null)
  const [version, reload] = useState(0)

  useEffect(() => {
    if (!user) return
    let active = true
    deck
      .runs()
      .then((r) => active && setRuns(r))
      .catch((e) => active && setError(message(e)))
    return () => {
      active = false
    }
  }, [user, version, setError])

  return (
    <section className="desk">
      <div className="section-heading">
        <div>
          <div className="eyebrow ink">
            <span className="rule" /> COMMAND CENTER
          </div>
          <h2>Operations desk</h2>
        </div>
        {user && (
          <button className="secondary" onClick={() => reload(version + 1)}>
            Refresh list
          </button>
        )}
      </div>
      {!user ? (
        <div className="empty">
          <div className="tile-icon">
            <Radio />
          </div>
          <div>
            <h3>Join the coastal response network</h3>
            <p>Open a station to browse shared operations or create a run for your crew.</p>
          </div>
          <button className="secondary" onClick={openStation}>
            Open station
          </button>
        </div>
      ) : runs === null ? (
        <p role="status">{error ? 'Operations could not load.' : 'Loading operations…'}</p>
      ) : (
        <>
          <h3 className="list-heading">Your operations</h3>
          {runs.mine.length === 0 ? (
            <div className="empty">
              <div className="tile-icon">
                <Route />
              </div>
              <div>
                <h3>No operations yet</h3>
                <p>Create one, or open a featured replay.</p>
              </div>
            </div>
          ) : (
            <RunList runs={runs.mine} />
          )}
          <h3 className="list-heading">Featured replays</h3>
          {runs.featured.length === 0 ? (
            <p className="muted">No featured replays are published yet.</p>
          ) : (
            <RunList runs={runs.featured} report />
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}

function RunList({ runs, report = false }: { runs: RunSummary[]; report?: boolean }) {
  return (
    <div className="run-list">
      {runs.map((r) => (
        <a href={'/runs/' + r.id + (report || r.phase === 'completed' ? '/report' : '')} key={r.id}>
          <span className={'tile-icon ' + r.phase}>
            <Radio />
          </span>
          <div>
            <strong>{r.title}</strong>
            <small>
              {r.scenario ? r.scenario.label + ' · ' : ''}
              {r.phase === 'completed' ? r.score.rate + '% fulfilled' : 'Turn ' + r.tick + ' of 12'}
            </small>
          </div>
          <span className="badge">{r.phase}</span>
          <ChevronRight size={18} />
        </a>
      ))}
    </div>
  )
}

/** The top crews on today's scenario, so a crew can see what a good run looks like. */
function TodaysBest() {
  const [board, setBoard] = useState<LeaderboardResponse | null>(null)
  useEffect(() => {
    let active = true
    deck
      .leaderboard('daily')
      .then((b) => active && setBoard(b))
      .catch(() => active && setBoard(null))
    return () => {
      active = false
    }
  }, [])
  if (!board) return null
  return (
    <section className="desk">
      <h3 className="list-heading">Today&apos;s best crews · {board.label}</h3>
      {board.entries.length === 0 ? (
        <p className="muted">No crew has finished today&apos;s scenario yet. Be the first.</p>
      ) : (
        <div className="run-list">
          {board.entries.map((e, i) => (
            <a href={'/runs/' + e.id + '/report'} key={e.id}>
              <span className="badge">#{i + 1}</span>
              <div>
                <strong>{e.title}</strong>
                <small>
                  {e.rate}% fulfilled · {e.weighted}% priority-weighted
                </small>
              </div>
              <ChevronRight size={18} />
            </a>
          ))}
        </div>
      )}
    </section>
  )
}

type ScenarioPick = 'daily' | 'classic' | 'custom'

function CreateOperation({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState('Coastal Supply Crisis')
  const [pick, setPick] = useState<ScenarioPick>('daily')
  const [custom, setCustom] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // A stable id makes a retried create land on the same operation.
  const createId = useRef(crypto.randomUUID())

  async function start(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const seed = pick === 'custom' ? custom.trim() : pick
      const r = await deck.createRun({ id: createId.current, title, seed })
      location.assign('/runs/' + r.id)
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Create operation" onClose={onClose}>
      <p>You will command this run. Share its link to add dispatchers.</p>
      <form onSubmit={start}>
        <label>
          Operation name
          <input
            autoFocus
            required
            maxLength={56}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <fieldset className="choices">
          <legend>Scenario</legend>
          {(
            [
              ['daily', "Today's scenario", 'The same for every crew today; compare scores.'],
              ['classic', 'Classic', 'The original exercise.'],
              ['custom', 'Custom seed', 'Any seed deals the same game every time.'],
            ] as const
          ).map(([value, label, hint]) => (
            <label key={value} className="choice">
              <input
                type="radio"
                name="scenario"
                checked={pick === value}
                onChange={() => setPick(value)}
              />
              <span>{label}</span>
              <small>{hint}</small>
            </label>
          ))}
          {pick === 'custom' && (
            <input
              aria-label="Seed"
              required
              maxLength={32}
              placeholder="harbor-storm"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
            />
          )}
        </fieldset>
        {error && <p role="alert">{error}</p>}
        <button className="primary" disabled={busy || !title.trim()}>
          {busy ? 'Creating…' : 'Create command room'}
        </button>
      </form>
    </Modal>
  )
}
