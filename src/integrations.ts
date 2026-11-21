/**
 * Integrations the browser may call through `/api/integrations/:name/:endpoint`.
 *
 * The proxy in src/server/http-routes.ts forwards only names listed here, so an
 * empty map means visitors cannot spend the app owner's credits directly.
 * DispatchDeck's one integration, the after-action debrief, runs server-side
 * in src/server/debrief.ts with its own per-run cache and daily cap.
 */
export const integrations: Record<string, { billing: 'developer' | 'user'; anonymous?: boolean }> =
  {}
