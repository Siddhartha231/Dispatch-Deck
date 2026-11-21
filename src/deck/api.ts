import { getAuthToken } from 'deepspace'
import type { z } from 'zod'
import {
  CommandResultSchema,
  CreatedRunSchema,
  DebriefResponseSchema,
  DirectoryResponseSchema,
  InviteResponseSchema,
  LeaderboardResponseSchema,
  JoinResponseSchema,
  MeResponseSchema,
  NoteSchema,
  OperatorSchema,
  RunSchema,
  StateResponseSchema,
  type CreateRunRequest,
  type Envelope,
  type ForkRequest,
  type NoteRequest,
  type Operator,
  type StationRequest,
} from '../domain/protocol.ts'

export type Identity = Operator

/** DeepSpace accounts authenticate with a bearer token; stations use their cookie. */
let bearer = false

async function call<S extends z.ZodType>(
  schema: S,
  path: string,
  body?: unknown,
): Promise<z.infer<S>> {
  const headers = new Headers(body === undefined ? {} : { 'content-type': 'application/json' })
  if (bearer) {
    const token = await getAuthToken()
    if (token) headers.set('Authorization', 'Bearer ' + token)
  }
  const res = await fetch('/api/deck/' + path, {
    credentials: 'same-origin',
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const reason = (payload as { error?: unknown } | null)?.error
    throw new Error(typeof reason === 'string' ? reason : 'Request failed. Please try again.')
  }
  const parsed = schema.safeParse(payload)
  if (!parsed.success)
    throw new Error('The server sent a response this client does not understand.')
  return parsed.data
}

const run = (id: string, op: string) => `runs/${id}/${op}`

/** Every DispatchDeck endpoint, typed end to end by src/domain/protocol.ts. */
export const deck = {
  async me() {
    const r = await call(MeResponseSchema, 'me')
    bearer = !!r.user?.uid.startsWith('ds:')
    return r.user
  },
  station: (body: StationRequest) => call(OperatorSchema, 'station', body),
  runs: () => call(DirectoryResponseSchema, 'runs'),
  leaderboard: (seed: string) =>
    call(LeaderboardResponseSchema, 'leaderboard?seed=' + encodeURIComponent(seed)),
  createRun: (body: CreateRunRequest) => call(CreatedRunSchema, 'runs', body),
  state: (id: string) => call(StateResponseSchema, run(id, 'state')),
  history: (id: string) => call(RunSchema.array(), run(id, 'history')),
  command: (id: string, envelope: Envelope) =>
    call(CommandResultSchema, run(id, 'command'), envelope),
  fork: (id: string, body: ForkRequest) => call(CreatedRunSchema, run(id, 'fork'), body),
  join: (id: string, invite: string) => call(JoinResponseSchema, run(id, 'join'), { invite }),
  rotateInvite: (id: string) => call(InviteResponseSchema, run(id, 'invite'), {}),
  debrief: (id: string) => call(DebriefResponseSchema, run(id, 'debrief')),
  writeDebrief: (id: string) => call(DebriefResponseSchema, run(id, 'debrief'), {}),
  notes: (id: string) => call(NoteSchema.array(), run(id, 'notes')),
  addNote: (id: string, body: NoteRequest) => call(NoteSchema, run(id, 'notes'), body),
}

export const message = (e: unknown) =>
  e instanceof Error ? e.message : 'Unable to reach the server.'
