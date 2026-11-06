# ProHuman — plan and boundaries

Status: **M0 done, M1 not started.** Nothing in `src/` exists yet; this directory holds the design, the
boundary, and the spike that tested the assumptions the design rests on.

ProHuman is a **behavioural-realism layer** that sits on top of an existing browser engine — today
`browser_use`, later any engine that implements the input surface. It makes automated interaction move like
a person: curved pointer paths with settling, keyboard cadence with mistakes and corrections, scroll in
bursts with re-reads, attention that wanders to another tab and back, and a pointer that is never dead still
while a page is being read.

## What ProHuman is not

This section is the reason the pack exists in the open rather than as a tuning knob somewhere:

- **Not a stealth layer.** No patching of `navigator.webdriver`, no canvas/Audio/WebGL/WebRTC fingerprint
  fabrication, no user-agent or timezone rewriting, no headless-flag concealment, no TLS or HTTP/2
  fingerprint shaping.
- **Not a captcha or challenge solver**, and not a proxy/cookie rotator whose purpose is to keep a blocked
  session going.
- **No claim that any site will classify the session as human.** No detector is tested against, no
  "undetected" score is published, and none will be: it cannot be measured honestly from inside this
  process, so it cannot be a feature.
- **Not a licence to ignore a site's terms.** The disclosure layer below is a requirement, not a suggestion.

The measurable claim is narrower and is the only one the tools make: _the events ProHuman produced are
recorded from the page, and their geometry and timing look like a person's, here are the numbers._

## Disclosure layer (required, not optional)

| field           | meaning                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `identity`      | `name` + `contact_url` + `purpose`, attached to the session and surfaced in `User-Agent`; `attach` refuses without it                            |
| `consent`       | `own-site` \| `authorized` \| `public-read-only`; writing actions (click, type, submit) are refused unless consent is `own-site` or `authorized` |
| `robots`        | the target's `robots.txt` and `crawl-delay` are read before the session starts; a `disallow` is obeyed, not hidden from                          |
| `identity_echo` | every tool answer repeats what was disclosed, so an agent can see it is not anonymous                                                            |

A behavioural layer that also hides the identity it was given is the thing we are not building; the two are
separated deliberately, and the separation is enforced in code, not in prose.

## Architecture decisions

1. **Resident driver, not a synchronous tool.** A human-like click takes 1.2–3.5 s; twenty of them eat the
   transport timeout. Worse, between two MCP calls a synchronous tool leaves the pointer _perfectly still_
   for as long as the model thinks — which is the opposite of the premise. `start` launches a loop that
   schedules its own next event (never a fixed interval: a metronome is its own tell), and `status`, `trace`,
   `report`, `verify`, `stop` observe it.
2. **One writer per session.** Playwright has one cursor. A session-level lock with a TTL decides whether the
   driver or an `act` call may move the pointer; while the driver holds it, `act` refuses (or pauses the
   driver on request) rather than silently queuing behind it.
3. **An input surface, not a Playwright dependency.** `pointerMove / pointerDown / pointerUp / wheel / key /
readTrace / focusTab / viewport` is the seam. The first implementation wraps a `browser_use` session
   through `livePage()`; another engine can be added without touching the behaviour model.
4. **Evidence is the page's own event log.** A recorder installed with `addInitScript` captures
   `timeStamp`, `isTrusted` and coordinates from the events the browser dispatched. The driver's intent is
   never the measurement.

## Behaviour model

- **Timing** from Fitts' law: `MT = a + b · log2(D/W + 1)`, profiled `a` (120–220 ms) and `b` (90–140 ms).
- **Velocity** from a minimum-jerk profile (`10t³ − 15t⁴ + 6t⁵`): soft start, one peak, soft stop.
- **Shape** from a quadratic Bézier bowed perpendicular to the direction of travel; **the side is chosen once
  per path**, not per sample.
- **Overshoot** for small targets (4–15 px past the centre) with one or two corrective sub-movements.
- **Settling**: 20–120 ms of sub-1.5 px movement before a click.
- **Keyboard**: per-key down/up with 55–125 ms hold, log-normal inter-key gaps, longer at word boundaries,
  longer again at punctuation and sentence ends, and a seeded typo rate with backspace corrections.
