import { resolveSessionReadAuth, SESSION_COOKIE } from 'deepspace/worker'
import type { Operator } from '../domain/protocol.ts'
import type { Env } from '../../worker'
import { resolveAgentAuth, resolveAuth } from './http-routes'

export type { Operator }

/**
 * Identity. An Operator's `uid` is the authority (memberships key to it); `name` is a
 * display label only.
 *
 * Two kinds of caller exist:
 * - DeepSpace accounts (`ds:<userId>`), verified by the platform's JWT or
 *   session cookie.
 * - Training stations (`station:<uuid>`): a guest identity in an HttpOnly
 *   cookie signed by this Worker. The platform's anonymous ids (`anon-…`) are
 *   minted per WebSocket connection, so they cannot hold commander authority
 *   across reloads; the station cookie can, without asking a guest to sign up.
 */

export const STATION_COOKIE = 'dd_station'
const STATION_DAYS = 30
const STATION_MAX_AGE_MS = STATION_DAYS * 86_400_000
const SIGNATURE_CONTEXT = 'dispatchdeck-station-v1/'

/**
 * Stations issued before STATION_SIGNING_KEY existed were signed with the
 * platform's app token. They are still verified until the last of them
 * expires (30 days after the key change), then that path closes by itself.
 */
const LEGACY_KEY_ACCEPTED_UNTIL = Date.parse('2026-12-21T00:00:00Z')

const STATION_PATTERN =
  /(?:^|; )dd_station=([a-f0-9-]{36})\.([0-9]{13})\.([A-Za-z0-9%._~-]+)\.([0-9a-f]{64})(?=;|$)/

const encoder = new TextEncoder()
const keyCache = new Map<string, Promise<CryptoKey>>()

function hmacKey(secret: string) {
  let key = keyCache.get(secret)
  if (!key) {
    key = crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    )
    keyCache.set(secret, key)
  }
  return key
}

/** The key new stations are signed with. Fails closed when it is not configured. */
function signingSecret(env: Env) {
  const secret = env.STATION_SIGNING_KEY
  if (!secret || secret.length < 32)
    throw new Error('STATION_SIGNING_KEY is missing or shorter than 32 characters.')
  return secret
}

/** Keys a presented station may be signed with, newest first. */
function verificationSecrets(env: Env) {
  const secrets = [env.STATION_SIGNING_KEY, env.STATION_SIGNING_KEY_PREVIOUS]
  if (Date.now() < LEGACY_KEY_ACCEPTED_UNTIL)
    secrets.push(env.APP_IDENTITY_TOKEN || env.APP_OWNER_JWT)
  return secrets.filter((s): s is string => !!s && s.length >= 32)
}

const toHex = (b: ArrayBuffer) =>
  Array.from(new Uint8Array(b), (v) => v.toString(16).padStart(2, '0')).join('')
const fromHex = (s: string) => Uint8Array.from(s.match(/../g)!, (v) => parseInt(v, 16))

/** Creates a station and the Set-Cookie header that stores it in this browser. */
export async function issueStation(env: Env, name: string) {
  const id = crypto.randomUUID()
  const payload = [id, Date.now() + STATION_MAX_AGE_MS, encodeURIComponent(name)].join('.')
  const key = await hmacKey(signingSecret(env))
  const signature = toHex(
    await crypto.subtle.sign('HMAC', key, encoder.encode(SIGNATURE_CONTEXT + payload)),
  )
  const cookie = `${STATION_COOKIE}=${payload}.${signature}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${STATION_MAX_AGE_MS / 1000}`
  return { operator: { uid: 'station:' + id, name }, cookie }
}

async function verifyStation(env: Env, cookie: string): Promise<Operator | null> {
  const m = STATION_PATTERN.exec(cookie)
  if (!m || Number(m[2]) < Date.now()) return null
  const signed = encoder.encode(SIGNATURE_CONTEXT + m.slice(1, 4).join('.'))
  const signature = fromHex(m[4])
  for (const secret of verificationSecrets(env)) {
    // crypto.subtle.verify compares in constant time.
    if (await crypto.subtle.verify('HMAC', await hmacKey(secret), signature, signed))
      return { uid: 'station:' + m[1], name: decodeURIComponent(m[3]) }
  }
  return null
}

/** Display name for a DeepSpace account: its profile name, else a short id. */
function accountName(userId: string, claimedName: unknown) {
  const name = typeof claimedName === 'string' ? claimedName.trim().slice(0, 28) : ''
  return name || 'Operator ' + userId.slice(-5)
}

/**
 * Resolves the caller from, in order: a bearer token (DeepSpace JWT or agent
 * token), the DeepSpace session cookie, or a signed station cookie.
 */
export async function identify(req: Request, env: Env): Promise<Operator | null> {
  const cookie = req.headers.get('Cookie') ?? ''
  let auth = null
  if (req.headers.has('Authorization')) {
    auth = (await resolveAuth(req, env)) ?? (await resolveAgentAuth(req, env))
  } else if (cookie.includes(SESSION_COOKIE + '=')) {
    // A browser WebSocket upgrade cannot send Sec-Fetch-Site, which the
    // session reader requires. The Origin check below stands in for it.
    const sameOriginSocket =
      req.method === 'GET' &&
      req.headers.get('Upgrade')?.toLowerCase() === 'websocket' &&
      req.headers.get('Origin') === new URL(req.url).origin
    const readable = sameOriginSocket
      ? new Request(req.url, { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' } })
      : req
    auth = await resolveSessionReadAuth(readable, env)
  }
  if (auth) return { uid: 'ds:' + auth.userId, name: accountName(auth.userId, auth.claims.name) }
  return verifyStation(env, cookie)
}
