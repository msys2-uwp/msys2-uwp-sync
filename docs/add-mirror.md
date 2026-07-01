# Add a mirror

Checklist for adding a new `msys2-apiss/*` mirror repo. Use this doc when asked to
add a mirror; do not invent a GitHub Actions bootstrap workflow in this repo.

Local clones are **working copies** under `.work/mirrors/<repo>/`, checked out on
branch **`msys2-apiss-mirror-sync`**, so you can edit the mirror-sync workflow and
re-run **`yarn mirror-init`** before push.

Design: [`PLAN.md`](PLAN.md). Mirror templates: [`config/mirror-template/`](../config/mirror-template/).
Ops: [`usage.md`](usage.md). Block 1 branch layout:
[`mirror-init.md` -- Tooling branch layout](mirror-init.md#tooling-branch-layout).

## Branch layout

Every mirror repo uses two branches. Layout and bootstrap steps are defined once in
[`mirror-init.md`](mirror-init.md#tooling-branch-layout) (shared with
**`msys2-apiss-mirror-merge`** on the destination repo).

| Branch | Role |
|--------|------|
| **`msys2-apiss-mirror-sync`** | Tooling branch: `.github/workflows/mirror-sync.yml`, `.github/mirror-sync.json`, `toolings/` ([Tooling branch layout](mirror-init.md#tooling-branch-layout)) |
| **`master`** (or first `Branches[].Mirror` in config) | Pure upstream mirror; no workflow files |

Replay and mirror tips still read **`origin/master`** (or the configured mirror
branch); local edits on **`msys2-apiss-mirror-sync`** do not affect replay until pushed.

### Auto-repair sync branch layout

**`yarn mirror-init`** runs the [Tooling branch layout](mirror-init.md#tooling-branch-layout)
for **`msys2-apiss-mirror-sync`**. It applies `config/mirror-sync/` templates when they
differ from the mirror working copy.

After editing `.github/` locally on **`msys2-apiss-mirror-sync`**:

```bash
yarn mirror-init --skip-fetch --repo glibc
yarn mirror-init --skip-fetch --repo glibc --push
```

See [`mirror-init.md`](mirror-init.md) for flags.

## Local mirror path

All mirrors live here (gitignored):

```text
.work/mirrors/<repo-name>/
```

Examples:

| GitHub repo | Local working copy |
|-------------|-------------------|
| `msys2-apiss/MSYS2-packages` | `.work/mirrors/MSYS2-packages` |
| `msys2-apiss/MINGW-packages` | `.work/mirrors/MINGW-packages` |
| `msys2-apiss/mingw-w64` | `.work/mirrors/mingw-w64` |
| `msys2-apiss/glibc` | `.work/mirrors/glibc` |

Per-mirror JSON configs live in **`config/mirror-sync/<repo-name>.json`** (canonical
source). `yarn mirror-init` copies templates to `.work/mirrors/<repo>/.github/` on branch
**`msys2-apiss-mirror-sync`** when files differ or layout is invalid ([Tooling branch layout](mirror-init.md#tooling-branch-layout)).

Example: `config/mirror-sync/MINGW-packages.json` for `msys2-apiss/MINGW-packages`.

```bash
yarn fetch-mirrors
yarn fetch-mirrors --skip-fetch   # re-apply when config/mirror-sync/*.json changed
yarn fetch-mirrors --skip-fetch --push   # apply and push msys2-apiss-sync when local differs from origin
```

## Mirror-only vs package mirror

| Kind | Replay into `msys2-apiss` | Registration |
|------|---------------------------|----------------|
| Package mirror | yes (`ports/` or `ports-mingw/`) | `Sources.*` + name in `config/mirror-poll.json` `Repos` + `config/mirror-sync/<repo>.json` |
| Mirror-only | no | entry in `config/mirror-poll.json` `Repos` + `config/mirror-sync/<repo>.json` |

Use mirror-only for upstream repos that are mirrored on GitHub but not replayed
into the destination (e.g. `mingw-w64`, `glibc`).

## Steps: mirror-only repo

### 1. Add `config/mirror-sync/<repo-name>.json`

Create `config/mirror-sync/my-tool.json` (copy from `glibc.json` or
`mingw-w64.json` and edit):

```json
{
  "UpstreamUrl": "https://example.com/upstream.git",
  "Url": "https://example.com/upstream",
  "Description": "My upstream tool",
  "Branches": [{ "Upstream": "master", "Mirror": "master" }],
  "Notify": { "Enabled": false }
}
```

Register the repo name in `config/mirror-poll.json` `Repos` (and set `Owner` if not already `msys2-apiss`):

```json
{
  "Owner": "msys2-apiss",
  "Destination": {
    "Repo": "msys2-apiss",
    "DefaultBranch": "main"
  },
  "Repos": [
    "MSYS2-packages",
    "MINGW-packages",
    "my-tool"
  ]
}
```

Top-level `"Owner"` applies to all mirror repos and the destination.

All mirror metadata (`UpstreamUrl`, `Url`, `Description`, branches, notify)
lives in `config/mirror-sync/<repo-name>.json` only.

### 2. Bootstrap on GitHub

Run (creates the GitHub repo with `gh` when missing, pushes **`msys2-apiss-mirror-sync`**,
dispatches mirror-sync; Block 3 pushes the content branch):

```bash
yarn mirror-init --repo my-tool --push
```

This fetches upstream commit graph blob:none, checks out the root commit only
locally ([Tooling branch layout](mirror-init.md#tooling-branch-layout)), pushes
**`msys2-apiss-mirror-sync`**, triggers `mirror-sync` on GitHub (Block 3 fetches
upstream and pushes the content branch), then restores default branch when needed.

Later, `yarn fetch-mirrors` clones into `.work/mirrors/my-tool/` on branch
**`msys2-apiss-sync`** and applies `config/mirror-sync/my-tool.json` when templates differ.

Re-push workflow templates after config edits:

```bash
yarn fetch-mirrors --skip-fetch --push
```

On first bootstrap, `--push` temporarily sets default branch to `msys2-apiss-sync` so
GitHub registers `mirror-sync.yml`, triggers mirror-sync, then immediately sets
default back to the content branch (`master` or configured mirror branch). It
does not wait for the run to finish. Later **`--push`** dispatches Block 3 on ref **`msys2-apiss-mirror-sync`**, then Block 2
unless **`--no-poll`** ([`mirror-poll.md`](mirror-poll.md)).

Or manually:

```bash
# after pushing msys2-apiss-mirror-sync locally
gh api repos/msys2-apiss/my-tool -X PATCH -f default_branch=msys2-apiss-sync
gh workflow run mirror-sync.yml --repo msys2-apiss/my-tool --ref msys2-apiss-sync
gh run watch --repo msys2-apiss/my-tool $(gh run list --repo msys2-apiss/my-tool --workflow mirror-sync.yml --limit 1 --json databaseId -q '.[0].databaseId')
gh api repos/msys2-apiss/my-tool -X PATCH -f default_branch=master
```

Mirror-only repos do not need remote secrets. Package mirrors with
`Notify.Enabled: true` need `SYNC_DISPATCH_TOKEN` on the mirror repo (see
[`usage.md`](usage.md)). Repos with `PushViaSsh` true need `MIRROR_PUSH_SSH_KEY`.
Set secrets with `gh secret set` on each mirror repo.

Or push local template edits without re-fetching from origin:

```bash
yarn mirror-init --skip-fetch --repo my-tool --push
```

Remove manual copy steps for templates; edit `config/mirror-sync/*.json` in
msys2-apiss-sync, re-run `yarn fetch-mirrors --skip-fetch --push`.

Block 2 picks up any repo listed in `config/mirror-poll.json` `Repos`
([`mirror-poll.md`](mirror-poll.md)).

### 3. Local workflow edits

Work in `.work/mirrors/my-tool/` (checkout **`msys2-apiss-mirror-sync`** after `yarn mirror-init`):

```bash
# edit .github/workflows/mirror-sync.yml or .github/mirror-sync.json
yarn mirror-init --skip-fetch --repo my-tool
yarn mirror-init --skip-fetch --repo my-tool --push
```

**`yarn mirror-init`** repairs layout via the [Tooling branch layout](mirror-init.md#tooling-branch-layout).
Use **`--push`** when ready for GitHub.

## Steps: package mirror (replay)

Package mirrors already exist for `MSYS2-packages` and `MINGW-packages`. Adding
another replayed source requires a `Sources.*` entry, destination path mapping,
and replay code changes -- see [`PLAN.md`](PLAN.md). For those mirrors, the local
path is still `.work/mirrors/<repo>/`.

Use `Notify.Enabled: true` in `config/mirror-sync/<repo>.json` and set
`SYNC_DISPATCH_TOKEN` on the mirror repo with `gh secret set`. That secret is
used for `workflow_dispatch_mirror_merge` to `msys2-apiss-sync` after mirror-sync advances
content.

## Verify

```bash
yarn fetch-mirrors
yarn test tests/sync/config.test.ts
```

Expect log lines like:

```text
[sync] mingw-w64 mirror: .work/mirrors/mingw-w64 (msys2-apiss-sync = abc12345, master = def67890)
```

Check remote tip:

```bash
git -C .work/mirrors/my-tool rev-parse origin/master
```

## Related

- [`mirror-init.md` -- Tooling branch layout](mirror-init.md#tooling-branch-layout)
- [`apply-patches-usage.md`](apply-patches-usage.md) -- apply mapped commits from
  package mirrors into a destination branch
- [`config/mirror-template/mirror-sync.yml`](../config/mirror-template/mirror-sync.yml) -- shared
  workflow installed on each mirror **`msys2-apiss-mirror-sync`** branch