- **Scroll**: 2–6 bursts with easing and 90–400 ms pauses, plus occasional regressions (re-reading).
- **Attention**: dwell proportional to word count, tab churn, `blur`/`focus`, the pointer leaving the window.
- **Idle**: micro-drift so the longest stillness stays under the profile's ceiling.

## M0 — what the spike measured (2026-11-04, this machine)

Command: `npx tsx scripts/prohuman-spike.mts` · chrome (headless) · `https://example.com/` · seeded PRNG.
Artefacts: `spike-*.json` and `spike-log.md` in this directory.

| assumption                                                         | result                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| the page records the events the driver produced, as trusted events | **HOLDS** — 109 events, `isTrusted` ratio **1.000**                      |
| the pointer keeps moving while no MCP call is in flight            | **HOLDS** — 23 events recorded during a 2.6 s gap                        |
| the path is curved, not a straight interpolation                   | **HOLDS** — 39 pointer events, 588 px, mean turn **42.4 mrad**           |
| the timing is not a metronome                                      | **HOLDS** — inter-event CV **0.50**; key holds mean 88.1 ms, CV **0.38** |

Four defects the spike found and fixed, each of which would have shipped as a wrong measurement:

1. **A click on a link destroys the recorder.** The recorder lived in the document; the click navigated and
   the trace became `undefined`. Fixed by re-arming with `addInitScript` and by measuring each document
   separately.
2. **Stitching two documents into one polyline invented curvature.** The navigation jump read as a ~1.4 rad
   turn. Metrics are now per-document; the session-level numbers are not averaged across a navigation.
3. **Sub-pixel settle jitter dominated the angle metric.** Mean turn angle fell from 923 mrad to 42.4 mrad
   once steps shorter than 5 px are excluded — a hand resting on a target is not turning.
4. **The bow sign was drawn per sample.** Every point curved to a different side, producing a zigzag; the
   metric correctly refused to call it a path. The side is now chosen once per movement.

And one design consequence, not a bug: **the pointer sat still for 4.2 s while the keyboard was busy.** A
fidget loop that only runs between calls is not enough — it must run _concurrently_ with typing and
scrolling, which changes the driver from "an action queue" into "a small scheduler with priorities".

## M1–M4 — what the pack measured on a live page (2026-11-04)

`tests/prohuman-driver.test.ts` runs the pack against `https://example.com/` in a headless Chrome and
asserts the claims rather than the plumbing. Five cases, all passing on this machine:

| case                   | what it proves                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| alive between calls    | 1.4 s with no call in flight: drifts > 1, `pointer_last_moved_ms_ago` ≤ 1200, `verify` passes, and `scheduler_lag_ms.samples` equals the drift count          |
| evidence is the page's | `report.measured.trusted_ratio` = 1.000, pointer events > 3, path length > 0, curvature > 0                                                                   |
| named elements         | `identity` resolves to the centre and width the engine measured, and the answer names what it aimed at                                                        |
| consent                | `public-read-only` refuses the click, records the refusal on the driver, and still allows reading                                                             |
| one writer             | `pro_browser_use_act` refuses while a driver holds the cursor; with `pause_driver=true` it takes over and the driver ends as `yielded to pro_browser_use_act` |

Five defects the live tests found, each fixed rather than worked around:

1. **A driver could not clean itself up.** Teardown routed through the same guard that refuses a driver
   whose session is gone, so pruning a dead driver threw instead of releasing its cursor — an unhandled
   rejection per tick. Teardown is now independent of the guard.
2. **A tool-layer refusal was invisible.** The consent check in the tool returned before the driver saw
   anything, so `status.refusals` stayed empty and a session denied every click looked like a session
   nobody had asked anything of. Refusals are now recorded wherever they are raised.
3. **Taking the cursor asked permission for it.** `pause_driver` tried to acquire a lease that was alive,
   which is exactly what a handover must not do. It now stops the holder, which releases the lease.
