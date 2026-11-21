import { useCallback, useEffect, useState } from 'react'
import {
  ServerMessageSchema,
  type Command,
  type Envelope,
  type ForkOrigin,
  type Note,
  type Role,
  type Run,
} from '../../domain/protocol.ts'
import { mergeNotes } from '../../domain/notes.ts'
import { deck, message, type Identity } from '../api'

/** How long to wait before the first reconnect; doubles up to ten seconds. */
const FIRST_RECONNECT_MS = 700
const MAX_RECONNECT_MS = 10_000
/** HTTP refresh cadence while the socket is down. */
const POLL_MS = 6000

/**
 * Live state for one operation: the committed board, the caller's role,
 * who is online, crew notes and (on the report page) every replay frame.
 *
 * The WebSocket pushes committed snapshots and new notes. While it is down,
 * an HTTP poll keeps the board current, and `accept` drops anything older
 * than what is already shown, so out-of-order deliveries never move the
 * board backwards.
 */
export function useOperation(id: string, user: Identity | null, report: boolean) {
  const [state, setState] = useState<Run | null>(null)
  const [role, setRole] = useState<Role>('observer')
  const [peers, setPeers] = useState<string[]>([])
  const [status, setStatus] = useState('Connecting')
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const [notes, setNotes] = useState<Note[]>([])
  const [history, setHistory] = useState<Run[]>([])
  const [retry, setRetry] = useState(0)
  const [pending, setPending] = useState<Envelope | null>(null)
  /** The invite code; the server sends it only to the commander. */
  const [invite, setInvite] = useState<string | null>(null)
  /** Set when this run is a what-if fork of another run. */
  const [forkedFrom, setForkedFrom] = useState<ForkOrigin | null>(null)

  const accept = useCallback(
    (next: Run) => setState((prev) => (!prev || next.version >= prev.version ? next : prev)),
    [],
  )
  const addNoteLocally = useCallback(
    (note: Note) =>
      setNotes((prev) => (prev.some((n) => n.recordId === note.recordId) ? prev : [note, ...prev])),
    [],
  )
  const refresh = useCallback(async () => {
    const r = await deck.state(id)
    accept(r.state)
    setRole(r.role)
    setPeers(r.peers)
    setInvite(r.invite ?? null)
    setForkedFrom(r.forkedFrom ?? null)
  }, [id, accept])

  useEffect(() => {
    if (!user) return
    let closed = false
    let socket: WebSocket | undefined
    let timer: ReturnType<typeof setTimeout>
    let delay = FIRST_RECONNECT_MS
    /** True while the socket has delivered a snapshot and not since closed. */
    let live = false
    /** True once a socket has closed, so the next snapshot is a reconnect. */
    let dropped = false

    const open = () => {
      if (closed) return
      const scheme = location.protocol === 'https:' ? 'wss://' : 'ws://'
      socket = new WebSocket(`${scheme}${location.host}/api/deck/runs/${id}/live`)
      socket.onmessage = (e) => {
        if (closed) return
        const parsed = ServerMessageSchema.safeParse(JSON.parse(e.data))
        if (!parsed.success) return
        const packet = parsed.data
        if (packet.type === 'snapshot') {
          accept(packet.state)
          if (packet.role) setRole(packet.role)
          live = true
          setStatus('Live')
          delay = FIRST_RECONNECT_MS
          // Notes pushed while the socket was down are gone for good, so catch up.
          if (dropped) {
            dropped = false
            syncNotes()
          }
        } else if (packet.type === 'presence') setPeers(packet.peers)
        else addNoteLocally(packet.note)
      }
      socket.onclose = () => {
        if (closed) return
        live = false
        dropped = true
        setStatus('Reconnecting')
        timer = setTimeout(open, delay)
        delay = Math.min(MAX_RECONNECT_MS, delay * 2)
      }
      socket.onerror = () => socket?.close()
    }

    /**
     * Pulls recent notes and merges them with whatever the socket delivered
     * meanwhile. The `closed` guard keeps a late reply from an earlier effect
     * run from touching state.
     */
    const syncNotes = () =>
      deck
        .notes(id)
        .then((n) => !closed && setNotes((prev) => mergeNotes(prev, n)))
        .catch((e) => !closed && setError(message(e)))

    /**
     * Runs after every successful state read, whether it came from the first
     * request or a recovery poll. The first one starts the socket and loads
     * notes, exactly once per effect run. A later one means HTTP works but the
     * socket is not delivering, so say so instead of claiming Live.
     */
    let started = false
    const read = () =>
      refresh().then(() => {
        if (closed) return
        if (!started) {
          started = true
          setStatus('Connecting')
          open()
          syncNotes()
        } else if (!live) setStatus('Reconnecting')
      })

    read().catch((e) => {
      if (closed) return
      setError(message(e))
      setStatus('Disconnected')
    })
    const poll = setInterval(() => {
      if (!closed && socket?.readyState !== WebSocket.OPEN)
        read().catch(() => !closed && setStatus('Disconnected'))
    }, POLL_MS)
    return () => {
      closed = true
      clearInterval(poll)
      clearTimeout(timer)
      socket?.close()
    }
  }, [user, id, accept, addNoteLocally, refresh, retry])

  useEffect(() => {
    if (report && state)
      deck
        .history(id)
        .then(setHistory)
        .catch((e) => setError(message(e)))
  }, [report, id, state?.version])

  /**
   * Sends a new order. It always gets a fresh idempotency key, so it can never
   * be confused with an earlier, interrupted order. Any interrupted order is
   * dropped: the refresh after an interruption already shows whether it landed.
   */
  function command(c: Command) {
    if (busy || !state) return
    setPending(null)
    return send({ key: crypto.randomUUID(), version: state.version, command: c })
  }

  /** Resends the exact interrupted envelope; the server answers with its receipt. */
  function retryPending() {
    if (busy || !pending) return
    return send(pending)
  }

  async function send(envelope: Envelope) {
    setBusy(true)
    setError('')
    setFeedback('')
    try {
      const r = await deck.command(id, envelope)
      accept(r.state)
      setPending(null)
      setFeedback(envelope.command.type === 'dispatch' ? 'Shipment committed.' : 'Board updated.')
    } catch (e) {
      // A TypeError means the response never arrived, so the command may
      // have committed. Keep the envelope: retrying it returns the receipt.
      if (e instanceof TypeError) {
        setPending(envelope)
        setError('Confirmation interrupted. The board below shows the latest committed state.')
      } else {
        setPending(null)
        setError(message(e))
      }
      await refresh().catch(() => {})
    } finally {
      setBusy(false)
    }
  }

  async function join(code: string) {
    setBusy(true)
    try {
      const r = await deck.join(id, code)
      setRole(r.role)
      setError('')
      return true
    } catch (e) {
      setError(message(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  /** Issues a new invite code so previously shared links stop working. */
  async function rotateInvite() {
    setBusy(true)
    try {
      setInvite((await deck.rotateInvite(id)).invite)
      setFeedback('New invite link ready. Earlier links no longer work.')
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }

  async function addNote(text: string) {
    setBusy(true)
    try {
      addNoteLocally(await deck.addNote(id, { text }))
      return true
    } catch (e) {
      setError(message(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  return {
    state,
    role,
    peers,
    status,
    error,
    setError,
    feedback,
    busy,
    notes,
    history,
    invite,
    forkedFrom,
    pending: pending?.command ?? null,
    command,
    retryPending,
    join,
    rotateInvite,
    addNote,
    reconnect: () => {
      setError('')
      setRetry((n) => n + 1)
    },
  }
}

export type Operation = ReturnType<typeof useOperation>
