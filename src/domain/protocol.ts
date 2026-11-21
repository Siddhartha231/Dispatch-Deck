/**
 * The DispatchDeck wire protocol: every request body, response and socket
 * message, as zod schemas. The Worker parses requests with them, the client
 * parses responses with them, and the TypeScript types below are inferred
 * from them, so the browser, the Worker, the Durable Object and the tests
 * cannot drift apart.
 */
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Simulation state
// ---------------------------------------------------------------------------

export const SiteSchema = z.object({
  id: z.string(),
  name: z.string(),
  short: z.string(),
  x: z.number(),
  y: z.number(),
  kind: z.enum(['depot', 'relief']),
  stock: z.number(),
  demand: z.number(),
  delivered: z.number(),
  /** 0 for depots; 1 standard, 2 high, 3 critical for relief sites. */
  priority: z.number(),
})

export const RoadSchema = z.object({
  id: z.string(),
  a: z.string(),
  b: z.string(),
  /** Travel time in turns. */
  cost: z.number(),
  blocked: z.boolean(),
})

export const TruckSchema = z.object({
  id: z.string(),
  home: z.string(),
  capacity: z.number(),
  status: z.enum(['ready', 'outbound', 'returning']),
  /** The turn the truck is back at its depot and can be dispatched again. */
  readyAt: z.number(),
})

export const ShipmentSchema = z.object({
  id: z.string(),
  truck: z.string(),
  from: z.string(),
  to: z.string(),
  qty: z.number(),
  edges: z.array(z.string()),
  departure: z.number(),
  arrival: z.number(),
  delivered: z.boolean(),
})

export const EntrySchema = z.object({
  seq: z.number(),
  tick: z.number(),
  text: z.string(),
  kind: z.enum(['system', 'dispatch', 'arrival', 'alert']),
  actor: z.string(),
})

/** One scheduled disruption. Fired by the engine on `turn`, in array order within a turn. */
export const DisruptionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('closure'), turn: z.number().int(), road: z.string() }),
  z.object({
    kind: z.literal('flood'),
    turn: z.number().int(),
    site: z.string(),
    /** Most units the flood destroys; it takes less when the depot holds less. */
    loss: z.number().int(),
  }),
  z.object({
    kind: z.literal('surge'),
    turn: z.number().int(),
    site: z.string(),
    qty: z.number().int(),
  }),
])

/**
 * The scenario a run was dealt: its seed, a display label and the disruption
 * schedule the engine fires. Runs stored before scenarios existed have none,
 * and mean the classic scenario.
 */
export const ScenarioSchema = z.object({
  seed: z.string(),
  label: z.string(),
  disruptions: z.array(DisruptionSchema),
})

export const RunSchema = z.object({
  id: z.string(),
  title: z.string(),
  tick: z.number(),
  /** Increments once per committed command; also the replay frame number. */
  version: z.number(),
  phase: z.enum(['lobby', 'running', 'completed']),
  sites: z.array(SiteSchema),
  roads: z.array(RoadSchema),
  fleet: z.array(TruckSchema),
  shipments: z.array(ShipmentSchema),
  log: z.array(EntrySchema),
  /** Absent on classic runs and on runs stored before scenarios existed. */
  scenario: ScenarioSchema.optional(),
})

export const RoleSchema = z.enum(['commander', 'dispatcher', 'observer'])

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const CommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start') }),
  z.object({ type: z.literal('advance') }),
  z.object({ type: z.literal('finish') }),
  z.object({
    type: z.literal('dispatch'),
    truck: z.string().max(16),
    to: z.string().max(16),
    // The engine owns the cargo rules, so an out-of-range number reaches it
    // and gets its specific 422 message.
    qty: z.number(),
  }),
])

/**
 * One order. `key` makes retries idempotent: the same key and payload return
 * the original receipt. `version` is the board the operator planned on.
 */
export const EnvelopeSchema = z.object({
  key: z.string().regex(/^[-a-zA-Z0-9]{10,80}$/),
  version: z.number().int().nonnegative(),
  command: CommandSchema,
})

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const OperatorSchema = z.object({ uid: z.string(), name: z.string() })

export const StationRequestSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{1,27}$/, {
    message: 'Use 2–28 letters, numbers, spaces, dots, underscores or hyphens.',
  }),
})

export const RunIdSchema = z.uuid({ message: 'Unknown operation.' })

/** The secret part of an invite link; carried in the URL fragment. */
export const InviteSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{16,64}$/, { message: 'This invite link is not valid.' })

/** A scenario seed: normalised to lower case, 1 to 32 plain characters. */
export const SeedSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9 ._-]{0,31}$/, {
    message: 'Use 1-32 letters, numbers, spaces, dots, underscores or hyphens for the seed.',
  })

