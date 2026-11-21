import type { Env } from '../../worker'

/**
 * Calls a RecordRoom tool as a trusted app action on behalf of `actor`.
 *
 * DispatchDeck's collections deny every client role (see
 * src/schemas/dispatch.ts), so browsers cannot read or write them directly.
 * The Worker checks identity and membership first, then writes here.
 */
export async function recordTool<T = RecordData>(
  env: Env,
  scope: string,
  actor: string,
  tool: 'records.create' | 'records.get' | 'records.query' | 'records.update',
  params: Record<string, unknown>,
): Promise<T> {
  const room = env.RECORD_ROOMS.get(env.RECORD_ROOMS.idFromName(scope))
  const res = await room.fetch('https://internal/api/tools/execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-App-Action': 'true', 'X-User-Id': actor },
    body: JSON.stringify({ tool, params }),
  })
  const value = (await res.json()) as { success: boolean; error?: string; data?: T }
  if (!value.success) throw new Error(value.error ?? 'RecordRoom unavailable')
  return value.data as T
}

export type StoredRecord = { recordId: string; data: Record<string, unknown> }
export type RecordData = { records?: StoredRecord[]; record?: StoredRecord | null }

/** The directory of operations, shared by every operator. */
export const directoryScope = (env: Env) => 'app:' + env.DEEPSPACE_APP_ID
/** One operation's crew notes. */
export const notesScope = (runId: string) => 'notes:' + runId
