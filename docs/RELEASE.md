# Release

How to publish `pro-fetch`, and what is already verified.

## Preconditions (all verified)

| Check                   | Evidence (re-measured 2026-10-31)                                              |
| ----------------------- | ------------------------------------------------------------------------------- |
| Version cut             | `1.0.0` in `package.json` and the lockfile, `CHANGELOG.md` has a `[1.0.0]` section |
| `npm run check` green   | 1231 tests, 70 files, static + registry + package + format all PASS, exit 0     |
| Tarball clean           | 570 files, no `.env`, no keys, no `.d.ts`, shebang present (`verify:package`)    |
| Name free               | `npm view pro-fetch` → HTTP 404 (free)                                          |
| Old name               | `pro-fetch-mcp` exists on npm at `0.0.0-stage`, owned by this maintainer         |
| `npm publish --dry-run` | PASS (runs `prepublishOnly` → full `npm run check` first)                        |

## Publish (requires the maintainer's npm account)

```bash
npm login
npm publish
```

That is the entire remaining procedure. `prepublishOnly` runs the full verification chain before
anything is uploaded, so a broken tree cannot be published by accident. The package is unscoped, so
it publishes public by default; no `publishConfig` is needed.

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
