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

## Publish: trusted publishing first, token only as a bridge

Publishing runs in CI: `.github/workflows/publish.yml`. The runner asks GitHub for a short-lived OIDC
identity and npm matches it against a trust rule set on the package. The publish step tries **OIDC first**
and only falls back to the `NPM_TOKEN` secret if npm refuses that identity — the order matters, because a
run that reaches for the token first never learns whether trusted publishing works.

Honest status of the credential: a granular token still exists as a repository secret, because 1.1.0 and
1.2.0 were published with it. It is a bridge, not the design. Once a release ships through OIDC the secret
can be deleted; until then the workflow prefers the attested path regardless of the secret being present.

Four details that fail loudly but are easy to miss:

- The runner needs **npm CLI ≥ 11.5.1 and Node ≥ 22.14.0** — npm's own stated floor for trusted publishing.
  This workflow used to pin Node `22.13`, which installs npm 10.x: an OIDC publish from it cannot work, and
  the failure reads like npm refusing the package rather than like a tool too old to ask. The job now runs
  Node 24 and a step measures `npm --version`, upgrading it when it is below the floor.
- The job must declare `environment: npm`. Without it the token carries no environment claim and npm refuses
  the publish with an error that reads like a permissions bug.
- The workflow must NOT set `NODE_AUTH_TOKEN`. If that variable is present, npm authenticates with it and
  never tries OIDC — trusted publishing then silently stops being the path taken.
- No step may write the token into the npmrc that the *later* publish reads. `actions/setup-node` points npm
  at a runner temp file via `NPM_CONFIG_USERCONFIG`, and an earlier version of this workflow appended the
  token to exactly that file during its preflight — so by the time the OIDC branch ran, npm already had a
  secret-backed identity and could not attest the upload. The credential probe now writes a throwaway npmrc
  and exports the variable inside its own step only.

### One-time setup (maintainer, in a browser)

`https://www.npmjs.com/package/@pro-fetch/mcp` → **Settings** → **Trusted Publisher**, with exactly these
values. This step is manual for two reasons, not one: npm requires the account password, and modifying a
package's settings requires an **interactive two-factor challenge** — for this account that is a WebAuthn
ceremony with the registered security key. A script cannot stand in for it: a browser refuses to open a
WebAuthn prompt that no real user click started, so a synthetic click fails quietly and npm bounces back to
its 2FA page, which reads like "2FA is not configured" when it is.

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

### Two jobs, because the two halves want different machines

`build` (GitHub-hosted Ubuntu) runs `npm ci`, the full `npm run check`, `npm pack` and the GitHub build
attestation, then uploads the tarball. `publish` downloads it and makes the one network call that needs a
credential.

The split is not decoration. Measured: the granular token authenticates from this workstation and gets
**E401 from a GitHub-hosted runner** (npm/cli#8869). A self-hosted runner publishes from a residential
address, where npm accepts the token — so verification can stay in the cloud and only the publish call moves.
Which machine runs `publish` is a repository **variable**, `PUBLISH_RUNNER`; unset it is `ubuntu-latest`,
set to a runner label (here `profetch-publish`) and it is that machine.

Two properties the split has to keep, and how:

- **The attestation must describe the shipped bytes.** `build` exports the tarball's sha256; `publish`
  recomputes it on the downloaded file and refuses to publish on a mismatch. Verified both ways: identical
  bytes pass, a changed hash stops the job.
- **`environment: npm` stays on the publishing job**, because that is what puts the environment claim into
  the OIDC token and what gates a release on a human.

What a self-hosted publish does NOT buy: npm documents OIDC for **GitHub-hosted runners only**, so from a
self-hosted runner the OIDC attempt fails and the token carries the release — published, attested by GitHub,
but with **no npm provenance badge**. That badge still waits on the trusted-publisher rule.

The cost, stated plainly: a self-hosted runner on a **public** repository means workflow code from a pull
request can execute on the machine hosting it. GitHub keeps secrets away from fork runs and asks a
maintainer to approve first-time contributors, and the runner here carries a label no other workflow uses —
but the general risk of running a build agent on a personal computer remains, and it is the reason this is a
deliberate switch rather than the default.

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
- **For future releases**, OIDC trusted publishing — no expiry, and the only mode that produces npm's own
  provenance badge. The workflow now tries it first, so the one thing still missing is the one-time trust
  rule on the package's Settings page, which needs the maintainer's password and second factor. The token
  secret does not have to be deleted for that path to be taken; it just stops being used once the rule works.

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
