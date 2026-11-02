# Browser compatibility results

Run log for `docs/browser-use/ENGINE_SUPPORT_MATRIX.md`. Every `Y*` in that matrix traces to a row
here, and every row here traces to a committed artifact. A status with no artifact is not a status.

Reproduce with `npm run probe:browser-use` (writes a new artifact under
`benchmarks/browser-use/artifacts/` and prints the same table).

---

## Run 1 — 2026-11-01T13:49:38Z — Windows, host `win32`

Artifact: `benchmarks/browser-use/artifacts/probe-2026-11-01T13-49-38-153Z.json`
Playwright 1.63.0 · 12/12 steps passed · 3911 ms total · no network involved (every navigation is
`about:blank` plus `setContent`, so a failure here cannot be blamed on somebody's uptime).

| product  | version       | launch | navigate | DOM read | geometry | accessibility | close  |
| -------- | ------------- | ------ | -------- | -------- | -------- | ------------- | ------ |
| `chrome` | 156.0.8078.74 | 952 ms | 101 ms   | 22 ms    | 102 ms   | 22 ms         | 224 ms |
| `edge`   | 156.0.4314.58 | 528 ms | 174 ms   | 8 ms     | 77 ms    | 10 ms         | 340 ms |

What each column actually proves:

- **launch** — the adapter's plan produced a working command line and a _separate_ profile directory
  (`pro-fetch-chrome` vs `pro-fetch-edge`), via a Playwright persistent context.
- **navigate** — the page reached a document with the expected title.
- **DOM read** — `#t` came back as exactly `pro-fetch probe`.
- **geometry** — `locator.boundingBox()` returned `50x21 @ 8,80` on both browsers. Identical numbers
  across two Chromium products on the same fixture is the expected result, and a divergence would have
  been a layout or DPR bug.
- **accessibility** — `ariaSnapshot()` yielded `- button "Press me": Press`, i.e. the accessible name
  survives serialization. This is the capability Firefox cannot offer at all (see below).
- **close** — the browser process exited cleanly; no orphan was left behind.

### What this run does _not_ claim

`VERIFIED_MANAGED` covers five capabilities on two products. Everything else in the matrix is still
what a specification or a source reading allows, and the overlay records it that way:
10 `VERIFIED_MANAGED`, 555 `PARTIALLY_VERIFIED`, 49 `UNSUPPORTED`, 52 `BLOCKED_BY_ENVIRONMENT`,
54 `UNKNOWN`.

Not verified here, explicitly: screenshots, input synthesis, network interception, downloads/uploads,
cookies, dialogs, multi-session isolation, native attachment to a running browser, and every Firefox,
Safari, WebKit and mobile row.

### Bugs this run found, and what they were

The probe's first execution passed 0 of 2 steps. Both failures were real defects in code written the
same day, and neither would have been visible from the unit tests, which never touch a browser:

1. **`--user-data-dir` inside `browserType.launch()` is rejected by Playwright.** The adapter plan was
   right about profile isolation and the runtime was passing it the wrong way; the fix is
   `launchPersistentContext(userDataDir, …)`, which expresses the same guarantee in the API that
   accepts it. The plan stays the source of truth — the runtime translates it.
2. **`chrome.exe --version` does not print a version on Windows.** The binary writes a _localised_
   message and exits non-zero; decoded as UTF-8 it arrived as mojibake, and detection would have stored
   that as the version. Windows now reads the executable's file-version resource through PowerShell
   (`readExecutableVersion`), which is where `156.0.8078.74` came from. The `--version` path is kept for
   macOS and Linux, where Chromium answers it.

A third finding is a documentation bug rather than a code one: the profiles had claimed
`versionByFlag: true` for Chrome and Edge as a general truth. It is true off Windows and false on it.

---

## Products not probed in this run, and why that is stated rather than skipped

| product                                                                                             | status                        | reason                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `firefox`, `firefox-esr`, `firefox-developer`, `firefox-nightly`                                    | not installed                 | no candidate path resolved on this host. The probe refuses to launch a substitute: "use Firefox" on a machine without Firefox is a refusal, not a Chromium run. |
| `safari`, `safari-tech-preview`                                                                     | blocked by environment        | `safaridriver` is macOS-only and needs `safaridriver --enable`; the adapter throws rather than producing a command line it cannot honour.                       |
| `webkit` (Playwright)                                                                               | blocked by environment        | Playwright publishes no Windows WebKit build.                                                                                                                   |
| `opera`, `opera-gx`, `vivaldi`, `arc`, `chromium`, `chrome-beta/dev/canary`, `edge-beta/dev/canary` | detected-not-probed-or-absent | the registry lists what it found; the probe drives every _installed_ Chromium product, and this host has stable Chrome and stable Edge only.                    |
| `android-chrome`, `android-firefox`, `samsung-internet`, `ios-safari`                               | blocked by environment        | no device attached; ADB and WebDriverAgent are not present.                                                                                                     |

The Firefox row is the interesting one for the design, and it was settled from the specification
rather than from a run: WebDriver BiDi defines **no accessibility module**, and Firefox 129 removed CDP.
So the capability that this run verified twice on Chromium is `UNSUPPORTED` on Firefox, and no amount of
code here changes it — it needs a different transport or a different browser.

---

## Next runs

Phase 4 is not finished by one host. To close it honestly:

1. Re-run on macOS (Safari over `safaridriver`, Chrome/Edge/Arc/Firefox as installed) — the first
   chance to move a Safari row off `BLOCKED_BY_ENVIRONMENT`.
2. Re-run on Linux with Firefox installed — the first chance to test the BiDi path that is currently
   only read from a draft.
3. Native attachment: launch Chrome with `--remote-debugging-port`, attach through
   `validateAttachEndpoint`, and move `attachToRunning` from `PARTIALLY_VERIFIED` to a verified status
   or record why it cannot be.
4. Screenshots, input, interception, downloads: each needs its own probe step before its matrix cell can
   move.

---

## Run 2 — 2026-11-01T15:41:32Z — Windows, perception layer against a real DOM

Artifact: `benchmarks/browser-use/artifacts/probe-2026-11-01T15-41-32-746Z.json`
18/18 steps passed on Chrome 156.0.8078.74 and Edge 156.0.4314.58 in 2741 ms. The three new steps
are the ones that matter for Phase 5:

| step              | what it proves                                                                                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `perceive`        | the in-page collector returned 4 nodes, the merge kept them, the outline emitted 1 interactable element with a stable identity (`05b23d4f`, identical on both browsers) |
| `stale-detection` | the button was replaced with a new element of the same tag, name, position and accessible name; resolution returned `ID_RECYCLED` and refused the action                |
| `obstruction`     | a fixed overlay above the button made it non-interactable, with the conflict named: `hit-test at the centre returns a different element`                                |

### The design bug run 2 caught

The first version of `identityOf` hashed frame + path + tag + role + name + text. The probe
replaced an element with an identical-looking one and resolution answered `FRESH` — clickable.
That is the precise failure this layer was written to prevent, reproduced in my own code: a
structural fingerprint describes what an element _looks like_, not _which element it is_, and a
traversal ordinal assigned by the collector is reused by the replacement just as a CDP
`backendNodeId` is. Position and naming cannot substitute for identity.

The fix is a token bound to the DOM node itself — a `WeakMap` held on the page, so a new element
gets a new token even when it is otherwise indistinguishable, and the same element re-rendered
keeps its own. Identity now includes it, `resolveTarget` compares it, and the offline test suite
pins the case the probe found (`identityOf(token: t2) !== identityOf(token: t1)` with everything
else equal).

Two smaller defects surfaced the same way: TypeScript syntax had leaked into the collector, which
is a string evaluated inside the page (`SyntaxError: Unexpected identifier 'as'` on both
browsers), and the `hitTesting` capability — previously `?` because it had only ever been read
off a protocol page — is now genuinely observed, so it moved to `Y*`.

Matrix after run 2: 12 `VERIFIED_MANAGED`, 555 `PARTIALLY_VERIFIED`, 49 `UNSUPPORTED
`, 52 `BLOCKED_BY_ENVIRONMENT`, 52 `UNKNOWN`.

---

## Run 3 — 2026-11-02T12:26:47Z — Windows, object intelligence against a real DOM

Artifact: `benchmarks/browser-use/artifacts/probe-2026-11-02T12-26-47-277Z.json`
20/20 steps passed on Chrome 156.0.8078.74 and Edge 156.0.4314.58 in 3897 ms. One step is new.

| step    | what it proves                                                                                                                                                                                                                                                                                                                      |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `group` | on a shop fixture written inside the browser — a `<nav>` with two links, a `<form>` with a labelled field and a submit, and a `<ul>` of three product cards — `groupObjects` produced exactly `[list, form, navigation]`, the list reported 3 structurally identical children, and every group carried at least one evidence string |

The reason this run exists at all: `browser-use-objects.ts` had only ever been checked against
fixtures I wrote myself. A fixture and the code it tests can share a wrong assumption — run 2 is
the proof of that, where my own `identityOf` passed its offline tests and failed in a browser.
Grouping a DOM is exactly the kind of claim that a hand-built tree flatters, so the labels now
come from a document a real engine parsed.

Nothing about the classification changed to make it pass. The list was already derived from
repeated sibling signatures and the `list` role, and the form and navigation from the elements
the collector reports; the run confirms the derivation holds once layout, implicit roles and
computed styles are computed by Chromium rather than asserted by me.

### The evidence chain got a link

`VerifiedFact` now names the probe _step_ inside the artifact, not just the file, and two tests
read the JSON: one refuses a fact whose cited step is missing or `ok: false`, the other pins the
Phase 5 claims (`ID_RECYCLED`, the covered-button conflict, the three evidenced groups) to the
run log. Both were mutation-tested — pointing the overlay at run 2's artifact, which has no
`group` step, fails with `chrome: group never ran, so the claim about it is unsupported`.

Matrix counts are unchanged (12 `VERIFIED_MANAGED`, 555 `PARTIALLY_VERIFIED`, 49 `UNSUPPORTED`,
52 `BLOCKED_BY_ENVIRONMENT`, 52 `UNKNOWN`): run 3 re-observed the same six capabilities and the
grouping step maps to no protocol capability, so it earns no cell. What is still unverified is
the list under _Next runs_ — screenshots, input, interception, downloads, cookies,
multi-session, native attachment, and every macOS/Linux path.

---

## Run 4 — 2026-11-02T12:49:18Z — Windows, the world model against a live document

Artifact: `benchmarks/browser-use/artifacts/probe-2026-11-02T12-49-18-943Z.json`
22/22 steps passed on Chrome 156.0.8078.74 and Edge 156.0.4314.58 in 4907 ms.

| step          | what it proves                                                                                                                                                                                                                                                                                                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `world-model` | on a live cart page, renaming the button in place produced exactly one `relabelled` entry (no death-and-birth), the identity the caller had been shown answered `CHANGED` with a usable replacement, and a **real navigation** to a `data:` document containing a button with the same tag, role, accessible name, text and box was classified `NAVIGATED` and refused the old identity |

Run 4 is the first probe step that navigates. Runs 1–3 stayed on `about:blank` so that no probe could
fail because of somebody's uptime; a world model whose navigation path is never exercised is a model
with an untested reset, so this one moves the tab for real. `data:` was chosen over any http(s)
address: it changes the document, it changes the URL, and it still touches no network.

The refusal is the claim worth checking. A look-alike element in a new document is the case that a
backend-node-id index gets wrong — it finds _a_ node and clicks it. Here the model voids 2 identities,
the new button gets a different structural identity because its lifetime token differs, and resolution
answers `NAVIGATED` rather than offering the button. Both browsers agree.

Also in this run: the verified-facts overlay now names the probe _step_ it cites and a test reads the
JSON, so a claim about `hitTesting` fails if the `obstruction` step fails, and the Phase 5 claims
(`ID_RECYCLED`, the covered-button conflict, three evidenced groups, the relabel/navigation answers)
are pinned to the run log rather than to prose.

Matrix counts unchanged: 12 `VERIFIED_MANAGED`, 555 `PARTIALLY_VERIFIED`, 49 `UNSUPPORTED`,
52 `BLOCKED_BY_ENVIRONMENT`, 52 `UNKNOWN`. Screenshots, input, interception, downloads, cookies,
dialogs, multi-session, native attachment and every non-Windows path remain unverified.

---

## Run 5 — 2026-11-02T14:16:09Z — Windows, the rest of Phase 4

Artifact: `benchmarks/browser-use/artifacts/probe-2026-11-02T14-16-09-767Z.json`
52/52 steps passed on Chrome 156.0.8078.74 and Edge 156.0.4314.58 in 9200 ms. Twenty-four new steps,
each of which turns a `p` in the matrix into a `Y*` — and two findings on the way.

| group           | steps                                        | what was driven                                                                                                                                                                                                                                                                                                                       |
| --------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| capture         | `screenshot`, `visual-diff`                  | viewport 1280x720 at dpr 1, full-page 1280x2072 for a 2072 px document, element 120x32 for a 120x32 box; the DOM box mapped onto a crop that was 97% the button's blue; recolouring the button changed 3818 pixels and that change's bounding box fell inside the mapped box, while two captures of the same page diffed to exactly 0 |
| input           | `input`, `coordinates`                       | a mouse click at the centre the snapshot reported focused the field, keyboard typed `hello`, Enter reached its keydown handler, and a remembered point was refused after a 400 px scroll (drift 0,-400) and under an overlay                                                                                                          |
| page signals    | `console`, `network`, `dialogs`              | log and warning delivered with type and text; a request to `probe.invalid/probe.png` answered from memory as a 95-byte PNG with `naturalWidth` 4; alert and confirm captured, and the accepted confirm returned `true` to the page                                                                                                    |
| files and state | `downloads`, `uploads`, `cookies`, `storage` | a blob download came back through the browser and read as 15 bytes; `setInputFiles` reached the change handler as `upload-me.txt:14`; page-written cookies appeared in the jar and `clearCookies` removed one; `storageState()` wrote an origin entry containing localStorage                                                         |
| sessions        | `tabs`, `viewport`, `device-scale`           | four pages in one context listed with titles, one closed and the driver survived; 375x667 emulation produced a 375x667 capture and geometry followed; a second launch at `deviceScaleFactor: 2` turned 800x600 CSS into 1600x1200 image pixels with the button still landing on its box                                               |
| native          | `attach-native`                              | Chrome and Edge launched with `--remote-debugging-port`, then `connectOverCDP` read the page through a second connection and closed it, leaving the managed session answering; the same step shows the validator refusing a public endpoint                                                                                           |

Nothing above touched the network. `probe.invalid` is reserved by the DNS spec and can never resolve, so
the interception step proves that the route answered rather than that the connection was fast.

### What run 5 caught in its own script

The first version of `input` asserted that Enter reached the page, then read the shared log field only
_after_ the pointer click had overwritten it. The step passed and proved nothing about the keyboard. The
assertion now runs between the keypress and the click, and reports `Enter logged "enter:hello"`. The
flawed version is committed as well: `probe-2026-11-02T14-13-08-566Z.json` records 52/52 passed with
`Enter logged "clicked"` — a green run whose keyboard claim was empty. A probe that green-lights its own
sentence is exactly the failure mode this file exists to avoid, so the run-log guard now requires that
wording and the same empty claim cannot pass twice.

The other finding is about Edge rather than about the probe: a restored session tab (`Загрузки`) was
already in `context.pages()` before the step opened its two. The assertion is relative to the tabs present
when the step started, so it holds — but a tool that assumes a fresh context contains only what it put
there would be wrong on a real profile. That is written into the capability note instead of papered over.

Matrix after run 5: **50 `VERIFIED_MANAGED`**, 519 `PARTIALLY_VERIFIED`, 49 `UNSUPPORTED`,
52 `BLOCKED_BY_ENVIRONMENT`, 50 `UNKNOWN`. Still unverified: touch input, device emulation with a mobile
UA, web sockets, persistence across a relaunch, and every Firefox / Safari / WebKit / mobile / non-Windows
path.

---

## Run 6 — 2026-11-02T14:40:03Z — Windows, coordinates across a frame boundary

Artifact: `benchmarks/browser-use/artifacts/probe-2026-11-02T14-40-03-890Z.json`
54/54 steps passed on Chrome 156.0.8078.74 and Edge 156.0.4314.58 in 19845 ms. One new step.

| step     | what it proves                                                                                                                                                                                                                                                                                                                                                                          |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frames` | a `srcdoc` iframe placed at 60,0 was found among the page frames, given the id `main>0`, measured its own offset from inside (`60,0`), and the button inside it — reported by the collector at `10,40` in the frame's viewport — lifted to `100,40 120x32`, a box that came back **96% button blue** from a real capture; the node carries `iframe main>0 (about:srcdoc)` as a boundary |

This closes the hole the frame module was written around. Until now the collector reported every node with
`frameId: 'main'`, which meant an iframe's contents were silently presented as if they belonged to the top
document — coordinates included. A click computed from those numbers lands in the parent, at whatever is
sitting at the iframe's inner offset. `collectAllFrames` now walks `page.frames()`, measures each hop, and
either lifts a node's box or refuses to, naming the frame in `unlifted` with the reason.

The refusal path cannot be produced from a local fixture: `srcdoc` inherits the parent's origin by design,
so a probe that only uses local documents will never see a real cross-origin frame. That case is tested
offline instead, with an injected frame whose `frameElement` read throws — the offset comes back `null`, the
whole subtree above it becomes unresolvable, and its nodes are reported rather than dropped. Run 6 proves
the measuring half; the test proves the refusing half.

Matrix counts are unchanged (50 `VERIFIED_MANAGED`, 519 `p`, 49 `N`, 52 `E`, 50 `?`): crossing a frame
boundary is not a protocol capability, it is Phase 6 work, and it moved `P6-06` from TESTED to VERIFIED.

---

## Run 7 — 2026-11-02T15:01:32Z — Windows, annotation that survives a diff

Artifact: `benchmarks/browser-use/artifacts/probe-2026-11-02T15-01-32-740Z.json`
56/56 steps passed on Chrome 156.0.8078.74 and Edge 156.0.4314.58 in 10184 ms.

| step       | what it proves                                                                                                                                                                                                                                                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `annotate` | the interactable element's DOM box was mapped into the real capture and drawn with an outline plus its outline index as pixels; 927 writes produced 839 changed pixels, **0 of them outside the drawn box**, the button's own blue survived at the box centre, and the capture that was handed to the painter was byte-for-byte unchanged |

The "0 outside" number is the point. Painting into a pixel buffer is one multiplication and one addition
away from writing last-row pixels at the start of the next row, which looks like a drawing glitch and is
actually a corrupted image. The painter clips every write on both axes, and the step checks the diff
against the boxes rather than trusting the arithmetic.

Annotating with pixels — rather than only emitting SVG markup — is what lets a vision model be shown the
same index the text outline was given. Text needed a font rasterizer, so the digits are a 3×5 bitmap: enough
to put `12` on a box with no dependency, and small enough to be checked pixel by pixel in a test.

### What run 7 caught in its own painter

The label's dark background plate was drawn with padding that reached back over the box outline, so the
corner of the box came out dark grey instead of cyan. The step failed on both browsers, and the failure is
committed: `probe-2026-11-02T15-00-34-161Z.json` records 54/56 with
`the outline at 40,40 is 8,8,8,255, not the annotation cyan`. The plate's padding now stops at the inner
edge of the outline — the label may sit inside the box it names but never on top of it, because the outline
is the part a reader uses to find the element.

Matrix counts unchanged (50 `VERIFIED_MANAGED`, 519 `p`, 49 `N`, 52 `E`, 50 `?`): annotation is Phase 6
capability work, not a protocol row. `P6-08` moved from TESTED to VERIFIED with this run. Still unproven
live: full-page composition across frames, touch input, mobile-UA emulation, web sockets, persistence
across relaunch, and everything that needs a browser this host cannot run.

---

## Run 8 — 2026-11-02T15:42:06Z — Windows, coverage measured and a state revealed

Artifact: `benchmarks/browser-use/artifacts/probe-2026-11-02T15-42-06-835Z.json`
60/60 steps passed on Chrome 156.0.8078.74 and Edge 156.0.4314.58 in 15200 ms.

| step              | what it proves                                                                                                                                                                                                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scan`            | a 2823 px page was read band by band until the ledger reported **4/4 bands fully covered in 4 reads**, `complete=true`, and the button at the bottom entered a viewport — it was not inside the first one, which is what makes the claim about coverage rather than about luck                        |
| `state-discovery` | a closed `<details>` was offered as `expand/SAFE_REVERSIBLE`, opening it put the panel element into the snapshot, closing it took the element out again, and the summary kept the same identity (`dc05b903`, identical on both browsers) across both toggles because its lifetime token never changed |

### Two bugs the scan step found in the ledger

**Overlap was being called coverage.** A band was marked visited as soon as any viewport touched it, so a
four-band page reached "100% covered" after two reads that between them had never brought the last screen of
elements into view — the bottom button was still 1123 px below the fold while the ledger said the page was
done. Bands now record the page range that has actually been inside a viewport, and a band counts as visited
only when that range reaches both its edges.

**Planned scrolls could aim at the wrong band.** Targets were snapped to a stride grid, and a snapped value
can sit where a _neighbouring_ band starts: the scan then re-planned the same position forever and the
iteration guard, not the coverage, ended the run. Each step is now aimed at the top of the band it is
supposed to finish, clamped to the page's real maximum scroll (`contentHeight - viewportHeight`), because a
target past that is silently clamped by the browser and the band's top edge never arrives. The step also
fails loudly if a pass leaves the visited count unchanged, rather than spinning.

### Why the disclosure is a discovery and not a re-read

Chromium hides a closed `<details>` through the `::details-content` pseudo-element, which leaves the panel's
own children with a real `getBoundingClientRect()` and a computed style of `visible`. The collector was
therefore reporting content that paints nothing, and "the panel appeared when I opened it" would have been
false the moment the element had merely been off-screen. Content inside a closed disclosure is now skipped
(the summary excepted), so the panel is absent from the closed snapshot, present in the open one, and absent
again after closing. `expanded` is also only reported where an expansion state genuinely exists — a `details`
element's `open`, or a real `aria-expanded` — instead of every element arriving with `expanded: false`.

Matrix counts unchanged (50 `VERIFIED_MANAGED`, 519 `p`, 49 `N`, 52 `E`, 50 `?`): coverage and disclosure
behaviour are engine-level work, not protocol rows. Still unverified live: full-page composition across
frames, touch input, mobile-UA emulation, web sockets, persistence across a relaunch, and every browser this
host cannot run.

---

## Run 9 — 2026-11-02T16:08:33Z — Windows, health findings and one verified rescue

Artifact: `benchmarks/browser-use/artifacts/probe-2026-11-02T16-08-33-303Z.json`
62/62 steps passed on Chrome 156.0.8078.74 and Edge 156.0.4314.58 in 17908 ms.

| step     | what it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `health` | a deliberately broken page (a button clipped by `overflow:hidden`, a nameless control, an 8×8 target, an unlabelled field, an image with no `alt`, no `lang`) produced **3 blocking, 4 degraded** findings; one local style rule un-clipped the button and a re-read found it hittable — `FIXED_VERIFIED` — after which the rule was removed and the finding came back, proving the rescue was temporary and the page was left as its author wrote it; a clean page then produced **0 blocking** findings |

The rescue is the part this project has to be careful about. The engine may change the presentation of the
page it is reading, in this browser, for this read — and must then undo it and prove the undo. A status of
`FIXED_VERIFIED` is only reachable when something re-read the page afterwards; `rescueRecord` downgrades a
claimed-verified fix with no verification timestamp to `APPLIED_UNVERIFIED` rather than trusting the caller,
and `probe-…15-00-34` (run 7) is the precedent for committing a run that shows a claim being wrong.

### What the clean fixture caught in the collector

The first version of this step failed on the _good_ page: `<label for="q">Search</label><input id="q"> was
reported as an unlabelled field with no accessible name. The collector resolved `aria-label`,
`aria-labelledby`, text content, `alt`, `title`, `placeholder`and`href`, and never looked at native label
association at all. That is not a page defect — it is the engine blaming a correct document for its own gap,
and every finding downstream would inherit the mistake. `labelFor`now uses the element's own`labels`list,
which covers both a`for=`association and a wrapping`<label>`, so a labelled field arrives named and the
`unlabelled-fields` finding fires only when the label really is missing.

Finding that required the check to run in both directions: a diagnostics suite that only ever inspects broken
pages will pass while measuring nothing.

Matrix counts unchanged (50 `VERIFIED_MANAGED`, 519 `p`, 49 `N`, 52 `E`, 50 `?`): health diagnostics are
engine-level analysis, not a protocol capability. Unverified live still: full-page composition across frames,
touch input, mobile-UA emulation, web sockets, persistence across relaunch, and every browser this host
cannot run.

---

## Run 10 — 2026-11-02T16:35:53Z — Windows, the action engine, driven end to end

Artifact: `benchmarks/browser-use/artifacts/probe-2026-11-02T16-35-53-977Z.json`
64/64 steps passed on Chrome 156.0.8078.74 and Edge 156.0.4314.58 in 20456 ms.

| step     | what it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action` | five real actions through preflight → injected executor → independent verification: typing `SAVE20` into a labelled field and **reading the value back out of the page**; clicking a button whose only effect is that it changes its own words, verified by the **same node token** now reading "In cart"; checking a box, verified by its `checked` state; `"Delete account"` refused with the executor never reached (and the control confirmed untouched afterwards); and a live reference refused after the element was replaced by a look-alike, reported as `ID_RECYCLED` |

The last case is the one the whole design exists for. The replaced button had the same tag, id, words and
box, and the collector's traversal ordinal came back identical — so a reference keyed on that id would have
clicked the new element and reported success. The refusal came from the lifetime token, not from the words.

### What run 10 caught in its own step

The stale-reference case initially reused the target from the earlier click — and that identity had already
changed when the button relabelled itself, so the "refusal after replacement" was refusing something that was
stale two steps earlier. The step passed and proved nothing, again. It now takes a _fresh_ live reference,
asserts that the reference was current before the replacement, asserts that the look-alike exists afterwards
under a **different** identity, and only then claims the refusal was about replacement. A guard that fails
when its own fixture has stopped testing the case is worth more than a green run.

Matrix counts unchanged (50 `VERIFIED_MANAGED`, 519 `p`, 49 `N`, 52 `E`, 50 `?`): acting on a page is not a
protocol capability row — the capabilities it stands on (`inputPointer`, `inputKeyboard`, `hitTesting`,
`domRead`, `boundingGeometry`) are each verified separately above. Unverified live: touch input, mobile-UA
emulation, web sockets, persistence across a relaunch, and every browser this host cannot run.
