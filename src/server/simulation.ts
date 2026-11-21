import { DurableObject } from 'cloudflare:workers'
import { analyze } from '../domain/analysis.ts'
import { staleReason } from '../domain/concurrency.ts'
import { RuleError, score, transition } from '../domain/engine.ts'
import { leaderboardFields } from '../domain/leaderboard.ts'
import { scenarioOf } from '../domain/scenario.ts'
import { newRun } from '../domain/scenarios.ts'
import { forkFrame, forkRun } from '../domain/fork.ts'
import type {
  CommandResult,
  DebriefFacts,
  DebriefNarrative,
  DebriefResponse,
  Envelope,
  ForkOrigin,
  Note,
  Operator,
  Result,
  Role,
  Run,
  RunSummary,
  ServerMessage,
  StateResponse,
} from '../domain/protocol.ts'
import type { Env } from '../../worker'
import { createPublisher } from './publisher'
import { directoryScope, recordTool } from './records'
import { DEBRIEF_MODEL, DEBRIEFS_PER_DAY, writeDebrief } from './debrief'
import { UnverifiedDebriefError } from '../domain/debrief-check.ts'

/** Shown instead of a narrative when no draft survived verification. */
const UNVERIFIED_DEBRIEF =
  'The written debrief was withheld because it could not be verified against the replay. The findings below are computed directly from it.'

type Member = { uid: string; name: string; role: Role }

const SCHEMA = `
  -- One row per committed version: the live board is the newest row and the
  -- replay is every row in order.
  CREATE TABLE IF NOT EXISTS history (version INTEGER PRIMARY KEY, snapshot TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS members (uid TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL);
  -- The after-action debrief, written at most once per run.
  CREATE TABLE IF NOT EXISTS debrief (
    id INTEGER PRIMARY KEY CHECK (id = 1), narrative TEXT NOT NULL, model TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  -- Run settings, such as the current invite code.
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  -- Idempotency receipts: a retried key with the same payload returns its version.
  CREATE TABLE IF NOT EXISTS receipts (
    key TEXT PRIMARY KEY, actor TEXT NOT NULL, payload TEXT NOT NULL, version INTEGER NOT NULL
  );
`

const summarize = (s: Run, forkedFrom?: ForkOrigin): RunSummary => ({
  id: s.id,
  title: s.title,
  tick: s.tick,
  phase: s.phase,
  score: score(s),
  version: s.version,
  ...(forkedFrom && { forkedFrom }),
  scenario: scenarioOf(s),
})

const ok = <T>(value: T): Result<T> => ({ ok: true, value })

/** 18 random bytes as base64url: a 24-character, 144-bit invite code. */
function newInvite() {
  const bytes = crypto.getRandomValues(new Uint8Array(18))
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
}

const encoder = new TextEncoder()
/** Constant-time comparison, so response timing reveals nothing about the code. */
function sameSecret(a: string, b: string) {
  const x = encoder.encode(a)
  const y = encoder.encode(b)
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y)
}
const fail = (status: number, error: string): Result<never> => ({ ok: false, status, error })

/** Runs `fn`, turning rule violations into a failed Result. Other errors propagate. */
function guard<T>(fn: () => Result<T>): Result<T> {
  try {
    return fn()
  } catch (e) {
    if (e instanceof RuleError) return fail(e.status, e.message)
    throw e
  }
}

/**
 * One operation. Owns its membership, the board, every replay frame and the
 * idempotency receipts in its own SQLite database, and broadcasts committed
 * boards to the operators connected over hibernatable WebSockets.
 *
 * The Worker calls it over RPC after verifying the caller, so `caller` is
 * trusted here. Clients never reach it directly.
 */
