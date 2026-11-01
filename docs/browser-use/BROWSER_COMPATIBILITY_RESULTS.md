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

| product | version | launch | navigate | DOM read | geometry | accessibility | close |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `chrome` | 156.0.8078.74 | 952 ms | 101 ms | 22 ms | 102 ms | 22 ms | 224 ms |
| `edge` | 156.0.4314.58 | 528 ms | 174 ms | 8 ms | 77 ms | 10 ms | 340 ms |

What each column actually proves:

- **launch** — the adapter's plan produced a working command line and a *separate* profile directory
  (`pro-fetch-chrome` vs `pro-fetch-edge`), via a Playwright persistent context.
- **navigate** — the page reached a document with the expected title.
- **DOM read** — `#t` came back as exactly `pro-fetch probe`.
- **geometry** — `locator.boundingBox()` returned `50x21 @ 8,80` on both browsers. Identical numbers
  across two Chromium products on the same fixture is the expected result, and a divergence would have
  been a layout or DPR bug.
- **accessibility** — `ariaSnapshot()` yielded `- button "Press me": Press`, i.e. the accessible name
  survives serialization. This is the capability Firefox cannot offer at all (see below).
- **close** — the browser process exited cleanly; no orphan was left behind.

### What this run does *not* claim

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
2. **`chrome.exe --version` does not print a version on Windows.** The binary writes a *localised*
   message and exits non-zero; decoded as UTF-8 it arrived as mojibake, and detection would have stored
   that as the version. Windows now reads the executable's file-version resource through PowerShell
   (`readExecutableVersion`), which is where `156.0.8078.74` came from. The `--version` path is kept for
   macOS and Linux, where Chromium answers it.

A third finding is a documentation bug rather than a code one: the profiles had claimed
`versionByFlag: true` for Chrome and Edge as a general truth. It is true off Windows and false on it.

---

## Products not probed in this run, and why that is stated rather than skipped

| product | status | reason |
| --- | --- | --- |
| `firefox`, `firefox-esr`, `firefox-developer`, `firefox-nightly` | not installed | no candidate path resolved on this host. The probe refuses to launch a substitute: "use Firefox" on a machine without Firefox is a refusal, not a Chromium run. |
| `safari`, `safari-tech-preview` | blocked by environment | `safaridriver` is macOS-only and needs `safaridriver --enable`; the adapter throws rather than producing a command line it cannot honour. |
| `webkit` (Playwright) | blocked by environment | Playwright publishes no Windows WebKit build. |
| `opera`, `opera-gx`, `vivaldi`, `arc`, `chromium`, `chrome-beta/dev/canary`, `edge-beta/dev/canary` | detected-not-probed-or-absent | the registry lists what it found; the probe drives every *installed* Chromium product, and this host has stable Chrome and stable Edge only. |
| `android-chrome`, `android-firefox`, `samsung-internet`, `ios-safari` | blocked by environment | no device attached; ADB and WebDriverAgent are not present. |

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
