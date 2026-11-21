/**
 * Worker entry point: DeepSpace platform routes plus the DispatchDeck API.
 *
 * Registration order matters. App routes come first, then the platform's auth
 * and proxy routes, and the SPA fallback is last so it cannot shadow an API.
 */
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { RecordRoom, workerErrorHandler } from 'deepspace/worker'
import type { DOBindings, DOManifest } from 'deepspace/worker'
import type { DebriefBudget } from './src/server/debrief'
import type { SimulationRoom } from './src/server/simulation'
import { schemas } from './src/schemas'
import { registerDispatch } from './src/server/dispatch-routes'
import {
  registerAuthAndIntegrationRoutes,
  registerPlatformProxyRoutes,
  registerStaticRoutes,
} from './src/server/http-routes'

export { SimulationRoom } from './src/server/simulation'
export { DebriefBudget } from './src/server/debrief'

// The deploy reads this manifest to create the Durable Object bindings.
export const __DO_MANIFEST__ = [
  { binding: 'SIMULATION_ROOMS', className: 'SimulationRoom', sqlite: true },
  { binding: 'RECORD_ROOMS', className: 'AppRecordRoom', sqlite: true },
  { binding: 'DEBRIEF_BUDGET', className: 'DebriefBudget', sqlite: true },
] as const satisfies DOManifest

/** Shared records: the operation directory and each operation's crew notes. */
export class AppRecordRoom extends RecordRoom<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env, schemas, { ownerUserId: env.OWNER_USER_ID })
  }
}

export interface Env
  extends Omit<DOBindings<typeof __DO_MANIFEST__>, 'SIMULATION_ROOMS' | 'DEBRIEF_BUDGET'> {
  /** Typed so the Worker calls SimulationRoom's RPC methods with checked arguments. */
  SIMULATION_ROOMS: DurableObjectNamespace<SimulationRoom>
  /** The app-wide daily cap on paid debriefs. */
  DEBRIEF_BUDGET: DurableObjectNamespace<DebriefBudget>
  ASSETS: Fetcher
  /** Platform service binding in production; `deepspace dev` supplies the URL. */
  PLATFORM_WORKER?: Fetcher
  PLATFORM_WORKER_URL?: string
  /** HMAC app credential minted on first deploy; identifies this app upstream. */
  APP_IDENTITY_TOKEN?: string
  /** API service binding in production with a `deepspace dev` URL fallback. */
  API_WORKER?: Fetcher
  API_WORKER_URL?: string
  AUTH_JWT_PUBLIC_KEY: string
  AUTH_JWT_ISSUER: string
  AUTH_WORKER_URL: string
  /** Comma-separated exact native callback URIs (unused by the web client). */
  NATIVE_AUTH_REDIRECT_URIS?: string
  APP_NAME: string
  /** Immutable record-scope and platform identity. */
  DEEPSPACE_APP_ID: string
  OWNER_USER_ID: string
  /** Signs training-station cookies. Set with `deepspace secrets set`; 32+ characters. */
  STATION_SIGNING_KEY?: string
  /** The previous signing key, accepted for verification during a rotation. */
  STATION_SIGNING_KEY_PREVIOUS?: string
  /** Owner JWT for developer-billed server calls (the after-action debrief). */
  APP_OWNER_JWT: string
  /** Enables /api/debug/* only when exactly "true", and only for admins. */
  ALLOW_DEBUG_ROUTES?: string
  /** Comma-separated run ids shown as "Featured replays" in the directory. */
  FEATURED_RUNS?: string
}

export type AppContext = { Bindings: Env }

const app = new Hono<AppContext>()
app.use('/api/*', cors())

registerDispatch(app)
registerAuthAndIntegrationRoutes(app)
registerPlatformProxyRoutes(app)
registerStaticRoutes(app)

// Logs the error message (Workers Logs drops console.error's default form)
// and answers with a generic 500.
app.onError(workerErrorHandler('error'))

export default app
