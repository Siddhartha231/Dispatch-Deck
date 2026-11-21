import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { z } from 'zod'
import {
  CreateRunRequestSchema,
  SeedSchema,
  EmptyRequestSchema,
  EnvelopeSchema,
  ForkRequestSchema,
  JoinRequestSchema,
  NoteRequestSchema,
  RunIdSchema,
  StationRequestSchema,
  type Note,
  type Operator,
  type Result,
  type Role,
  type RunSummary,
} from '../domain/protocol.ts'
import { forkTitle } from '../domain/fork.ts'
import {
  leaderboardEntry,
  leaderboardFields,
  LEADERBOARD_SIZE,
  topEntries,
} from '../domain/leaderboard.ts'
import { resolveSeed, scenarioLabel } from '../domain/scenario.ts'
import {
  membershipId,
  onlyCompleted,
  parseFeatured,
  parseStoredSummary,
  uniqueRuns,
} from '../domain/directory.ts'
import type { AppContext, Env } from '../../worker'
import { identify, issueStation } from './identity'
import { directoryScope, notesScope, recordTool } from './records'
import { bestEffort } from './retry'

type DeckContext = { Bindings: Env; Variables: { user: Operator } }
type DeckCtx = Context<DeckContext>

/** Largest request body the deck API accepts. */
const MAX_BODY_BYTES = 8192
const DIRECTORY_LIMIT = 30
const NOTES_LIMIT = 50

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } })

/** Ends the request with a JSON error (Hono and workerErrorHandler keep `res`). */
function reject(status: number, error: string): never {
  throw new HTTPException(status as 400, { res: json({ error }, status) })
}

/** Maps a Durable Object Result onto an HTTP response. */
function reply<T>(result: Result<T>) {
  return result.ok ? json(result.value) : json({ error: result.error }, result.status)
}

/** Reads and validates a JSON body against a protocol schema. */
async function body<S extends z.ZodType>(c: DeckCtx, schema: S): Promise<z.infer<S>> {
  const text = await c.req.text()
  if (text.length > MAX_BODY_BYTES) reject(413, 'Request is too large.')
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    reject(400, 'Invalid JSON.')
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) reject(422, parsed.error.issues[0]?.message ?? 'Invalid request.')
  return parsed.data
}

const room = (env: Env, id: string) =>
  env.SIMULATION_ROOMS.get(env.SIMULATION_ROOMS.idFromName('run:' + id))

/** Reads a stored summary, or null when it is missing, malformed or predates versions. */
function storedSummary(data: Record<string, unknown>): RunSummary | null {
  return parseStoredSummary(data.summary)
}

const deck = new Hono<DeckContext>()

// Browser requests that change state must come from this origin, carry JSON
// and stay small. SameSite=Strict cookies already stop cross-site sends; the
// Origin check also covers WebSocket upgrades, which SameSite does not.
deck.use('*', async (c, next) => {
  const req = c.req.raw
  const origin = req.headers.get('Origin')
  const writes = req.method === 'POST' || req.headers.has('Upgrade')
  if (writes && origin && origin !== new URL(req.url).origin) reject(403, 'Origin rejected.')
  if (req.method === 'POST') {
    if (!req.headers.get('content-type')?.includes('application/json'))
      reject(415, 'Expected JSON.')
    if (Number(req.headers.get('content-length')) > MAX_BODY_BYTES)
      reject(413, 'Request is too large.')
  }
  await next()
})

deck.get('/me', async (c) => json({ user: await identify(c.req.raw, c.env) }))

deck.post('/station', async (c) => {
  const { name } = await body(c, StationRequestSchema)
  const existing = await identify(c.req.raw, c.env)
  if (existing) return json(existing)
  let issued
  try {
    issued = await issueStation(c.env, name)
  } catch (e) {
    console.error(e)
    reject(503, 'Guest stations are unavailable. Sign in with DeepSpace instead.')
  }
  return Response.json(issued.operator, {
    headers: { 'Cache-Control': 'no-store', 'Set-Cookie': issued.cookie },
  })
})

// Everything below needs a caller.
async function requireUser(c: DeckCtx, next: () => Promise<void>) {
  const user = await identify(c.req.raw, c.env)
  if (!user) reject(401, 'Open an operator station or sign in with DeepSpace.')
  c.set('user', user)
  await next()
}
deck.use('/runs', requireUser)
deck.use('/runs/*', requireUser)