export const CreateRunRequestSchema = z.object({
  /** Chosen by the client so a retried create lands on the same operation. */
  id: RunIdSchema,
  title: z
    .string()
    .trim()
    .min(1, { message: 'Enter an operation name.' })
    .max(56, { message: 'Use up to 56 characters.' }),
  /**
   * Which scenario to deal: "classic", "daily" (today's, resolved by the Worker in UTC), or any
   * custom seed. Omitted means classic, as before seeds existed.
   */
  seed: SeedSchema.optional(),
})

/**
 * Starts a what-if from a completed run's replay. The client picks the new
 * run's id, as for creation, so a retried fork lands on the same run. `before`
 * names a shipment: fork from the board just before it was dispatched.
 */
export const ForkRequestSchema = z.object({
  id: RunIdSchema,
  turn: z.number().int().min(0).max(11),
  before: z.string().max(16).optional(),
})

export const JoinRequestSchema = z.object({ invite: InviteSchema })

export const EmptyRequestSchema = z.object({})

export const NoteRequestSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1, { message: 'Notes must contain 1–280 characters.' })
    .max(280, { message: 'Notes must contain 1–280 characters.' }),
})

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export const MeResponseSchema = z.object({ user: OperatorSchema.nullable() })

export const ScoreSchema = z.object({
  demand: z.number(),
  delivered: z.number(),
  rate: z.number(),
  weighted: z.number(),
  success: z.boolean(),
})

/** Where a what-if run came from: the source run and the turn it forked at. */
export const ForkOriginSchema = z.object({ id: z.string(), turn: z.number().int().nonnegative() })

export const RunSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  tick: z.number(),
  phase: RunSchema.shape.phase,
  score: ScoreSchema,
  /** The committed run version this summary describes; directory writes are ordered by it. */
  version: z.number().int().nonnegative(),
  /** Set on what-if runs only; absent on summaries written before forks existed. */
  forkedFrom: ForkOriginSchema.optional(),
  /** The scenario this run was dealt; absent on summaries written before scenarios existed. */
  scenario: z.object({ seed: z.string(), label: z.string() }).optional(),
})

/** One finished crew on a scenario's leaderboard. */
export const LeaderboardEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  rate: z.number(),
  weighted: z.number(),
  delivered: z.number(),
  demand: z.number(),
})

/** The top completed runs for one scenario seed, best first. */
export const LeaderboardResponseSchema = z.object({
  seed: z.string(),
  label: z.string(),
  entries: LeaderboardEntrySchema.array(),
})

/** The operations directory: the caller's own runs and the curated featured replays. */
export const DirectoryResponseSchema = z.object({
  mine: RunSummarySchema.array(),
  featured: RunSummarySchema.array(),
})

export const StateResponseSchema = z.object({
  state: RunSchema,
  role: RoleSchema,
  peers: z.array(z.string()),
  /** The invite code, sent only to the commander. */
  invite: InviteSchema.optional(),
  /** Set when this run is a what-if fork of another run. */
  forkedFrom: ForkOriginSchema.optional(),
})

export const CommandResultSchema = z.object({
  applied: z.number(),
  /** True when this key was already committed; `state` is then the latest board. */
  duplicate: z.boolean(),
  state: RunSchema,
})

export const JoinResponseSchema = z.object({ role: RoleSchema })

export const NoteSchema = z.object({
  recordId: z.string(),
  data: z.object({ text: z.string(), author: z.string() }),
})

export const CreatedRunSchema = z.object({ id: z.string() })

export const InviteResponseSchema = z.object({ invite: InviteSchema })

export const ErrorResponseSchema = z.object({ error: z.string() })

// ---------------------------------------------------------------------------
// After-action debrief
// ---------------------------------------------------------------------------

const DebriefMoveSchema = z.object({
  turn: z.number(),
  to: z.string(),
  qty: z.number(),
  arrival: z.number(),
})

