import { useState, type FormEvent } from 'react'
import type { Note, Run, Shipment } from '../../domain/protocol.ts'

const TABS = ['Activity', 'Notes', 'Shipments'] as const
type Tab = (typeof TABS)[number]

const turn = (tick: number) => 'T' + String(tick).padStart(2, '0')

export function Feed({
  s,
  notes,
  canPost,
  busy,
  onPost,
  onInspect,
}: {
  s: Run
  notes: Note[]
  canPost: boolean
  busy: boolean
  onPost: (text: string) => Promise<boolean>
  onInspect: (shipment: Shipment) => void
}) {
  const [tab, setTab] = useState<Tab>('Activity')
  const [note, setNote] = useState('')
  const label = (id: string) => s.sites.find((n) => n.id === id)?.name ?? id

  async function post(e: FormEvent) {
    e.preventDefault()
    if (await onPost(note)) setNote('')
  }

  return (
    <section className="panel">
      <div className="tabs">
        {TABS.map((t) => (
          <button className={tab === t ? 'active' : ''} key={t} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      <div className="feed">
        {tab === 'Activity' &&
          (s.log.length ? (
            [...s.log].reverse().map((e) => (
              <div key={e.seq} className={'event ' + e.kind}>
                <b>{turn(e.tick)}</b>
                <span>
                  {e.text}
                  <small>{e.actor}</small>
                </span>
              </div>
            ))
          ) : (
            <p>Activity begins when the commander starts the run.</p>
          ))}

        {tab === 'Shipments' &&
          (s.shipments.length ? (
            [...s.shipments].reverse().map((sh) => (
              <button className="ship-row" key={sh.id} onClick={() => onInspect(sh)}>
                <b>{sh.id}</b>
                {label(sh.to)}
                <small>
                  {sh.qty} units · {sh.delivered ? 'delivered' : 'ETA ' + sh.arrival}
                </small>
              </button>
            ))
          ) : (
            <p>No shipments dispatched.</p>
          ))}

        {tab === 'Notes' && (
          <>
            {!canPost && (
              <p className="hint">
                You are watching. Join with the commander&apos;s invite link to post notes.
              </p>
            )}
            {canPost && (
              <form onSubmit={post}>
                <label>
                  Shared crew note
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    maxLength={280}
                    required
                  />
                </label>
                <button className="secondary" disabled={busy || !note.trim()}>
                  Post note
                </button>
              </form>
            )}
            {notes.length ? (
              notes.map((n) => (
                <div className="crew-note" key={n.recordId}>
                  <b>{n.data.author}</b>
                  <p>{n.data.text}</p>
                </div>
              ))
            ) : (
              <p>No crew notes yet.</p>
            )}
          </>
        )}
      </div>
    </section>
  )
}
