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

The measurable claim is narrower and is the only one the tools make: *the events ProHuman produced are
recorded from the page, and their geometry and timing look like a person's, here are the numbers.*

## Disclosure layer (required, not optional)

| field | meaning |
| --- | --- |
| `identity` | `name` + `contact_url` + `purpose`, attached to the session and surfaced in `User-Agent`; `attach` refuses without it |
| `consent` | `own-site` \| `authorized` \| `public-read-only`; writing actions (click, type, submit) are refused unless consent is `own-site` or `authorized` |
| `robots` | the target's `robots.txt` and `crawl-delay` are read before the session starts; a `disallow` is obeyed, not hidden from |
| `identity_echo` | every tool answer repeats what was disclosed, so an agent can see it is not anonymous |

A behavioural layer that also hides the identity it was given is the thing we are not building; the two are
separated deliberately, and the separation is enforced in code, not in prose.

## Architecture decisions

1. **Resident driver, not a synchronous tool.** A human-like click takes 1.2–3.5 s; twenty of them eat the
   transport timeout. Worse, between two MCP calls a synchronous tool leaves the pointer *perfectly still*
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

| assumption | result |
| --- | --- |
| the page records the events the driver produced, as trusted events | **HOLDS** — 109 events, `isTrusted` ratio **1.000** |
| the pointer keeps moving while no MCP call is in flight | **HOLDS** — 23 events recorded during a 2.6 s gap |
| the path is curved, not a straight interpolation | **HOLDS** — 39 pointer events, 588 px, mean turn **42.4 mrad** |
| the timing is not a metronome | **HOLDS** — inter-event CV **0.50**; key holds mean 88.1 ms, CV **0.38** |

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
fidget loop that only runs between calls is not enough — it must run *concurrently* with typing and
scrolling, which changes the driver from "an action queue" into "a small scheduler with priorities".

## Milestones

| | |
| --- | --- |
| **M0** | spike: trusted events, resident loop, measurable geometry — **done, all four assumptions hold** |
| **M1** | core: profile + seeded PRNG, path math, input surface, session lock, recorder |
| **M2** | driver: concurrent idle/fidget scheduler, `attach/start/stop/status`, runtime ceiling, self-stop |
| **M3** | action tools: `move/hover/click/type/press/scroll/read/tab_churn` |
| **M4** | measurement: `trace/report/verify`, per-document metrics, disclosure report |
| **M5** | registry: category `prohuman` (level 3, `full` only), counts, README row, CI, docs |

Each milestone ends with a live run and `npm run check` green.

## Open questions before M1

1. How long may the driver run unattended while the model thinks? (proposal: 120 s default, 600 s ceiling)
2. Is one driver per session acceptable? (proposal: yes)
3. Is `sequence` (a scripted batch) wanted in v1, or does it wait?
4. Targets by `browser_use` identity, or does ProHuman re-read the page itself? (proposal: identity — cheaper and reproducible)
5. Where do traces persist? (proposal: the session's own data root, deleted with the session, and returned inline)
6. Tool prefix: `prohuman_*` or `pro_human_*`?
