/**
 * Live acceptance test: two isolated browsers against a deployed DispatchDeck.
 *
 *   DECK_URL=https://dispatchdeck.spacestest.com node tests/dispatch.e2e.ts
 *
 * Optional: DECK_BROWSER=<path to a Chromium executable>, DECK_DEBRIEF=1 to
 * also generate the AI debrief (one paid model call). Creates one practice
 * operation named "Coastal response drill" on the explicit "classic" seed (the
 * assertions below assume the classic numbers, and a test run must never reach
 * the daily leaderboard), plus a few unstarted seeded runs for the seed checks.
 */
import assert from 'node:assert/strict'
import {
  chromium,
  type BrowserContext,
  type Page,
  type WebSocket as PwWebSocket,
  type WebSocketRoute,
} from '@playwright/test'
import type { z } from 'zod'
import { availableDemand, route, score } from '../src/domain/engine.ts'
import {
  CommandResultSchema,
  CreatedRunSchema,
  DebriefResponseSchema,
  LeaderboardResponseSchema,
  NoteSchema,
  OperatorSchema,
  DirectoryResponseSchema,
  StateResponseSchema,
  type Command,
  type Envelope,
  type Run,
} from '../src/domain/protocol.ts'

const base = process.env.DECK_URL ?? 'https://dispatchdeck.spacestest.com'
const browser = await chromium.launch({
  headless: true,
  ...(process.env.DECK_BROWSER ? { executablePath: process.env.DECK_BROWSER } : {}),
})
const commanderCtx = await browser.newContext({ baseURL: base })
const dispatcherCtx = await browser.newContext({
  baseURL: base,
  viewport: { width: 390, height: 844 },
})
const p = await commanderCtx.newPage()
const q = await dispatcherCtx.newPage()
const pageErrors: string[] = []
for (const page of [p, q]) page.on('pageerror', (err) => pageErrors.push(err.message))

type Reply = { status: number; body: unknown }
async function call(ctx: BrowserContext, path: string, body?: unknown): Promise<Reply> {
  const res =
    body === undefined
      ? await ctx.request.get('/api/deck/' + path)
      : await ctx.request.post('/api/deck/' + path, { data: body })
  return { status: res.status(), body: await res.json() }
}
/** Asserts a 2xx reply and parses it with the protocol schema the app uses. */
function expectOk<S extends z.ZodType>(reply: Reply, schema: S): z.infer<S> {
  assert.ok(
    reply.status < 300,
    `expected success, got ${reply.status}: ${JSON.stringify(reply.body)}`,
  )
  return schema.parse(reply.body)
}
const envelope = (version: number, command: Command): Envelope => ({
  key: crypto.randomUUID(),
  version,
  command,
})
const dispatch = (truck: string, to: string, qty: number): Command => ({
  type: 'dispatch',
  truck,
  to,
  qty,
})
const step = (name: string) => console.log('  ✓ ' + name)

async function openStation(page: Page, callSign: string) {
  await page.getByLabel('Operator call sign').fill(callSign)
  await page.getByRole('button', { name: 'Open station', exact: true }).last().click()
}