4. **The fixture's only link is below the fold** at 1280×720, so aiming at it was correctly refused. The
   test scrolls it into view first — the two steps a real caller takes — rather than aiming at bare
   coordinates and calling that coverage.
5. **A busy machine looked like a frozen cursor.** Measured: `verify` reported a stillness of 390.5 ms
   against a 320 ms ceiling while four suites shared one event loop — the driver had planned the move on
   time and the loop delivered it late, and nothing in the answer could tell the two apart. The driver now
   times every drift against its planned moment and keeps worst/mean/sample counts; `status` and `verify`
   both report `scheduler_lag_ms`, and the test asserts the sample count equals the drift count so the two
   surfaces cannot disagree. An attributed breach is still a breach: `ok` stays false, because the promise
   was about the cursor, not about the load.

## What a macOS CI runner measured that this machine could not (2026-11-06)

The live suite passed six times locally and failed once on GitHub's macOS runner. The annotations named
both failures, and neither was the driver:

6. **A curvature of zero was reported as a measurement when there was nothing to measure.** The page had
   recorded the reach as too few steps above the noise floor to form a turn, and `curvatureRad: 0` is the
   same number a pointer travelling in a straight line produces. For a pack whose whole purpose is to
   support or break a claim about how a movement looks, a zero that cannot be distinguished from "synthetic"
   is the worst possible answer. `measureTrace` now computes the turn through `curvatureOf`, which returns
   the mean with the number of turns it averaged, and `report` says in `limits` that the curvature was not
   measurable — with the pointer-event count and path length attached, so the reader can see why. Measured
   on this machine, the same flow records 84 pointer events and 53 turns at 0.039 rad, tortuosity 1.969.
   A claim that needs a bend now makes two reaches in different directions: one bezier, coalesced into two
   points, cannot form a turn no matter how far the pointer travelled.
7. **A fixed wait measured the runner.** The continuity assertion slept 1400 ms and required more than one
   idle drift. The calm profile plans a drift every 112–272 ms (`nextIdleGap` is 0.35–0.85 of the 320 ms
   ceiling), so the window was never the problem; the macOS runner delivered one drift in all 1400 ms,
   because each drift's round trip to the browser took about the whole window. The test now waits on
   the driver's own counters (up to 8 s more) and still requires two drifts, so a driver that stops after
   one still fails — with `scheduler_lag_ms` printed, naming whose slowness it was. The stillness bound
   moved from a hardcoded 1200 ms to the ceiling the profile declares, doubled, plus the lateness the
   driver measured in itself: a frozen cursor has nothing to attribute to, and its stillness grows with
   uptime while the allowance does not.

## Milestones

|        |                                                                                                                                                       |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M0** | spike: trusted events, resident loop, measurable geometry — **done, all four assumptions hold**                                                       |
| **M1** | core: profile + seeded PRNG, path math, input surface, session lock, recorder — **built, unit-tested**                                                |
| **M2** | driver: concurrent idle/fidget scheduler, `attach/start/stop/status`, runtime ceiling, self-stop — **built, live-tested**                             |
| **M3** | action tools: `move/hover/click/type/press/scroll/read/tab_churn/sequence` — **built, live-tested**                                                   |
| **M4** | measurement: `trace/report/verify`, per-document metrics, disclosure in every answer — **built**                                                      |
| **M5** | registry: category `prohuman` at level 3 (`full` only), 717→737 tools and 43→44 categories, README row, schema gate, mutation table, docs — **wired** |

Each milestone ends with a live run and `npm run check` green.

## The open questions, answered by what was built

1. Unattended idle motion: **120 s default, 600 s hard ceiling**, carried by the profile.
2. One driver per session: **yes**, enforced by the cursor lock rather than by convention.
3. `sequence`: **included** — it enqueues steps and returns; the driver runs them on its own clock.
4. Targets: **`browser_use` identity or node id**, resolved against the session's latest read. Bare
   coordinates still work; an element outside the viewport is refused, not guessed at.
5. Traces: **in the page, read on demand**. The pack persists nothing; `trace` and `report` can clear the
   buffer so the next measurement covers one window.
6. Name: **`pro_human_*`**, matching `pro_browser_*` and `pro_research_*`.