deck.post('/runs', async (c) => {
  const { id, title, seed } = await body(c, CreateRunRequestSchema)
  const user = c.get('user')
  const created = await room(c.env, id).create(user, id, title, resolveSeed(seed, new Date()))
  if (!created.ok) return reply(created)
  await listInDirectory(c.env, user, id, title)
  await recordMembership(c.env, user.uid, id, 'commander')
  return json(created.value)
})

/**
 * Adds a new run to the directory. The client picks the id, so a retry after
 * an interrupted directory write finds the existing record instead of
 * creating a duplicate.
 */
async function listInDirectory(env: Env, user: Operator, id: string, title: string) {
  const scope = directoryScope(env)
  try {
    const summary = await room(env, id).summary()
    await recordTool(env, scope, user.uid, 'records.create', {
      collection: 'runs',
      recordId: id,
      data: {
        title,
        ...(summary.ok && {
          summary: JSON.stringify(summary.value),
          ...leaderboardFields(summary.value),
        }),
      },
    })
  } catch (e) {
    const found = await recordTool(env, scope, user.uid, 'records.get', {
      collection: 'runs',
      recordId: id,
    })
    if (!found.record) throw e
  }
}

/**
 * Records that `uid` belongs to a run, so it shows under "Your operations".
 * Best effort and retried: a failed index write never fails the create or join,
 * and repeating a join writes the same record again.
 */
async function recordMembership(env: Env, uid: string, runId: string, role: Role) {
  const scope = directoryScope(env)
  const recordId = membershipId(uid, runId)
  await bestEffort(
    async () => {
      try {
        await recordTool(env, scope, uid, 'records.create', {
          collection: 'memberships',
          recordId,
          data: { uid, runId, role, joinedAt: new Date().toISOString() },
        })
      } catch (e) {
        const found = await recordTool(env, scope, uid, 'records.get', {
          collection: 'memberships',
          recordId,
        })
        if (!found.record) throw e
      }
    },
    { onError: (e) => console.error('Membership index write failed:', e) },
  )
}

/**
 * One run's directory summary: the stored one, or, for runs listed before
 * summaries existed, the room's own (which also republishes it).
 */
async function directorySummary(env: Env, actor: string, runId: string) {
  try {
    const found = await recordTool(env, directoryScope(env), actor, 'records.get', {
      collection: 'runs',
      recordId: runId,
    })
    if (!found.record) return null
    const stored = storedSummary(found.record.data)
    if (stored) return stored
    const live = await room(env, runId).requestPublish(actor)
    return live.ok ? live.value : null
  } catch (e) {
    console.error('Directory lookup failed:', e)
    return null
  }
}

const summariesFor = async (env: Env, actor: string, ids: string[]) =>
  (await Promise.all(ids.map((id) => directorySummary(env, actor, id)))).filter(
    (s): s is RunSummary => s !== null,
  )

// The best completed crews on one scenario: an indexed query on the directory's seed and
// phase columns, ordered by the numeric rank column (rate, then weighted), top ten.
deck.use('/leaderboard', requireUser)
deck.get('/leaderboard', async (c) => {
  const parsed = SeedSchema.safeParse(c.req.query('seed') ?? 'daily')
  if (!parsed.success) reject(422, parsed.error.issues[0]?.message ?? 'Invalid seed.')
  const seed = resolveSeed(parsed.data, new Date())
  const data = await recordTool(c.env, directoryScope(c.env), c.get('user').uid, 'records.query', {
    collection: 'runs',
    where: { seed, phase: 'completed' },
    orderBy: 'rank',
    orderDir: 'desc',
    limit: LEADERBOARD_SIZE,
  })
  const entries = (data.records ?? []).flatMap((r) => {
    const stored = storedSummary(r.data)
    return stored ? [leaderboardEntry(stored)] : []
  })
  return json({ seed, label: scenarioLabel(seed), entries: topEntries(entries) })
})

// The directory shows the caller's own operations and a curated list of featured
// replays. Nothing else is listed, so other operators' runs are never browsable.
deck.get('/runs', async (c) => {
  const user = c.get('user')
  const data = await recordTool(c.env, directoryScope(c.env), user.uid, 'records.query', {
    collection: 'memberships',
    where: { uid: user.uid },
    limit: DIRECTORY_LIMIT,
    orderBy: 'createdAt',
    orderDir: 'desc',
  })
  const ids = (data.records ?? []).map((r) => String(r.data.runId))
  const [mine, featured] = await Promise.all([
    summariesFor(c.env, user.uid, ids),
    summariesFor(c.env, user.uid, parseFeatured(c.env.FEATURED_RUNS)),
  ])
  return json({ mine: uniqueRuns(mine), featured: onlyCompleted(featured) })
})

