# Release

How to publish `pro-fetch`, and what is already verified.

## Preconditions (all verified)

| Check                   | Evidence (re-measured 2026-10-31)                                                                                                                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Version cut             | `1.0.0` in `package.json` and the lockfile, `CHANGELOG.md` has a `[1.0.0]` section                                                                                                                                                                                                                           |
| `npm run check` green   | 1231 tests, 70 files, static + registry + package + format all PASS, exit 0                                                                                                                                                                                                                                  |
| Tarball clean           | 637 files, no `.env`, no keys, no `.d.ts`, shebang present (`verify:package`)                                                                                                                                                                                                                                |
| Name free               | `npm view pro-fetch` → HTTP 404 (free)                                                                                                                                                                                                                                                                       |
| Old name                | `pro-fetch-mcp` exists on npm at `0.0.0-stage`, owned by this maintainer                                                                                                                                                                                                                                     |
| `npm publish --dry-run` | **Re-measure before trusting this row.** 2026-11-06: exited 1 — `prepublishOnly` ran the full check and the suite lost a worker at 103 of 104 files (`Worker exited unexpectedly`). The runner now recognises that signature and retries; a green dry-run is the precondition for publishing, not a footnote |

## Publish (requires the maintainer's npm account)

**The package is scoped — `@pro-fetch/mcp`.** npm defaults a new scoped package to _restricted_, which for
an organisation without a paid plan fails the publish outright. So `--access public` is not optional:

```bash
npm login            # brauzer orqali, OTP soyaladi
npm publish --access public
```

Yoki token bilan (mashinada `npm whoami` → `ENEEDAUTH` bo'lsa, yo'l shu):

```bash
# npmjs.com → avatar → Access Tokens → Generate New Token → Role: Automation
npm config set //registry.npmjs.org/:_authToken=<npm_tokeningiz>
npm publish --access public
```

Token **chatga, commitga yoki issue'ga yozilmaydi** — u `~/.npmrc`da qoladi va uni ko'rish uchun sizning
hisobingiz kerak. `prepublishOnly` to'liq tekshiruv zanjirini yuborishdan oldin ishga tushiradi, ya'ni
buzuq holat tasodifan chiqmaydi.

## After publishing

```bash
npm view @pro-fetch/mcp version
npx -y @pro-fetch/mcp --help   # bin entry: dist/server.js
```

The previous package name, `pro-fetch-mcp`, is this maintainer's own placeholder (`0.0.0-stage`).
Once `pro-fetch` is published, retire the old one so nobody installs a dead name:

```bash
npm deprecate pro-fetch-mcp "renamed: use pro-fetch"
```

## What this does not do

- No publish. `npm login` is the maintainer's own account operation, and nothing here touches it.
- No GitHub Release. `origin` points at `Pro-Fetch/ProFetch`, `main` is pushed and `v1.0.0` is tagged;
  publishing release notes is a separate step in the web UI.
- No provenance attestation (`--provenance` needs CI OIDC; the workflow does not configure it).