export class SimulationRoom extends DurableObject<Env> {
  private db: SqlStorage
  /** The in-flight debrief generation, shared by concurrent requests. */
  private writing: Promise<Result<null>> | null = null
  /** The caller whose request last queued a directory write; RecordRoom needs a uid. */
  private actor = ''
  /** Orders directory summary writes for this run: the last one written is the newest. */
  private publisher = createPublisher<RunSummary>(
    (summary) =>
      recordTool(this.env, directoryScope(this.env), this.actor, 'records.update', {
        collection: 'runs',
        recordId: summary.id,
        data: { summary: JSON.stringify(summary), ...leaderboardFields(summary) },
      }).then(() => undefined),
    { onError: (e) => console.error('Directory summary update failed:', e) },
  )

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.db = ctx.storage.sql
    this.db.exec(SCHEMA)
  }

  // -- RPC methods ----------------------------------------------------------

  /** `seed` is a resolved scenario seed (the Worker turns "daily" into today's); omitted is classic. */
  create(caller: Operator, id: string, title: string, seed?: string): Result<{ id: string }> {
    return guard(() =>
      this.ctx.storage.transactionSync(() => {
        const existing = this.latest()
        if (existing && this.member(caller.uid)?.role !== 'commander')
          return fail(409, 'That operation id is already in use.')
        if (!existing) {
          this.save(newRun(id, title, seed))
          this.db.exec("INSERT INTO members VALUES (?, ?, 'commander')", caller.uid, caller.name)
          this.setInvite(newInvite())
        }
        return ok({ id })
      }),
    )
  }

  /**
   * Creates this run as a what-if fork: its first board is `frame`, taken from
   * the source run's replay by `forkFrom`. The forker commands it. A retry with
   * the same id and the same board returns the existing run; any other use of
   * the id is a conflict.
   */
  createFrom(
    caller: Operator,
    id: string,
    title: string,
    frame: Run,
    origin: ForkOrigin,
  ): Result<{ id: string }> {
    return this.ctx.storage.transactionSync(() => {
      const first = forkRun(frame, id, title, caller.name, origin)
      const existing = this.snapshot(0)
      if (!existing) {
        this.save(first)
        this.db.exec("INSERT INTO members VALUES (?, ?, 'commander')", caller.uid, caller.name)
        this.setInvite(newInvite())
        this.db.exec("INSERT INTO meta VALUES ('forkedFrom', ?)", JSON.stringify(origin))
        return ok({ id })
      }
      const same =
        this.member(caller.uid)?.role === 'commander' &&
        JSON.stringify(this.forkedFrom()) === JSON.stringify(origin) &&
        JSON.stringify(existing) === JSON.stringify(first)
      return same ? ok({ id }) : fail(409, 'That operation id is already in use.')
    })
  }

  /**
   * Source side of a fork: checks the caller is a member and returns the board
   * to restart from. Nothing is written here.
   */
  forkFrom(caller: Operator, turn: number, before?: string): Result<{ frame: Run }> {
    if (!this.latest()) return fail(404, 'Operation not found.')
    if (this.roleOf(caller) === 'observer')
      return fail(403, 'Join this operation to play a what-if from it.')
    const frame = forkFrame(this.frames(), turn, before)
    return frame.ok ? ok({ frame: frame.value }) : frame
  }

  state(caller: Operator): Result<StateResponse> {
    const state = this.latest()
    if (!state) return fail(404, 'Operation not found.')
    const role = this.roleOf(caller)
    const invite = role === 'commander' ? this.invite() : undefined
    const forkedFrom = this.forkedFrom()
    return ok({
      state,
      role,
      peers: this.peers(),
      ...(invite && { invite }),
      ...(forkedFrom && { forkedFrom }),
    })
  }

  summary(): Result<RunSummary> {
    const s = this.latest()
    if (!s) return fail(404, 'Operation not found.')
    return ok(summarize(s, this.forkedFrom()))
  }

  /**
   * Asks the room to publish its latest summary to the directory and returns
   * it. Publication is a side effect after commit: it runs in the background
   * through the single in-flight publisher and never blocks the caller.
   */
  requestPublish(actor: string): Result<RunSummary> {
    const summary = this.summary()
    if (summary.ok) this.publish(actor, summary.value)
    return summary
  }

  private publish(actor: string, summary: RunSummary) {
    this.actor = actor
    this.ctx.waitUntil(this.publisher.submit(summary))
  }

  history(): Result<Run[]> {
    const frames = this.frames()
    return frames.length ? ok(frames) : fail(404, 'Operation not found.')
  }

  /**
   * Adds `caller` as a dispatcher when they present this run's invite code.
   * Members who join again keep their role.
   */
  join(caller: Operator, invite: string): Result<{ role: Role }> {
    if (!this.latest()) return fail(404, 'Operation not found.')
    if (this.member(caller.uid)) return ok({ role: this.roleOf(caller) })
    if (!sameSecret(invite, this.invite()))
      return fail(403, 'This invite link is not valid. Ask the commander for a new one.')
    this.db.exec(
      "INSERT OR IGNORE INTO members VALUES (?, ?, 'dispatcher')",
      caller.uid,
      caller.name,
    )
    return ok({ role: this.roleOf(caller) })
  }

  /** Replaces the invite code. Links already shared stop working; members stay. */
  rotateInvite(caller: Operator): Result<{ invite: string }> {
    if (!this.latest()) return fail(404, 'Operation not found.')
    if (this.roleOf(caller) !== 'commander') return fail(403, 'Only the commander can do that.')
    const invite = newInvite()
    this.setInvite(invite)
    return ok({ invite })
  }

  /** Whether `caller` may write to this operation (post notes, dispatch). */
  isMember(caller: Operator): boolean {
    return this.roleOf(caller) !== 'observer'
  }

  /** Pushes a newly stored crew note to everyone connected. */
  noteAdded(note: Note) {
    this.broadcast({ type: 'note', note })
  }

  /**
   * Applies one order in a single synchronous SQLite transaction: check the
   * receipt, check freshness, apply the rules, store the next replay frame and
   * record the receipt. Nothing else can interleave, so exactly one of two
   * orders for the same truck commits.
   */
  command(caller: Operator, envelope: Envelope): Result<CommandResult> {
    const role = this.roleOf(caller)
    const payload = JSON.stringify([envelope.version, envelope.command])
    const result = guard(() =>
      this.ctx.storage.transactionSync(() => {
        const receipt = this.db
          .exec<{
            actor: string
            payload: string
            version: number
          }>('SELECT actor, payload, version FROM receipts WHERE key = ?', envelope.key)
          .toArray()[0]
        if (receipt) {
          if (receipt.actor !== caller.uid || receipt.payload !== payload)
            return fail(409, 'That command key was already used for a different order.')
          return ok({ applied: receipt.version, duplicate: true, state: this.latest()! })
        }
        const latest = this.latest()
        if (!latest) return fail(404, 'Operation not found.')
        if (role === 'observer') return fail(403, 'Join this operation before dispatching.')
        const seen = this.snapshot(envelope.version)
        if (!seen) return fail(400, 'That board version does not exist.')
        const stale = staleReason(seen, latest, envelope.command)
        if (stale) return fail(409, stale)
        const next = transition(latest, envelope.command, role, caller.name)
        this.save(next)
        this.db.exec(
          'INSERT INTO receipts VALUES (?, ?, ?, ?)',
          envelope.key,
          caller.uid,
          payload,
          next.version,
        )
        return ok({ applied: next.version, duplicate: false, state: next })
      }),
    )
    if (result.ok && !result.value.duplicate) {
      this.broadcast({ type: 'snapshot', state: result.value.state })
      this.publish(caller.uid, summarize(result.value.state, this.forkedFrom()))
    }
    return result
  }

  // -- After-action debrief -------------------------------------------------

  /** The deterministic facts, plus the written debrief if there is one. */
  debrief(caller: Operator): Result<DebriefResponse> {
    const frames = this.frames()
    if (!frames.length) return fail(404, 'Operation not found.')
    const facts = analyze(frames)
    const stored = this.storedDebrief()
    const blocked = stored ? null : this.debriefBlocker(caller, frames.at(-1)!)
    return ok({
      facts,
      narrative: stored?.narrative ?? null,
      model: stored?.model ?? null,
      canGenerate: !stored && !blocked,
      note: stored ? null : (blocked ?? 'Not written yet.'),
    })
  }

  /**
   * Writes the debrief once. Concurrent callers share one model call, and a
   * failed call is not stored, so it can be retried.
   */
  async writeDebrief(caller: Operator): Promise<Result<DebriefResponse>> {
    const current = this.debrief(caller)
    if (!current.ok || current.value.narrative) return current
    if (!current.value.canGenerate) return fail(409, current.value.note ?? 'Not available.')
    this.writing ??= this.produceDebrief(current.value.facts).finally(() => {
      this.writing = null
    })
    const written = await this.writing
    return written.ok ? this.debrief(caller) : written
  }

  private async produceDebrief(facts: DebriefFacts): Promise<Result<null>> {
    const budget = this.env.DEBRIEF_BUDGET.get(this.env.DEBRIEF_BUDGET.idFromName('global'))
    if (!(await budget.take(DEBRIEFS_PER_DAY)))
      return fail(429, "Today's debrief allowance is used up. Try again tomorrow.")
    let narrative: DebriefNarrative
    try {
      narrative = await writeDebrief(this.env, facts)
    } catch (e) {
      // Two drafts failed verification against the replay. Retrying would
      // spend budget on the same facts, so remember it and show the findings.
      if (e instanceof UnverifiedDebriefError) {
        this.db.exec(
          "INSERT OR REPLACE INTO meta VALUES ('debrief_withheld', ?)",
          UNVERIFIED_DEBRIEF,
        )
        return fail(422, UNVERIFIED_DEBRIEF)
      }
      console.error('Debrief generation failed:', e)
      return fail(502, 'The debrief could not be written right now. Try again in a minute.')
    }
    this.db.exec(
      'INSERT OR IGNORE INTO debrief VALUES (1, ?, ?, ?)',
      JSON.stringify(narrative),
      DEBRIEF_MODEL,
      Date.now(),
    )
    return ok(null)
  }

  /** Why the caller cannot ask for a debrief yet, or null if they can. */
  private debriefBlocker(caller: Operator, final: Run) {
    if (final.phase !== 'completed') return 'The debrief opens once the operation closes.'
    if (!final.shipments.length)
      return 'No shipments were dispatched, so there is nothing to review.'
    if (this.roleOf(caller) === 'observer') return 'A crew member can write the debrief.'
    const withheld = this.db
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'debrief_withheld'")
      .toArray()[0]
    return withheld?.value ?? null
  }

  private storedDebrief() {
    const row = this.db
      .exec<{ narrative: string; model: string }>('SELECT narrative, model FROM debrief')
      .toArray()[0]
    return row
      ? { narrative: JSON.parse(row.narrative) as DebriefNarrative, model: row.model }
      : null
  }

  // -- WebSocket ------------------------------------------------------------

  /**
   * Accepts a live connection. The Worker forwards only verified upgrades and
   * names the caller in internal headers.
   */
  async fetch(req: Request) {
    const caller = {
      uid: req.headers.get('x-operator') ?? '',
      name: req.headers.get('x-callsign') ?? '',
    }
    if (!caller.uid) return Response.json({ error: 'Sign in required.' }, { status: 401 })
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
      return Response.json({ error: 'WebSocket required.' }, { status: 426 })
    const state = this.latest()
    if (!state) return Response.json({ error: 'Operation not found.' }, { status: 404 })

    const role = this.roleOf(caller)
    const [client, server] = Object.values(new WebSocketPair())
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ ...caller, role } satisfies Member)
    server.send(JSON.stringify({ type: 'snapshot', state, role } satisfies ServerMessage))
    this.broadcast({ type: 'presence', peers: this.peers() })
    return new Response(null, { status: 101, webSocket: client })
  }

  webSocketClose(ws: WebSocket) {
    try {
      ws.close(1000, 'Disconnected')
    } catch {
      // Already closed.
    }
    this.broadcast({ type: 'presence', peers: this.peers() })
  }

  webSocketError(ws: WebSocket) {
    this.webSocketClose(ws)
  }

  // -- Storage helpers ------------------------------------------------------

  /** Every committed board, oldest first: the replay. */
  private frames(): Run[] {
    return this.db
      .exec<{ snapshot: string }>('SELECT snapshot FROM history ORDER BY version')
      .toArray()
      .map((r) => JSON.parse(r.snapshot) as Run)
  }

  private latest(): Run | null {
    const row = this.db
      .exec<{ snapshot: string }>('SELECT snapshot FROM history ORDER BY version DESC LIMIT 1')
      .toArray()[0]
    return row ? JSON.parse(row.snapshot) : null
  }

  private snapshot(version: number): Run | null {
    const row = this.db
      .exec<{ snapshot: string }>('SELECT snapshot FROM history WHERE version = ?', version)
      .toArray()[0]
    return row ? JSON.parse(row.snapshot) : null
  }

  private save(s: Run) {
    this.db.exec('INSERT INTO history VALUES (?, ?)', s.version, JSON.stringify(s))
  }

  /** The current invite code. Runs created before invites existed get one on first read. */
  private invite(): string {
    const row = this.db
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'invite'")
      .toArray()[0]
    if (row) return row.value
    const invite = newInvite()
    this.setInvite(invite)
    return invite
  }

  /** Set when this run was started as a what-if from another run's replay. */
  private forkedFrom(): ForkOrigin | undefined {
    const row = this.db
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'forkedFrom'")
      .toArray()[0]
    return row ? (JSON.parse(row.value) as ForkOrigin) : undefined
  }

  private setInvite(invite: string) {
    this.db.exec("INSERT OR REPLACE INTO meta VALUES ('invite', ?)", invite)
  }

  private member(uid: string): Member | undefined {
    return this.db.exec<Member>('SELECT * FROM members WHERE uid = ?', uid).toArray()[0]
  }

  private roleOf(caller: Operator): Role {
    return this.member(caller.uid)?.role ?? 'observer'
  }

  /** Distinct names of everyone connected right now. */
  private peers() {
    const names = new Map<string, string>()
    for (const ws of this.ctx.getWebSockets()) {
      // A socket in its close handler is still listed; skip it.
      if (ws.readyState !== WebSocket.OPEN) continue
      const member = ws.deserializeAttachment() as Member
      names.set(member.uid, member.name)
    }
    return [...names.values()]
  }

  private broadcast(message: ServerMessage) {
    const data = JSON.stringify(message)
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data)
      } catch {
        // The socket is closing; its close handler updates presence.
      }
    }
  }
}
