# Usage

How to run sync on GitHub and on your machine.

Pipeline: `msys2/*` upstream -> `msys2-apiss/*` mirrors -> `msys2-apiss/msys2-apiss`
on branches `upstream`, `upstream-ports`, `upstream-ports-mingw`.

Local testing and debugging: [`run-local.md`](run-local.md). Design and flags:
[`PLAN.md`](PLAN.md).

## GitHub (`gh`)

Pushing to `main` on this repo runs [`mirror-poll.yml`](../.github/workflows/mirror-poll.yml)
and [`sync-upstream.yml`](../.github/workflows/sync-upstream.yml) automatically.

Requires the [GitHub CLI](https://cli.github.com/) (`gh auth login`) with access to
`msys2-apiss`. Each mirror repo needs `SYNC_DISPATCH_TOKEN` (see below).
`msys2-apiss-sync` needs `MSYS2_APISS_SYNC_TOKEN`.

### Setup `SYNC_DISPATCH_TOKEN` (each mirror repo)

One PAT per mirror org setup; reuse the **same token value** on every mirror repo.

1. **Create a PAT** ([fine-grained](https://github.com/settings/personal-access-tokens/new) recommended, or [classic](https://github.com/settings/tokens/new)):
   - **Fine-grained:** resource owner = `msys2-apiss`; repository access = all mirror repos (or each repo); permissions: **Contents** Read and write, **Workflows** Read and write, **Metadata** Read-only.
   - **Classic:** scopes **`repo`**, **`workflow`**.
2. **Add the secret on each mirror** (Settings -> Secrets and variables -> Actions):

```bash
gh secret set SYNC_DISPATCH_TOKEN --repo msys2-apiss/MSYS2-packages
gh secret set SYNC_DISPATCH_TOKEN --repo msys2-apiss/MINGW-packages
gh secret set SYNC_DISPATCH_TOKEN --repo msys2-apiss/mingw-w64
gh secret set SYNC_DISPATCH_TOKEN --repo msys2-apiss/glibc
gh secret set SYNC_DISPATCH_TOKEN --repo msys2-apiss/enscript
```

Paste the same PAT when prompted. Used for **git push** during mirror-sync (required
when upstream has `.github/workflows/*`) and for **repository_dispatch** to
`msys2-apiss-sync` on package mirrors (`Notify.Enabled: true`). Mirror-only repos
with no upstream workflow files (e.g. glibc) can omit the secret; checkout falls
back to `GITHUB_TOKEN`.

### 1. Refresh mirrors from upstream

Mirrors auto-refresh every ~15 minutes via [`mirror-poll.yml`](../.github/workflows/mirror-poll.yml) on this repo (GitHub per-repo `*/5` cron is unreliable). Mirror-poll skips dispatch when each mirror content branch already matches upstream. Manual trigger on branch `sync` (workflows live there, not on `master`):

```bash
gh workflow run mirror-sync.yml --repo msys2-apiss/MSYS2-packages --ref sync
gh workflow run mirror-sync.yml --repo msys2-apiss/MINGW-packages --ref sync
gh workflow run mirror-sync.yml --repo msys2-apiss/mingw-w64 --ref sync
gh workflow run mirror-sync.yml --repo msys2-apiss/glibc --ref sync
gh workflow run mirror-sync.yml --repo msys2-apiss/enscript --ref sync
```

Each mirror repo uses the same workflow template
[`config/mirror-template/mirror-sync.yml`](../config/mirror-template/mirror-sync.yml).
Per-repo settings come from [`config/mirror-sync/`](../config/mirror-sync/) and are
applied to `.github/mirror-sync.json` on branch `sync` by `yarn fetch-mirrors` when
templates differ or the branch layout is invalid.
Package mirrors notify `msys2-apiss-sync` when `Notify.Enabled` is true; mirror-only repos
(`mingw-w64`, `glibc`) set `Notify.Enabled` to false.

### 2. Watch mirror runs

```bash
gh run watch --repo msys2-apiss/MSYS2-packages
gh run watch --repo msys2-apiss/MINGW-packages
gh run watch --repo msys2-apiss/mingw-w64
gh run watch --repo msys2-apiss/glibc
```

If upstream advanced, package mirror workflows fast-forward mirror `master` and
dispatch `msys2-apiss-sync` when configured in `.github/mirror-sync.json`.
Mirror-only repos (`mingw-w64`, `glibc`) only update their GitHub mirror (no
destination replay). If there were no upstream changes, skip to step 3 only when
you still need a destination replay.

### 3. Replay destination

Usually automatic after step 2. Trigger manually when mirrors are already current
or dispatch did not run:

```bash
gh workflow run sync-upstream.yml --repo msys2-apiss/msys2-apiss-sync
gh run watch --repo msys2-apiss/msys2-apiss-sync
```

### 4. Verify CI run

```bash
gh run list --repo msys2-apiss/msys2-apiss-sync --workflow sync-upstream.yml --limit 5
```

Check destination branch tips on `msys2-apiss/msys2-apiss` (`upstream`,
`upstream-ports`, `upstream-ports-mingw`).

To verify the destination matches what replay would produce (dry-run, no push),
run locally: [`run-local.md`](run-local.md#verify-replay-manifest).

### Recovery and special cases

| Goal | Command |
|------|---------|
| Resume after failure | Repeat step 3 (incremental from branch cursors) |
| Reset branches, full replay | `gh workflow run sync-upstream.yml --repo msys2-apiss/msys2-apiss-sync -f clean=true` |

## Local machine

Requires **Node.js 26+**, **Yarn**, **git**, and network (mirror clone/fetch).

From the repository root.

### Mirrors

```bash
yarn fetch-mirrors
yarn fetch-mirrors --push-sync
yarn fetch-mirrors --skip-fetch
yarn fetch-mirrors --skip-fetch --push-sync
yarn mirror-poll
```

`--push-sync` runs `git push --force-with-lease origin sync` on each mirror when
local `sync` differs from `origin/sync`. Requires push access to `msys2-apiss/*`
mirror repos.

`yarn mirror-poll` compares each mirror content branch to upstream and dispatches
`mirror-sync` only when they differ (same logic as CI). Requires
`MSYS2_APISS_SYNC_TOKEN` or `GITHUB_TOKEN`.

### Full sync (retrieve, merge, replay, push)

```bash
yarn fetch-mirrors
yarn retrieve-history
yarn merge-queue
yarn sync --destination-path .work/destination/msys2-apiss
```

Or one step:

```bash
yarn sync --destination-path .work/destination/msys2-apiss
```

Each script prints `[sync]` progress. Summary JSON is written under
`.work/cache/replay-log/`.

### Skip re-fetch

When mirrors already exist under `.work/mirrors/`:

```bash
yarn sync --skip-fetch --destination-path .work/destination/msys2-apiss
```

### Resume after interrupt or failure

Re-run without `--clean`. Branch cursors in the destination clone hold progress.

```bash
yarn sync --skip-fetch --destination-path .work/destination/msys2-apiss --log-file sync-run.log --log-append
```

### Bootstrap from scratch

Reset sync branches and replay from history root:

```bash
yarn sync --clean --destination-path .work/destination/msys2-apiss
```

### Verify replay manifest

Compare GitHub destination branches with what incremental replay would produce.
No push; exit code 0 means no drift.

Clone the destination once if needed:

```bash
git clone https://github.com/msys2-apiss/msys2-apiss.git .work/destination/msys2-apiss
```

Then:

```bash
yarn fetch-mirrors --skip-fetch
yarn sync --dry-run --skip-fetch --destination-path .work/destination/msys2-apiss
```

Details and log capture: [`run-local.md`](run-local.md#verify-replay-manifest).