/** Deterministic findings computed from the replay frames (src/domain/analysis.ts). */
export const DebriefFactsSchema = z.object({
  title: z.string(),
  finalTurn: z.number(),
  target: z.number(),
  score: ScoreSchema,
  shipments: z.number(),
  firstDispatchTurn: z.number().nullable(),
  sites: z.array(
    z.object({
      name: z.string(),
      priority: z.enum(['standard', 'high', 'critical']),
      delivered: z.number(),
      demand: z.number(),
      unmet: z.number(),
    }),
  ),
  /** Turns a truck sat at a stocked depot while open demand it could reach in time existed. */
  idleTrucks: z.array(
    z.object({
      truck: z.string(),
      depot: z.string(),
      turns: z.array(z.number()),
      /** The engine-checked dispatch the truck could have made on its first and last idle turn. */
      firstMove: DebriefMoveSchema.nullable().optional(),
      lastMove: DebriefMoveSchema.nullable().optional(),
    }),
  ),
  /** Cargo still on the road when the operation closed. */
  inTransitAtClose: z.array(
    z.object({
      shipment: z.string(),
      truck: z.string(),
      to: z.string(),
      qty: z.number(),
      arrival: z.number(),
    }),
  ),
  /** Shipments that took longer than they would have on the open network. */
  rerouted: z.array(
    z.object({ shipment: z.string(), truck: z.string(), to: z.string(), extraTurns: z.number() }),
  ),
  floodLoss: z.number(),
  /**
   * Whether the flood loss was avoidable, decided by the engine. Absent when nothing was lost
   * (and on facts computed before this field existed).
   */
  floodReview: z
    .object({
      lost: z.number(),
      avoidable: z.boolean(),
      /** The flooded depot's name and the turn it flooded; absent on facts from before scenarios. */
      depot: z.string().optional(),
      turn: z.number().optional(),
      /** The latest turn on which one of the options could still have been issued. */
      lastChanceTurn: z.number().nullable(),
      /** The only moves proven feasible; empty when the loss was unavoidable. */
      options: z.array(
        z.object({
          turn: z.number(),
          truck: z.string(),
          from: z.string(),
          to: z.string(),
          qty: z.number(),
          arrival: z.number(),
          /** Units kept out of the flood by this move. */
          saves: z.number(),
          /** The shipment this fuller load would have replaced, or null for an extra dispatch. */
          instead: z.string().nullable(),
        }),
      ),
      /** Why nothing could be done, when avoidable is false. */
      reason: z.string().nullable(),
    })
    .optional(),
  timeline: z.array(z.object({ turn: z.number(), kind: EntrySchema.shape.kind, text: z.string() })),
})

/** What the model writes. Lengths are enforced after generation, not in the model's schema. */
export const DebriefNarrativeSchema = z.object({
  headline: z.string(),
  wentWell: z.array(z.string()),
  costUs: z.array(z.string()),
  nextTime: z.array(z.string()),
})

export const DebriefResponseSchema = z.object({
  facts: DebriefFactsSchema,
  narrative: DebriefNarrativeSchema.nullable(),
  /** The model that wrote the narrative, when there is one. */
  model: z.string().nullable(),
  /** Whether this caller may ask for the narrative to be written now. */
  canGenerate: z.boolean(),
  /** Why the narrative is missing, when it is. */
  note: z.string().nullable(),
})

// ---------------------------------------------------------------------------
// WebSocket messages (server to client)
// ---------------------------------------------------------------------------

export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), state: RunSchema, role: RoleSchema.optional() }),
  z.object({ type: z.literal('presence'), peers: z.array(z.string()) }),
  z.object({ type: z.literal('note'), note: NoteSchema }),
])

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type Site = z.infer<typeof SiteSchema>
export type Road = z.infer<typeof RoadSchema>
export type Truck = z.infer<typeof TruckSchema>
export type Shipment = z.infer<typeof ShipmentSchema>
export type Entry = z.infer<typeof EntrySchema>
export type Run = z.infer<typeof RunSchema>
export type Role = z.infer<typeof RoleSchema>
export type Command = z.infer<typeof CommandSchema>
export type Envelope = z.infer<typeof EnvelopeSchema>
export type Operator = z.infer<typeof OperatorSchema>
export type StationRequest = z.infer<typeof StationRequestSchema>
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>
export type ForkRequest = z.infer<typeof ForkRequestSchema>
export type ForkOrigin = z.infer<typeof ForkOriginSchema>
export type NoteRequest = z.infer<typeof NoteRequestSchema>
export type Disruption = z.infer<typeof DisruptionSchema>
export type Scenario = z.infer<typeof ScenarioSchema>
export type LeaderboardResponse = z.infer<typeof LeaderboardResponseSchema>
export type RunSummary = z.infer<typeof RunSummarySchema>
export type DirectoryResponse = z.infer<typeof DirectoryResponseSchema>
export type StateResponse = z.infer<typeof StateResponseSchema>
export type CommandResult = z.infer<typeof CommandResultSchema>
export type Note = z.infer<typeof NoteSchema>
export type ServerMessage = z.infer<typeof ServerMessageSchema>
export type DebriefFacts = z.infer<typeof DebriefFactsSchema>
export type DebriefNarrative = z.infer<typeof DebriefNarrativeSchema>
export type DebriefResponse = z.infer<typeof DebriefResponseSchema>

/** A Durable Object RPC result. Errors cross the RPC boundary as data, not exceptions. */
export type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string }