// Per-operation routes: reject anything that is not a run id before touching storage.
deck.use('/runs/:id/*', async (c, next) => {
  if (!RunIdSchema.safeParse(c.req.param('id')).success) reject(404, 'Unknown operation.')
  await next()
})

deck.get('/runs/:id/state', async (c) =>
  reply(await room(c.env, c.req.param('id')).state(c.get('user'))),
)

deck.get('/runs/:id/history', async (c) => reply(await room(c.env, c.req.param('id')).history()))

deck.post('/runs/:id/command', async (c) => {
  const envelope = await body(c, EnvelopeSchema)
  const result = await room(c.env, c.req.param('id')).command(c.get('user'), envelope)
  // The room publishes the directory summary after commit (SimulationRoom.publish).
  return reply(result)
})

// Fork a completed run's replay into a new live run that the caller commands.
// The source room checks membership and picks the board; the new room stores it.
deck.post('/runs/:id/fork', async (c) => {
  const request = await body(c, ForkRequestSchema)
  const user = c.get('user')
  const source = c.req.param('id')
  const picked = await room(c.env, source).forkFrom(user, request.turn, request.before)
  if (!picked.ok) return reply(picked)
  const { frame } = picked.value
  const title = forkTitle(frame.title, request.turn)
  const created = await room(c.env, request.id).createFrom(user, request.id, title, frame, {
    id: source,
    turn: request.turn,
  })
  if (!created.ok) return reply(created)
  await listInDirectory(c.env, user, request.id, title)
  await recordMembership(c.env, user.uid, request.id, 'commander')
  return json(created.value)
})

deck.post('/runs/:id/join', async (c) => {
  const { invite } = await body(c, JoinRequestSchema)
  const user = c.get('user')
  const id = c.req.param('id')
  const joined = await room(c.env, id).join(user, invite)
  if (joined.ok && joined.value.role !== 'observer')
    await recordMembership(c.env, user.uid, id, joined.value.role)
  return reply(joined)
})

deck.post('/runs/:id/invite', async (c) => {
  await body(c, EmptyRequestSchema)
  return reply(await room(c.env, c.req.param('id')).rotateInvite(c.get('user')))
})

deck.get('/runs/:id/live', async (c) => {
  const user = c.get('user')
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') reject(426, 'WebSocket required.')
  const headers = new Headers({
    Upgrade: 'websocket',
    'x-operator': user.uid,
    'x-callsign': user.name,
  })
  return room(c.env, c.req.param('id')).fetch('https://room/live', { headers })
})

deck.get('/runs/:id/debrief', async (c) =>
  reply(await room(c.env, c.req.param('id')).debrief(c.get('user'))),
)

deck.post('/runs/:id/debrief', async (c) => {
  await body(c, EmptyRequestSchema)
  return reply(await room(c.env, c.req.param('id')).writeDebrief(c.get('user')))
})

deck.get('/runs/:id/notes', async (c) => {
  const id = c.req.param('id')
  const exists = await room(c.env, id).summary()
  if (!exists.ok) return reply(exists)
  const data = await recordTool(c.env, notesScope(id), c.get('user').uid, 'records.query', {
    collection: 'notes',
    orderBy: 'createdAt',
    orderDir: 'desc',
    limit: NOTES_LIMIT,
  })
  return json((data.records ?? []).map(toNote))
})

deck.post('/runs/:id/notes', async (c) => {
  const { text } = await body(c, NoteRequestSchema)
  const id = c.req.param('id')
  const user = c.get('user')
  if (!(await room(c.env, id).isMember(user)))
    reject(403, 'Join this operation with an invite link to post notes.')
  const note: Note = { recordId: crypto.randomUUID(), data: { text, author: user.name } }
  await recordTool(c.env, notesScope(id), user.uid, 'records.create', {
    collection: 'notes',
    recordId: note.recordId,
    data: note.data,
  })
  await room(c.env, id).noteAdded(note)
  return json(note)
})

function toNote(r: { recordId: string; data: Record<string, unknown> }): Note {
  return {
    recordId: r.recordId,
    data: { text: String(r.data.text), author: String(r.data.author) },
  }
}

export function registerDispatch(app: Hono<AppContext>) {
  app.route('/api/deck', deck)
}
