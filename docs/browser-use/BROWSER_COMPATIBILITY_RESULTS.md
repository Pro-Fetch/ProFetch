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
