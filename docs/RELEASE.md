# Release

How to publish `pro-fetch`, and what is already verified.

## Preconditions (all verified)

| Check                   | Evidence (re-measured 2026-10-31)                                              |
| ----------------------- | ------------------------------------------------------------------------------- |
| `npm run check` green   | 1228 tests, 70 files, static + registry + package + format all PASS, exit 0     |
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
npm view pro-fetch version
npx -y pro-fetch --help   # bin entry: dist/server.js
```

The previous package name, `pro-fetch-mcp`, is this maintainer's own placeholder (`0.0.0-stage`).
Once `pro-fetch` is published, retire the old one so nobody installs a dead name:

```bash
npm deprecate pro-fetch-mcp "renamed: use pro-fetch"
```

## What this does not do

- No version bump is included. Bump `version` in `package.json` and add a `CHANGELOG.md` entry first
  when the next release is cut.
- No GitHub release is created. `origin` is configured and `main` is pushed; tagging and a GitHub
  Release are separate steps the maintainer runs.
- No provenance attestation (`--provenance` needs CI OIDC; the workflow does not configure it).