try {
  assert.equal((await call(dispatcherCtx, 'runs')).status, 401)
  step('anonymous callers are refused')

  // -- Commander creates the operation ---------------------------------------
  await p.goto('/')
  await p.getByRole('heading', { name: 'Coastal Supply Crisis.' }).waitFor()
  await p.getByRole('button', { name: 'Read field guide' }).click()
  await p.getByRole('heading', { name: 'Coastal field guide' }).waitFor()
  await p.getByRole('button', { name: 'Close', exact: true }).click()
  await p.getByRole('button', { name: 'Create operation', exact: true }).click()
  await openStation(p, 'Harbor Control')
  await p.getByLabel('Operation name').fill('Coastal response drill')
  await p.getByRole('radio', { name: /^Classic/ }).check()
  await p.getByRole('button', { name: 'Create command room' }).click()
  await p.waitForURL('**/runs/*', { timeout: 30000 })
  const url = new URL(p.url())
  const id = url.pathname.split('/').pop()!
  const run = (op: string) => `runs/${id}/${op}`
  const commanderView = async () =>
    expectOk(await call(commanderCtx, run('state')), StateResponseSchema)
  const state = async (): Promise<Run> => (await commanderView()).state
  const invite = (await commanderView()).invite
  assert.ok(invite, 'the commander receives the invite code')
  assert.equal((await state()).scenario, undefined, 'classic carries no scenario field')
  await p.getByText('Classic', { exact: true }).first().waitFor()
  console.log('Created operation', id)

  // -- A second operator without the invite can only watch -------------------
  await q.goto(url.href)
  await q.getByRole('button', { name: 'Open station' }).click()
  await openStation(q, 'Valley Dispatch')
  await q.getByText('Ask the commander for an invite link').waitFor()
  assert.equal(await q.getByRole('button', { name: 'Join as dispatcher' }).count(), 0)
  assert.equal((await call(dispatcherCtx, run('join'), { invite: 'x'.repeat(24) })).status, 403)
  assert.equal((await call(dispatcherCtx, run('notes'), { text: 'Spam' })).status, 403)
  assert.equal(
    (await call(dispatcherCtx, run('command'), envelope(0, { type: 'start' }))).status,
    403,
  )
  assert.equal(
    StateResponseSchema.parse((await call(dispatcherCtx, run('state'))).body).invite,
    undefined,
  )
  step('without the invite: watch only, no join, notes or commands, no invite code leaked')

  // -- Joining through the invite link ---------------------------------------
  await q.goto(url.href + '#invite=' + invite)
  await q.getByRole('button', { name: 'Join as dispatcher' }).click()
  await q.getByRole('button', { name: 'Dispatch shipment' }).waitFor()
  await q.waitForFunction(() => !location.hash)
  step('the invite link joins as dispatcher and is cleared from the address bar')

  await p.getByRole('button', { name: 'Start operation' }).click()
  await q.waitForFunction(
    () =>
      !Array.from(document.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Dispatch shipment'),
      )?.disabled,
  )
  const started = await state()
  assert.equal(started.phase, 'running')

  // -- Two orders for the same truck: exactly one commits ---------------------
  const sameTruck = [commanderCtx, dispatcherCtx].map(() =>
    envelope(started.version, dispatch('T-01', 'harbor', 25)),
  )
  const attempts = await Promise.all(
    [commanderCtx, dispatcherCtx].map((c, i) => call(c, run('command'), sameTruck[i])),
  )
  assert.deepEqual(attempts.map((r) => r.status).sort(), [200, 409])
  const winner = attempts.findIndex((r) => r.status === 200)
  const receipt = expectOk(
    await call([commanderCtx, dispatcherCtx][winner], run('command'), sameTruck[winner]),
    CommandResultSchema,
  )
  assert.equal(receipt.duplicate, true)
  step(
    'simultaneous orders for one truck: one commits, the other gets 409, retry returns the receipt',
  )

  // -- Two orders for different trucks planned on the same board: both commit -
  const planned = (await state()).version
  const different = await Promise.all([
    call(commanderCtx, run('command'), envelope(planned, dispatch('T-03', 'valley', 30))),
    call(dispatcherCtx, run('command'), envelope(planned, dispatch('T-04', 'school', 20))),
  ])
  assert.deepEqual(
    different.map((r) => r.status),
    [200, 200],
  )
  step('simultaneous orders for different trucks both commit')

  await q.getByText('T-01 dispatched 25 units to Harbor Clinic.').waitFor()
  await q.reload()
  await q.getByText('T-01 dispatched 25 units to Harbor Clinic.').waitFor()
  assert.equal((await state()).sites.find((s) => s.id === 'north')?.stock, 35)
  step('the dispatcher sees committed orders live and after a reload')

  // -- An interrupted confirmation never replaces the next order --------------
  await p.route(
    '**/api/deck/runs/*/command',
    async (route) => {
      await route.fetch() // The server commits the order...
      await route.abort('failed') // ...but the browser never hears back.
    },
    { times: 1 },
  )
  await p.getByLabel('Fleet vehicle').selectOption('T-02')
  await p.getByLabel('Destination').selectOption('city')
  await p.getByLabel('Cargo units').fill('20')
  await p.getByRole('button', { name: 'Dispatch shipment' }).click()
  await p.getByText('Confirmation interrupted').waitFor()
  await p.getByRole('button', { name: 'Retry dispatch of 20 units on T-02' }).waitFor()
  await p.getByRole('button', { name: 'Advance time' }).click()
  await p.getByText('Advanced to turn 1.').waitFor()
  const afterInterrupt = await state()
  assert.equal(afterInterrupt.tick, 1)
  assert.equal(afterInterrupt.shipments.filter((sh) => sh.truck === 'T-02').length, 1)
  step('after a dropped confirmation, the next order is sent as itself')

  // -- Stale plans and roles --------------------------------------------------
  const stale = await call(
    dispatcherCtx,
    run('command'),
    envelope(planned, dispatch('T-01', 'harbor', 10)),
  )
  assert.equal(stale.status, 409)
  assert.match(JSON.stringify(stale.body), /Time advanced/)
  const dispatcherAdvance = await call(
    dispatcherCtx,
    run('command'),
    envelope(afterInterrupt.version, { type: 'advance' }),
  )
  assert.equal(dispatcherAdvance.status, 403)
  step('orders planned before the turn advanced are refused; dispatchers cannot advance')

  // -- A run that is still going cannot be forked ----------------------------
  const early = await call(commanderCtx, run('fork'), { id: crypto.randomUUID(), turn: 0 })
  assert.equal(early.status, 409)
  step('an incomplete operation cannot be forked')

  // -- Live crew notes -------------------------------------------------------
  await q.getByRole('button', { name: 'Notes', exact: true }).click()
  await q.getByLabel('Shared crew note').fill('North fleet committed.')
  await q.getByRole('button', { name: 'Post note' }).click()
  await p.getByRole('button', { name: 'Notes', exact: true }).click()
  await p.getByText('North fleet committed.').waitFor()
  await p.getByRole('button', { name: 'Activity', exact: true }).click()
  step('a crew note reaches the other browser live')

  // -- A failed first state read still ends in a live socket ------------------
  const recovering = await commanderCtx.newPage()
  const recoveringSockets: PwWebSocket[] = []
  recovering.on('websocket', (ws) => recoveringSockets.push(ws))
  await recovering.route('**/api/deck/runs/*/state', (route) => route.abort('failed'), { times: 1 })
  await recovering.goto(url.href)
  await recovering.getByRole('button', { name: 'Reconnect' }).waitFor()
  // No reload: the 6 s recovery poll restores the board and must then open the socket.
  await recovering.getByText(/LIVE · \d+ ONLINE/).waitFor({ timeout: 30000 })
  assert.ok(
    recoveringSockets.some((ws) => !ws.isClosed()),
    'a live socket is open after recovery',
  )
  await recovering.close()
  step('an interrupted first state read recovers to LIVE with an open socket, no reload')

  // -- Notes posted while an observer is offline arrive after it reconnects ---
  const observer = await dispatcherCtx.newPage()
  let socketsBlocked = false
  const routed: WebSocketRoute[] = []
  await observer.routeWebSocket('**/live', (ws) => {
    if (socketsBlocked) return void ws.close()
    ws.connectToServer()
    routed.push(ws)
  })
  await observer.goto(url.href)
  await observer.getByText(/LIVE · \d+ ONLINE/).waitFor({ timeout: 30000 })
  await observer.getByRole('button', { name: 'Notes', exact: true }).click()
  socketsBlocked = true
  for (const ws of routed.splice(0)) await ws.close()
  await observer.getByText(/RECONNECTING/).waitFor()
  await observer.getByRole('button', { name: 'Reconnect' }).waitFor()
  const missed = 'Posted while you were offline.'
  expectOk(await call(commanderCtx, run('notes'), { text: missed }), NoteSchema)
  assert.equal(await observer.getByText(missed).count(), 0)
  socketsBlocked = false
  await observer.getByText(/LIVE · \d+ ONLINE/).waitFor({ timeout: 30000 })
  await observer.getByText(missed).waitFor({ timeout: 30000 })
  assert.equal(await observer.getByText('North fleet committed.').count(), 1, 'no duplicates')
  await observer.close()
  step('a note posted while an observer was disconnected appears after it reconnects')

  // -- Disruptions, deadline, report and replay -------------------------------
  await p.getByRole('button', { name: 'Advance time' }).click()
  await p.getByText('East corridor closed. New dispatches must reroute.').waitFor()
  let current = await state()
  while (current.tick < 12) {
    current = expectOk(
      await call(commanderCtx, run('command'), envelope(current.version, { type: 'advance' })),
      CommandResultSchema,
    ).state
  }
  assert.equal(current.phase, 'completed')
  await p.getByRole('link', { name: 'Open report' }).click()
  await p.getByRole('heading', { name: /Delivery target (met|missed)/ }).waitFor()
  const slider = p.getByRole('slider', { name: 'Replay frame' })
  // The report renders before its replay history loads; scrub only once the slider spans it.
  await p.locator(`input[aria-label="Replay frame"][max="${current.version}"]:enabled`).waitFor()
  await slider.focus()
  await slider.press('Home')
  await p.getByText('Replay frame 0 /').waitFor()
  const history = (await call(dispatcherCtx, run('history'))).body as Run[]
  assert.equal(history.at(-1)?.version, current.version)
  step('the road closure, deadline, final report and replay work')

  // -- After-action debrief -------------------------------------------------
  await p.getByRole('heading', { name: 'After-action debrief' }).waitFor()
  await p.getByText('What the replay shows').waitFor()
  const facts = expectOk(await call(commanderCtx, run('debrief')), DebriefResponseSchema)
  assert.ok(facts.facts.idleTrucks.length > 0, 'this scripted run leaves trucks idle')
  assert.equal(facts.canGenerate, !facts.narrative)
  step('the report shows deterministic findings from the replay')
  if (process.env.DECK_DEBRIEF === '1' && !facts.narrative) {
    await p.getByRole('button', { name: 'Write the AI debrief' }).click()
    await p.getByText(/Written by claude-/).waitFor({ timeout: 120_000 })
    const written = expectOk(await call(dispatcherCtx, run('debrief')), DebriefResponseSchema)
    assert.ok(written.narrative?.headline)
    assert.equal(written.canGenerate, false)
    // Asking again returns the stored debrief instead of paying for another.
    const again = expectOk(await call(commanderCtx, run('debrief'), {}), DebriefResponseSchema)
    assert.deepEqual(again.narrative, written.narrative)
    step('the AI debrief is written once, shared with the crew and cached')
  }

  // -- What-if fork from the replay ------------------------------------------
  // Who may fork: members of a completed run only, with a valid fork point.
  const stranger = await browser.newContext({ baseURL: base })
  expectOk(await call(stranger, 'station', { name: 'Passerby One' }), OperatorSchema)
  const forkBody = (turn: number, before?: string) => ({ id: crypto.randomUUID(), turn, before })
  assert.equal((await call(stranger, run('fork'), forkBody(0))).status, 403)
  await stranger.close()
  assert.equal((await call(commanderCtx, run('fork'), forkBody(12))).status, 422)
  assert.equal((await call(commanderCtx, run('fork'), forkBody(0, 'S-99'))).status, 422)
  assert.equal(
    (await call(commanderCtx, run('fork'), { id: id, turn: 0 })).status,
    409,
    'a fork cannot reuse the source id',
  )
  step('forking needs membership, a completed run, a real fork point and a fresh id')

  // From the replay slider: the commander's page forks the frame it is showing.
  await slider.focus()
  await slider.press('Home')
  await p.getByRole('button', { name: 'Play a what-if from turn 0' }).click()
  await p.waitForURL((u) => u.pathname.startsWith('/runs/') && !u.pathname.includes(id), {
    timeout: 30000,
  })
  const sliderForkId = p.url().split('/').pop()!
  const sliderFork = expectOk(
    await call(commanderCtx, `runs/${sliderForkId}/state`),
    StateResponseSchema,
  )
  assert.deepEqual(sliderFork.forkedFrom, { id, turn: 0 })
  assert.equal(sliderFork.role, 'commander')
  assert.equal(sliderFork.state.phase, 'running')
  assert.equal(sliderFork.state.tick, 0)
  await p.getByText(/What-if of Coastal response drill/).waitFor()
  step('the replay slider forks the board into a new live run, linked back to the original')

  // "Try this": fork before T-04's dispatch, where it could have carried more.
  const shipment = history.at(-1)!.shipments.find((sh) => sh.truck === 'T-04')!
  const fork = { id: crypto.randomUUID(), turn: shipment.departure, before: shipment.id }
  const forkId = expectOk(await call(commanderCtx, run('fork'), fork), CreatedRunSchema).id
  assert.equal(forkId, fork.id)
  // A retried request with the same id returns the same run; a different board is a conflict.
  const retried = expectOk(await call(commanderCtx, run('fork'), fork), CreatedRunSchema)
  assert.equal(retried.id, forkId)
  assert.equal((await call(commanderCtx, run('fork'), { ...fork, before: undefined })).status, 409)
  assert.equal((await call(dispatcherCtx, run('fork'), fork)).status, 409)
  const forkRoom = (op: string) => `runs/${forkId}/${op}`
  const forkView = async () =>
    expectOk(await call(commanderCtx, forkRoom('state')), StateResponseSchema)
  let forked = (await forkView()).state
  assert.equal(forked.phase, 'running')
  assert.equal(forked.version, 0)
  assert.notEqual(forked.id, id)
  assert.match(forked.title, /Coastal response drill — what-if from turn 0/)
  assert.equal(forked.fleet.find((v) => v.id === 'T-04')?.status, 'ready')
  const view = await call(dispatcherCtx, forkRoom('state'))
  assert.equal(StateResponseSchema.parse(view.body).role, 'observer', 'only the forker commands it')
  const listed = expectOk(await call(commanderCtx, 'runs'), DirectoryResponseSchema).mine
  assert.deepEqual(listed.find((r) => r.id === forkId)?.forkedFrom, { id, turn: 0 })
  step('"Try this" forks just before the dispatch; retries are idempotent; "mine" lists it')

  // The directory is per operator: the joined dispatcher sees the run, a fresh
  // station sees neither it nor its forks, so practice runs never clutter it.
  const crewList = expectOk(await call(dispatcherCtx, 'runs'), DirectoryResponseSchema).mine
  assert.ok(
    crewList.some((r) => r.id === id),
    'a joined dispatcher lists the run',
  )
  const visitor = await browser.newContext({ baseURL: base })
  expectOk(await call(visitor, 'station', { name: 'Passerby Two' }), OperatorSchema)
  const seen = expectOk(await call(visitor, 'runs'), DirectoryResponseSchema)
  assert.deepEqual(
    seen.mine.filter((r) => r.id === id || r.id === forkId || r.forkedFrom?.id === id),
    [],
    'a non-member sees neither the run nor its forks in mine',
  )
  assert.ok(!seen.featured.some((r) => r.id === id || r.id === forkId))
  await visitor.close()
  step('a fresh station sees neither the run nor its forks in its directory')

  // Play the alternative: give T-04 the biggest load the board now allows.
  const depot = forked.sites.find((n) => n.id === 'east')!
  const target = forked.sites
    .filter((n) => n.kind === 'relief' && route(forked.roads, 'east', n.id))
    .sort((a, b) => availableDemand(forked, b.id) - availableDemand(forked, a.id))[0]
  const qty = Math.min(
    forked.fleet.find((v) => v.id === 'T-04')!.capacity,
    depot.stock,
    availableDemand(forked, target.id),
  )
  const sent = expectOk(
    await call(
      commanderCtx,
      forkRoom('command'),
      envelope(forked.version, dispatch('T-04', target.id, qty)),
    ),
    CommandResultSchema,
  )
  assert.equal(sent.state.shipments.at(-1)?.qty, qty)
  forked = sent.state
  while (forked.phase === 'running') {
    forked = expectOk(
      await call(commanderCtx, forkRoom('command'), envelope(forked.version, { type: 'advance' })),
      CommandResultSchema,
    ).state
  }
  assert.equal(forked.tick, 12, 'the deadline still ends the what-if on turn 12')
  assert.ok(
    forked.log.some((e) => e.text.includes('Flooding at East Hub')),
    'scheduled disruptions still fire after the fork point',
  )
  const forkHistory = (await call(commanderCtx, forkRoom('history'))).body as Run[]
  assert.equal(forkHistory[0].version, 0)
  assert.equal(forkHistory.at(-1)?.version, forked.version)

  const originalRate = score(history.at(-1)!).rate
  const forkRate = score(forked).rate
  await p.goto(`/runs/${forkId}/report`)
  await p.getByRole('heading', { name: /Delivery target (met|missed)/ }).waitFor()
  await p.getByText(/What-if of Coastal response drill from turn 0/).waitFor()
  const compare = p.getByLabel('Original and what-if scores')
  await compare.waitFor()
  const text = await compare.innerText()
  assert.match(text, new RegExp(`Original run\\s+${originalRate}% delivered`))
  assert.match(text, new RegExp(`This what-if\\s+${forkRate}% delivered`))
  await p.getByRole('heading', { name: 'After-action debrief' }).waitFor()
  assert.equal(
    await p.getByRole('link', { name: 'Coastal response drill' }).first().getAttribute('href'),
    `/runs/${id}/report`,
  )
  step(`the what-if plays to the deadline and its report shows ${originalRate}% vs ${forkRate}%`)

  // -- Seeded scenarios ------------------------------------------------------
  const seeded = async (seed: string | undefined) => {
    const sid = crypto.randomUUID()
    expectOk(
      await call(commanderCtx, 'runs', { id: sid, title: 'Seed check', ...(seed && { seed }) }),
      CreatedRunSchema,
    )
    const { state: s } = expectOk(
      await call(commanderCtx, `runs/${sid}/state`),
      StateResponseSchema,
    )
    return s
  }
  // Everything that makes a scenario, without the per-run identity.
  const shape = (s: Run) => ({
    sites: s.sites,
    fleet: s.fleet,
    roads: s.roads,
    scenario: s.scenario,
  })
  const a = await seeded('e2e-fixed-seed')
  const b = await seeded('E2E-Fixed-Seed ')
  const other = await seeded('e2e-other-seed')
  assert.deepEqual(shape(a), shape(b), 'the same seed deals the same board and schedule')
  assert.equal(a.scenario?.seed, 'e2e-fixed-seed')
  assert.equal(a.scenario?.label, 'Seed: e2e-fixed-seed')
  assert.equal(a.scenario?.disruptions.length, 3)
  assert.notDeepEqual(shape(a), shape(other), 'a different seed deals a different game')
  assert.deepEqual(
    shape(await seeded('classic')),
    shape(await seeded(undefined)),
    'classic and an omitted seed are the same game',
  )
  assert.equal(
    (await call(commanderCtx, 'runs', { id: crypto.randomUUID(), title: 'Bad', seed: '<x>' }))
      .status,
    422,
  )
  const daily = await seeded('daily')
  assert.match(daily.scenario?.seed ?? '', /^daily-\d{4}-\d{2}-\d{2}$/)
  assert.match(daily.scenario?.label ?? '', /^Daily · /)
  step('seeds deal identical boards and schedules; another seed differs; bad seeds are refused')

  // The leaderboard indexes completed runs by seed. Every CI run adds a classic run with a
  // similar score, so "is mine ranked?" uses a seed of its own that only this test plays.
  const ownSeed = 'e2e-' + Date.now().toString(36)
  const rankedId = crypto.randomUUID()
  assert.equal(
    (await call(commanderCtx, 'runs', { id: rankedId, title: 'Ranked', seed: ownSeed })).status,
    200,
  )
  let ranked = expectOk(
    await call(commanderCtx, `runs/${rankedId}/state`),
    StateResponseSchema,
  ).state
  for (const command of [{ type: 'start' }, { type: 'finish' }] as const)
    ranked = expectOk(
      await call(commanderCtx, `runs/${rankedId}/command`, envelope(ranked.version, command)),
      CommandResultSchema,
    ).state
  assert.equal(ranked.phase, 'completed')
  // The summary is published in the background after each commit, so allow a moment.
  const boardFor = async (seed: string) =>
    expectOk(await call(commanderCtx, `leaderboard?seed=${seed}`), LeaderboardResponseSchema)
  let own = await boardFor(ownSeed)
  for (let i = 0; i < 20 && !own.entries.some((e) => e.id === rankedId); i++) {
    await new Promise((r) => setTimeout(r, 500))
    own = await boardFor(ownSeed)
  }
  const finished = own.entries.find((e) => e.id === rankedId)
  assert.ok(finished, 'a completed run is ranked on its seed')
  assert.equal(finished.rate, score(ranked).rate)

  const board = await boardFor('classic')
  assert.equal(board.label, 'Classic')
  assert.ok(board.entries.length <= 10)
  assert.ok(!board.entries.some((e) => e.id === forkId), 'what-if forks are never ranked')
  assert.deepEqual(
    board.entries.map((e) => [e.rate, e.weighted]),
    board.entries.map((e) => [e.rate, e.weighted]).sort((x, y) => y[0] - x[0] || y[1] - x[1]),
    'best first',
  )
  const empty = expectOk(
    await call(commanderCtx, 'leaderboard?seed=e2e-fixed-seed'),
    LeaderboardResponseSchema,
  )
  assert.deepEqual(empty.entries, [], 'unfinished seeded runs are not ranked')
  assert.equal((await call(commanderCtx, 'leaderboard?seed=%3Cx%3E')).status, 422)
  const anon = await browser.newContext({ baseURL: base })
  assert.equal((await call(anon, 'leaderboard')).status, 401)
  await anon.close()
  step('the classic leaderboard lists the completed run, best first, without forks')

  assert.equal(await q.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true)
  assert.deepEqual(pageErrors, [])
  step('no horizontal scroll at phone width and no page errors')
  console.log('PASS')
} catch (e) {
  const body = await p
    .locator('body')
    .innerText()
    .catch(() => '')
  console.error('Commander page:', p.url(), body.slice(-1400))
  throw e
} finally {
  await browser.close()
}
