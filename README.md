# DispatchDeck

[![CI](https://github.com/lraminen/dispatchdeck/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/lraminen/dispatchdeck/actions/workflows/ci.yml)

A cooperative, real-time logistics exercise on DeepSpace. A small crew moves relief
supplies across a fictional coastline: four trucks, three depots, five relief sites,
twelve turns, and a target of 80% delivered. Each run is dealt a seeded scenario (the
classic one has 150 units in stock and 140 requested, rising to 150).
A commander controls the clock; dispatchers reserve trucks and cargo; everyone sees every
commit live. When the run closes, a replay and an after-action debrief explain what
happened.

**Live:** [dispatchdeck.spacestest.com](https://dispatchdeck.spacestest.com) ·
**Sample report:** [East Corridor Relief Exercise](https://dispatchdeck.spacestest.com/runs/daee90ad-fce3-4cb4-88bf-3600e3eae74a/report)
(150 of 150 delivered)

## Try it in 60 seconds

Live: <https://dispatchdeck.spacestest.com>. No account needed; a guest "training
station" is enough.

**Solo path**

1. Open the live URL, choose **Create operation** and start as a guest station. "Today's scenario" is the default: everyone gets the same game today, and **Today's best crews** ranks finished runs.
2. Dispatch a truck (pick truck, destination, cargo), then **Advance**. Repeat, or finish
   early, or play to turn 12.
3. Open the **report**. Scrub the replay, then **write the AI debrief**. Every figure in it
   is checked against the deterministic analysis.
4. Press **Try this** beside a suggested alternative to fork a what-if from that moment.

**Multiplayer path** (this is where the fun is)

1. Press **Copy invite link** and open it in a second browser or an incognito window. The
   second window joins as a dispatcher.
2. In both windows, dispatch the _same_ truck at the same moment: one commits, the other
   gets a conflict that names what was taken.
3. Now dispatch _different_ trucks at once: both commit, even though each was planned on
   the older board.
4. Post a crew note in one window and watch it appear in the other.
5. Kill the network on one tab (DevTools, Network, Offline), act in the other, then go
   back online: the first tab reconnects and catches up.

**Zero effort:** the operations desk lists **Featured replays**, completed runs anyone can
open read-only, with the scrubbable replay and report.

## Play a run

1. **Create operation**, choose a call sign (or sign in with DeepSpace), name the run.
2. **Copy invite link** and open it in another browser profile. The link's
   `#invite=` code makes that operator a dispatcher. Anyone signed in can watch a run;
   only invited crew can act on it.
3. The commander starts the run and advances turns. Dispatchers pick a truck,
   destination and cargo; the form shows the route, arrival turn and when the truck
   will be back.
4. Disruptions: each scenario schedules a road closure (new trips and return trips
   reroute), a flood at one depot (unallocated stock is lost) and a demand surge at one
   relief site. In the classic scenario the east corridor closes on turn 2, East Hub
   floods on turn 4 (up to ten units lost) and City Center asks for ten more units on
   turn 6; other scenarios vary which, when and how much. Watch the alert feed.
5. After turn 12 (or an early finish), open the report: scrub the replay frame by frame,
   read the findings, and ask Claude to write the debrief.
6. **Play a what-if.** On a completed run's report, a crew member can fork the replay at
   the slider's turn ("Play a what-if from turn N"), or press "Try this" beside a suggested
   alternative. The fork is a new live operation that starts from that board; you command
   it, play it to the deadline, and its report shows the original score beside the
   what-if's.

**The operations desk** shows only what is yours: "Your operations" (runs you command or
joined) and "Featured replays" (completed runs listed in the `FEATURED_RUNS` secret, set per environment because run ids differ).
Other people's runs are not browsable, so practice and test runs never clutter anyone
else's view.

## Scenarios

The map (sites, roads, positions) is fixed; a **seed** decides the numbers on it. `scenario`
generation (`src/domain/scenarios.ts`) is a pure function of the seed string, so the browser,
the Worker and the tests deal the same game:

- **Varies by seed:** depot stock split (140-170 units in all), each relief site's demand and
  priority (1 standard, 2 high, 3 critical; always at least one critical site), which depot
  each of the four trucks calls home (every depot has one), and the disruption schedule: which
  road closes and when, which depot floods, on which turn and for how much, which site
  surges, on which turn and by how much.
- **Seeds:** "Today's scenario" is `daily-YYYY-MM-DD` in UTC (resolved by the Worker, so
  clients cannot pick another day's seed by accident), "Classic" is the original hand-built
  exercise, and any custom seed (1-32 letters, numbers, spaces, dots, underscores or hyphens,
  case-insensitive) always deals the same game. The label ("Daily · 21 Nov 2026", "Classic",
  "Seed: harbor-storm") shows on the board, the report and the directory cards.
- **Data, not constants:** the schedule is stored on the run (`run.scenario = { seed, label,
disruptions }`) and the engine fires it turn by turn, so forks continue the same scenario
  and a replay describes itself. Classic runs, and every run stored before scenarios existed,
  carry no `scenario` field and fire the classic schedule: their boards, event text,
  replays, forks and debriefs are byte-identical to before (`tests/fixtures/classic.json` was
  recorded from the pre-scenario engine and is replayed in `tests/scenario.test.ts`).
- **Balance guarantee:** candidate `n` for a seed comes from `seed#n`, and the first one the
  reference greedy crew (`src/domain/greedy.ts`) wins (at least 80%) but cannot perfect (under
  100%) is dealt, so scores are comparable and play still matters. Every closure keeps every
  site reachable from every depot. If 40 attempts fail, classic's numbers are dealt instead;
  across 200 test seeds none does, and a fresh seed deals in about 3 ms.
- **Leaderboard:** each run's directory record carries top-level `seed`, `phase` and a numeric
  `rank` (rate, then weighted). `GET /api/deck/leaderboard?seed=<seed|daily>` runs one
  RecordRoom query filtered on `seed` and `phase = completed`, ordered by `rank`, limit 10.
  What-if forks are never ranked. The home page shows "Today's best crews". The e2e test
  plays on the explicit `classic` seed so test runs stay off the daily board.

## Architecture

```
Browser (React, src/deck)            Worker (Hono, src/server)          Durable Objects
──────────────────────────           ─────────────────────────          ───────────────────────────────
deck.* typed client ── HTTP ───────▶ /api/deck routes ── RPC ─────────▶ SimulationRoom (one per run)
  parses every response              · origin, size, identity           · SQLite: history, members,
  with protocol schemas              · zod-parsed bodies                  receipts, invite, debrief
useOperation ◀── WebSocket ───────── /live (verified upgrade) ─────────▶ · hibernatable WebSockets
  snapshot / presence / note                                            · broadcasts committed boards
                                     RecordRoom (DeepSpace)             DebriefBudget (one per app)
                                     · runs directory, summaries, memberships       · daily cap on paid debriefs
                                     · notes per run
                                     DeepSpace AI proxy ──▶ Claude (debrief)
```

**Shared domain, end-to-end TypeScript.** `src/domain/` is pure TypeScript with no
platform imports, used by the browser, the Worker, the Durable Object and the tests:

- `protocol.ts`: every request, response, board and socket message as a zod schema.
  The engine's types are inferred from it. The Worker parses each body before acting,
  the client parses each response, and `SIMULATION_ROOMS` is typed as
  `DurableObjectNamespace<SimulationRoom>`, so RPC arguments and results are checked
  too.
- `engine.ts`: the deterministic rules, including shortest paths with stable
  tie-breaking.
- `concurrency.ts`: when an order planned on an older board may still apply.
- `analysis.ts`: the after-action findings.
- `fork.ts`: which replay board a what-if restarts from, and the fork's first board.

Type checking is split into three projects: client (DOM), worker (Workers runtime only,
no DOM) and tests (Node). Browser-only APIs cannot leak into server code.

**The command path.** Every order carries an idempotency key and the board version it
was planned on. `SimulationRoom.command` runs one synchronous SQLite transaction. It
checks the receipt, checks freshness, applies the rules, stores the next replay frame
and records the receipt. Nothing can interleave, so of two orders for the same truck
exactly one commits. Retrying a key returns its original receipt.

- **Freshness:** clock commands need the latest version. A dispatch planned on an older
  board still applies if its turn and route are unchanged, so two dispatchers sending
  _different_ trucks in the same turn both commit. Real overlaps (truck taken, stock or
  demand already reserved) get **409** with a message naming what was taken. Invalid
  input gets **422**.
- **Interrupted confirmations:** if the response to an order never arrives, the client
  keeps that envelope for an explicit retry, which names it. The next button press is
  always sent as a new order with its own key.

**What-if forks.** The engine is pure and each replay frame is a full board, so a fork is
one frame restarted as a new run. `POST /api/deck/runs/:id/fork` (`{ id, turn, before? }`,
the client picks the new id as for creation) asks the source room, which checks that the
caller is a member and the run is completed, for the board; the new `SimulationRoom` stores
it through `createFrom`, and the forker commands it. The board is the last running frame of
the turn (the commander has not advanced the clock yet), or with `before` the frame just
ahead of a named shipment, so "send a fuller load instead" is playable even when every truck
was out by the end of the turn. The fork gets its own id, starts its history at version 0
(frame numbers and versions agree, and every version check runs against its own replay),
keeps the log plus a system entry marking the fork, and records `forkedFrom: { id, turn }`
in the room, state response and directory summary. Disruptions key off the turn, so they
still fire after the fork point. A retried request with the same id and board returns the
same run; any other use of the id is a 409.

**Real-time state.** Each run's Durable Object holds its sockets with the hibernation
API. A commit broadcasts the board; new notes and presence changes are pushed the same
way. The client accepts only boards newer than what it shows, reconnects with
exponential backoff, and polls over HTTP while the socket is down. A reload rehydrates
from storage.

**Identity.** Operators are DeepSpace accounts (JWT or session, shown by profile name) or
_training stations_: an HttpOnly, Secure, SameSite=Strict cookie signed with
`STATION_SIGNING_KEY` from the DeepSpace secret store. `STATION_SIGNING_KEY_PREVIOUS`
supports rotation. Stations exist because the platform's anonymous ids are minted per
socket, and a commander must keep authority across reloads without being forced to sign
up. A call sign is a label; authority is the verified uid plus a membership row.

## Platform primitives: used, and where we built our own

| Need                        | Primitive                                                        | Why                                                                                                                                                                                                                                                                                                        |
| --------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Directory and crew notes    | DeepSpace **RecordRoom**                                         | Shared records with server-enforced schemas; written only by the Worker as app actions, with all client roles closed.                                                                                                                                                                                      |
| Run state, replay, receipts | **Durable Object + SQLite** (our `SimulationRoom`)               | A dispatch must reserve a truck, depot stock and destination demand, store a replay frame and record a receipt atomically, across several entities. The RecordRoom tools write one record per call, so that guarantee would need cross-record locking; a single-threaded DO transaction gives it directly. |
| Accounts                    | DeepSpace **auth** (`resolveAuth`, session reads, `AuthOverlay`) | No custom password handling.                                                                                                                                                                                                                                                                               |
| Guest identity              | Custom signed cookie                                             | See Identity above: anonymous ids are per connection.                                                                                                                                                                                                                                                      |
| Presence                    | Built into `SimulationRoom`                                      | The room already holds every socket for its run; a separate presence room would duplicate those connections for a list of names.                                                                                                                                                                           |
| Secrets                     | DeepSpace **secret store**                                       | The signing key never appears in the repo or the bundle.                                                                                                                                                                                                                                                   |
| AI                          | DeepSpace **AI proxy** (`createDeepSpaceAI`)                     | No provider keys; billing and identity handled by the platform.                                                                                                                                                                                                                                            |
| Deploys                     | **`deepspace deploy`** from the checkout                         | Releases record the commit they shipped.                                                                                                                                                                                                                                                                   |

## Integrations

**Used: an AI after-action debrief (Claude via DeepSpace).** The replay records every
decision, and `analysis.ts` computes the facts deterministically:

- idle truck-turns
- cargo still on the road at the deadline
- reroute delays
- flood losses
- unmet critical demand

Those findings appear on every report with no model involved. A crew member can then
ask Claude (`claude-opus-5-5`, DeepSpace's default for one-shot generation) to turn only
those facts into a headline, what went well, what cost the crew, and what to do next
time, using the AI SDK's structured output. The prompt forbids figures that are not in
the facts, and code enforces it: `src/domain/debrief-check.ts` rejects a draft that names
a truck, shipment, site, turn or figure the facts do not contain, that recommends a move
the engine did not list as feasible, or that advises avoiding a flood loss the analysis
found unavoidable. A failing draft is retried once with its problems appended to the
prompt; if the second also fails, the debrief is withheld and the report keeps the
deterministic findings. Both drafts count as one budgeted generation.

This is worth paying for because the crew already has the data but not the synthesis.
Cost is bounded in layers:

1. Only completed runs with at least one shipment qualify, and only members can ask.
2. Each run generates at most once; the debrief is stored in its `SimulationRoom`, and
   concurrent requests share one model call.
3. `DebriefBudget` caps generations per UTC day across the app (40).

The browser integration proxy forwards nothing (`src/integrations.ts` is empty), so
visitors cannot spend credits directly.

**Considered and left out:**

| Integration                   | Why not                                                                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Maps, geocoding, routing APIs | The network is fictional and the rules need integer travel times; real roads would add cost and nondeterminism and break exact replay. |
| Weather or disaster feeds     | Disruptions are scripted so every crew faces the same scenario and runs are comparable.                                                |
| Email/SMS invites             | A copied invite link does the job without collecting anyone's contact details.                                                         |
| Slack/Discord notifications   | A run lasts minutes with everyone already in the room; the live board is the notification.                                             |
| AI during play (co-pilot)     | It would play the game for the crew. The debrief helps them learn without replacing their decisions.                                   |

## Tradeoffs

- **Replay stores a full board per version** (about 5 KB per frame: 22 frames came to
  112 KB). That makes replay and analysis trivial and exact. The twelve-turn limit bounds
  the size.
- **The membership index is best effort.** Creating, forking and joining write a
  `memberships` record (`<uid>:<runId>`, filtered by `uid`) in RecordRoom, retried three
  times; a write that still fails leaves that run out of "Your operations" until the
  member joins again. Access itself is checked against the run, never the index.
- **Directory summaries are eventually consistent.** Each carries the committed run
  version. The run's Durable Object publishes them after each commit through a single
  in-flight writer that always writes the newest version last, so an older summary
  cannot overwrite a newer one. A failed write (retried twice) leaves the directory
  behind until the next commit. The live board is always read from the run itself.
- **Runs are watchable by anyone signed in who has the link**, which keeps reports
  shareable; they are not listed for others. Acting requires the invite.
- **A station belongs to one browser profile.** Clearing it loses that commander seat;
  there is no transfer yet. DeepSpace accounts avoid this.
- **Stations signed with the old key** (the platform app token, before
  `STATION_SIGNING_KEY`) are accepted until 2026-12-21, when the last of them expires,
  then that code path is inert.

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs on every pull request, every push to
`master` and on demand:

- **validate** (Node 24, `npm ci`): `npm run validate`, then `npm run build`. Needs no
  secrets.
- **e2e** (pushes to `master` and manual runs only): installs Playwright Chromium and runs
  `npm run test:e2e`. It tests whatever is **currently deployed** at `DECK_URL`, not the
  commit being built, and creates one run there. Manual runs can point it at another URL.

CI never deploys; `npm run deploy` needs the local DPAPI-sealed credential.

## Develop, test, deploy

Use Node 24 and npm.

```sh
npm install
npm run validate          # prettier --check, three tsc projects, eslint, node --test
npm run test:e2e          # two browsers against DECK_URL (default: staging); creates one run
DECK_DEBRIEF=1 npm run test:e2e   # also writes one AI debrief (one paid model call)
npm run deploy            # validate, then `deepspace deploy` via scripts/deepspace.ps1
```

The unit tests cover:

- the rules
- the concurrency policy (same truck, different trucks, reserved demand, stale turns,
  route changes)
- protocol validation
- the directory: featured-id parsing, membership ids, best-effort retries
- the after-action analysis
- what-if forks: the fork point, a valid version-0 board, disruptions after the fork, analysis on a history that starts mid-run
- a balance check that a plain greedy crew can still reach the target (it scores 90%)
- scenarios: PRNG determinism, generated-board invariants, classic byte-compatibility against a
  recorded fixture, balance and reachability over 200 seeds, disruptions fired from data
  (also after a fork), and analysis and debrief checks on a non-classic seed

The e2e test drives two isolated browsers through:

- invite-only joining, and leaking no invite to non-commanders
- simultaneous orders for the same truck and for different trucks
- idempotent retries
- an interrupted confirmation followed by a different order
- stale plans, live notes, the closure, the deadline, the report and replay, and the
  debrief
- what-if forks: who may fork, forking from the slider and from a suggested alternative,
  idempotent retries, playing the fork to the deadline, and the score comparison
- the per-operator directory: a joined dispatcher lists the run, a fresh station sees neither it nor its forks
- seeded scenarios: two runs on one seed match, another seed differs, bad seeds are refused,
  and the classic leaderboard lists the completed run (never its forks)
- phone width

`scripts/deepspace.ps1` runs any DeepSpace CLI command with the staging agent account.
The account phrase is stored encrypted with Windows DPAPI under
`%LOCALAPPDATA%\DispatchDeck\account.dpapi`; the script decrypts it into a single-use file
for one CLI call and deletes it afterwards. Secrets are managed with
`npm run deepspace -- secrets set NAME --stdin`.

Staging agent accounts must be re-verified every 24 hours. Hosting and stored data are
unaffected, and stored debriefs stay readable. New debriefs need a verified owner, so
until `npm run deepspace -- auth agent renew` is completed, a request answers with "The
debrief could not be written right now" and can be retried later.

## DeepSpace developer-experience feedback

Each item was hit while building this app, with the workaround used here.

1. **Publisher starter names disagree.** `GET /api/publish/starter?kind=sdk` downloads
   the SDK starter, but `POST /api/publish` with `starter: "sdk"` returns
   `invalid_starter`; it expects `public-board`. _Expected:_ one identifier, or the
   download names the publishable starter. _Workaround:_ `starter: "public-board"`.
2. **Starter templates import helpers SDK 0.44.1 does not export** (`lookupOwn`,
   `integrationPath`, `splitIntegrationEndpoint`), so a fresh scaffold fails to build.
   _Workaround:_ `src/server/endpoint.ts` defines them locally.
3. **Moving from publisher API to CLI deploys is undocumented.** An app first published
   through the API has cloud commits on `main` that a local repo does not share.
   `deepspace pull` on any other branch fails with `branch_not_found`; after
   `pull -b main`, the histories are unrelated. _Expected:_ an "adopt this checkout"
   command. _Workaround:_ `git merge -s ours --allow-unrelated-histories main`, then
   deploy from `main` (commit `e507c20`).
4. **The CLI needs the agent phrase in a plaintext file.** `DEEPSPACE_AGENT_CREDENTIAL_FILE`
   must point to JSON containing the phrase, and `auth whoami` without
   `DEEPSPACE_ENV=staging` reports "Not logged in" rather than "this is a staging
   account". _Expected:_ OS keychain storage. _Workaround:_ `scripts/deepspace.ps1`
   (DPAPI, single-use file).
5. **`deepspace pull` sets the checkout's git identity** to
   `agent_…@agents.invalid` without asking. It prints how to undo it, but rewriting
   commit authorship is surprising. We unset it.
6. **`DOBindings` types every namespace as an untyped `DurableObjectNamespace`**, which
   discards RPC typing. _Suggestion:_ let manifest entries carry the class type.
   _Workaround:_ `Omit` the binding and redeclare it as
   `DurableObjectNamespace<SimulationRoom>`.
7. **The starter's single tsconfig mixes DOM and Workers types**, so DOM's
   `SubtleCrypto` hides Workers-only APIs such as `crypto.subtle.timingSafeEqual` in
   Worker code. _Workaround:_ separate client, worker and test projects.
8. **`src/integrations.ts` in the starter says unlisted integrations default to
   developer billing for any signed-in user.** The proxy route actually refuses
   unlisted names. The comment overstates the exposure; it should match the code.
9. **There is no durable guest identity primitive.** Anonymous ids are per socket, so
   any app with guest roles must sign its own cookies. A platform-issued, rotatable guest
   session would remove that code from every app.
10. **`deepspace status` and `deepspace auth agent status` disagree.** Minutes after a
    successful deploy, `status --json` reported `loggedIn: false` with
    `agent_not_registered`, while `auth agent status --json` reported the same account
    `ready` and verified. _Expected:_ one source of truth for the session.
