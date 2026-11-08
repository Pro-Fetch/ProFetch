# Release

How `@pro-fetch/mcp` gets onto npm, and which of these statements are measurements rather than memory.

## Preconditions (re-measured 2026-11-08)

| Check                 | Evidence                                                                                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repo version          | `1.1.0` in `package.json`. **npm still serves `1.0.0`** — read from the registry today, published 2026-11-01. Everything merged since that date (two-stage fetch, browser pool, resource policy, document envelope, crawl queue, crawl policy, circuit breaker) is therefore not installable by anyone yet. |
| `npm run check`       | Measured twice in a row today: **1971 tests across 116 files, exit 0**; verify:static, verify:registry, audit:schema (dead=0), verify:package and format:check all PASS                              |
| Tarball               | `verify:package`: files=676, shebang present, zero credentials, no source files shipped                                                                                                             |
| Package identity      | `@pro-fetch/mcp` — public, owned by the `pro-fetch` organisation, homepage `github.com/Pro-Fetch/ProFetch`                                                                                          |
| Old unscoped name     | `pro-fetch-mcp` also belongs to this maintainer, at **0.3.0** (homepage points at an older repo). It should be deprecated, not deleted — see below                                                    |
| `npm publish --dry-run` | **Not re-measured today.** Local dry-run needs npm authentication, which is exactly the step CI now performs without any credential. Do not quote the old row as current evidence                   |

## Publish: Trusted Publishing, no token anywhere

Publishing runs in CI: `.github/workflows/publish.yml`. The runner asks GitHub for a short-lived OIDC
identity and npm matches it against a trust rule set on the package. **No npm token exists** — not in a
repository secret, not in `~/.npmrc`, not in chat history. There is nothing to leak and nothing to rotate.

Two details that fail loudly but are easy to miss:

- The job must declare `environment: npm`. Without it the token carries no environment claim and npm refuses
  the publish with an error that reads like a permissions bug.
- The workflow must NOT set `NODE_AUTH_TOKEN`. If that variable is present, npm authenticates with it and
  never tries OIDC — trusted publishing then silently stops being the path taken.

### One-time setup (maintainer, in a browser)

`https://www.npmjs.com/package/@pro-fetch/mcp` → **Settings** (npm asks the account password once) →
**Trusted Publisher**, with exactly these values:

| Field | Value |
| --- | --- |
| Publisher | GitHub Actions |
| Organization or user | `Pro-Fetch` |
| Repository | `ProFetch` |
| Workflow filename | `publish.yml` |
| Environment name | `npm` |
| Allowed actions | **Allow npm publish** |

`Allow npm dist-tag` is left unchecked on purpose: `npm publish --tag next` is covered by the publish
permission, and the extra box would only allow moving tags after the fact. The form says the connection
cannot be *edited* later — it can be deleted and recreated, so this is a reversible decision rather than a
permanent one.

### The release itself

```bash
# 1. version + changelog + green check, committed and pushed
npm version 1.1.0 --no-git-tag-version   # or edit package.json by hand
npm run check

# 2. tag and release
git tag v1.1.0 && git push origin v1.1.0
# GitHub → Releases → Draft a release → tag v1.1.0 → Publish release
```

Publishing is triggered by a **published release**, not by a push. The workflow then:

1. refuses if the tag (`v1.1.0`) and `package.json` (`1.1.0`) disagree — a mismatched number cannot sail
   through to 300 installs;
2. runs the full `npm run check` inside CI, so a build that is broken on a clean machine never publishes;
3. publishes a prerelease version (`…-beta.1`) under the `next` tag and a stable one under `latest`;
4. passes `--provenance`, which records which repository and which run built the tarball. That attestation
   is the difference between "somebody uploaded a package with this name" and "this commit, in this repo, in
   run 12345, produced it".

### Fallback: a maintainer at a keyboard

Still works, still needs the account, and is the only path that involves a secret:

```bash
npm login                       # browser + 2FA — an authenticator app, not email
npm run check
npm publish --access public --provenance
```

**The package is scoped.** npm defaults a new scoped package to _restricted_, which for an organisation
without a paid plan fails the publish outright, so `--access public` is not optional in either path.

## Why the token path is not trusted for CI

npm's own tracker carries the reason: **npm/cli issue #8869**, "NPM Granular Access Token are unable to
Bypass two-factor authentication (2FA)", opened 19 December 2025, labelled *Bug* and *Registry*, assigned to
npm staff, ten-plus 👍. Its claim is that the **"Bypass two-factor authentication (2FA)"** checkbox on the
granular-token form does not take effect — "programmatically checking the box doesn't have an effect". A
token created with that box ticked can still be refused by the registry when the request comes from a
non-interactive machine, which is exactly what a CI runner is.

Measured on this project in the same hour:

| Check | Result |
| --- | --- |
| `GET /-/whoami` with the workstation token, from this machine | `200` and the username — fingerprint `3a5fcc68` |
| The same call inside the GitHub runner, using the repository secret | `401 Unauthorized` — fingerprint `469740c8` |

Honest reading: **two things differed at once** — the token identity and the source address. So the open npm
bug is the mechanism that explains a well-formed token being refused from a runner; it is not proven to be
the only cause here. Either way the conclusion is the same: a granular token is not a dependable CI
credential right now, and npm has separately announced that bypass-2FA tokens lose direct publish in
January 2027.

The decision, written down so it does not get re-litigated:

- **When CI is blocked and a release is needed**, publish from a workstation with the credential that
  demonstrably authenticates. The cost is stated rather than hidden: that release carries no GitHub build
  attestation, because the attestation step lives in the workflow.
- **For future releases**, OIDC trusted publishing — no token, no expiry, and the only mode that produces
  npm's own provenance badge. The workflow already contains that branch; it waits on the one-time trust
  rule on the package's Settings page, which needs the maintainer's password and second factor.

## After publishing

```bash
npm view @pro-fetch/mcp version
npx -y @pro-fetch/mcp --help      # bin entry: dist/server.js
```

## The old name

`pro-fetch-mcp` is this maintainer's earlier placeholder (measured today at 0.3.0). Deprecating it keeps the
page alive and makes every install of the old name print where to go; deleting it would teach nobody
anything:

```bash
npm deprecate pro-fetch-mcp "eski nom — yangisi: @pro-fetch/mcp"
```

## What this does not do

- No credential is stored by this repository, and no publish happens from a workstation unless the
  maintainer runs it deliberately.
- No GitHub Release is created by CI; the release is the human act that triggers everything else.
- No dist-tag moves, no unpublish, no deprecate automation — those remain explicit commands above.
