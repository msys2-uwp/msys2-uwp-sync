# Usage

How to run sync on GitHub and on your machine.

Pipeline: `msys2/*` upstream -> `msys2-apiss/*` mirrors -> `msys2-apiss/msys2-apiss`
on branches `upstream`, `upstream-ports`, `upstream-ports-mingw`.

Local testing and debugging: [`run-local.md`](run-local.md). Design and flags:
[`PLAN.md`](PLAN.md). Block 1: [`mirror-init.md`](mirror-init.md) ([Tooling branch layout](mirror-init.md#tooling-branch-layout)).

## GitHub (`gh`)

Pushing to `main` on this repo runs [`mirror-poll.yml`](../.github/workflows/mirror-poll.yml)
automatically. Block 4 CI is [`mirror-merge.yml`](../config/mirror-template/mirror-merge.yml)
on destination repo **`msys2-apiss/msys2-apiss`**, branch **`msys2-apiss-mirror-merge`**
(installed by `yarn mirror-init`; [Tooling branch layout](mirror-init.md#tooling-branch-layout)).

Requires the [GitHub CLI](https://cli.github.com/) (`gh auth login`) with access to
`msys2-apiss`. Local commands use **git** and **gh** only; no env secrets.
`SYNC_DISPATCH_TOKEN` and `MIRROR_PUSH_SSH_KEY` are GitHub Actions secrets on
remote repos (see below); set them with `gh secret set`.

### Setup `SYNC_DISPATCH_TOKEN`

One PAT is reused in three places:

| Where | Block | Purpose |
|-------|-------|---------|
| `msys2-apiss/msys2-apiss-sync` | Block 2 | [`mirror-poll.yml`](../.github/workflows/mirror-poll.yml) dispatches `mirror-sync` on mirror repos (`GH_TOKEN`) |
| `msys2-apiss/MSYS2-packages`, `MINGW-packages` | Block 3 | `mirror-sync.yml` notify step runs `gh workflow run mirror-merge.yml` on Block 4 |

Package mirrors **`MSYS2-packages`** and **`MINGW-packages`** need the secret on
the mirror repo (`Notify.Enabled: true`). The tooling repo needs the same PAT
so CI mirror-poll can trigger Block 3 when tips differ.

1. **Create a PAT** ([fine-grained](https://github.com/settings/personal-access-tokens/new) recommended, or [classic](https://github.com/settings/tokens/new)):
   - **Fine-grained:** resource owner = `msys2-apiss`; repository access =
     `MSYS2-packages`, `MINGW-packages`, and `msys2-apiss-sync`; permissions:
     **Contents** Read and write, **Workflows** Read and write, **Metadata**
     Read-only.
   - **Classic:** scopes **`repo`**, **`workflow`**.
2. **Add the secret on each package mirror** and on the tooling repo (Block 2
   [`mirror-poll.yml`](../.github/workflows/mirror-poll.yml) uses the same PAT to
   dispatch `mirror-sync` on mirror repos):

```bash
gh secret set SYNC_DISPATCH_TOKEN --repo msys2-apiss/MSYS2-packages
gh secret set SYNC_DISPATCH_TOKEN --repo msys2-apiss/MINGW-packages
gh secret set SYNC_DISPATCH_TOKEN --repo msys2-apiss/msys2-apiss-sync
```

Mirror-only repos (`aports`, `glibc`, `gcc`, etc.) do not need this secret;
mirror-sync uses `github.token` for checkout and push when the secret is unset.

### Setup `MIRROR_PUSH_SSH_KEY` (SSH push, large mirrors)

When `PushViaSsh` is true in `config/mirror-sync/<repo>.json` (only gcc today),
mirror-sync pushes via `git@github.com:` instead of HTTPS. This avoids
HTTP/2 disconnects on large initial syncs (e.g. gcc).

1. **Generate a deploy key** (write access) or reuse one org-wide key pair:

```bash
ssh-keygen -t ed25519 -f mirror-push -N "" -C "msys2-apiss-mirror-push"
```

2. **Add the public key** (`mirror-push.pub`) as a **deploy key** with write
   access on each mirror repo that uses SSH push (Settings -> Deploy keys).
   The Actions secret alone is not enough; GitHub must have the matching public
   key on the repo.

```powershell
gh api repos/msys2-apiss/gcc/keys `
  -f title="mirror-push" `
  -f key="$(Get-Content -Raw mirror-push.pub)" `
  -f read_only=false
```

3. **Add the private key** as secret `MIRROR_PUSH_SSH_KEY` on those repos (or as
   an organization secret shared by all mirrors):

```powershell
Get-Content -Raw mirror-push | gh secret set MIRROR_PUSH_SSH_KEY --repo msys2-apiss/gcc
```

SSH is used only for `git push` on repos with `PushViaSsh` true.

### 1. Refresh mirrors from upstream

Mirrors auto-refresh about hourly via [`mirror-poll.yml`](../.github/workflows/mirror-poll.yml) on this repo (`PollIntervalMinutes` in `config/mirror-poll.json`: 60; GitHub cron is best-effort). Mirror-poll skips dispatch when each mirror content branch already matches upstream. Manual trigger on branch `msys2-apiss-mirror-sync` (workflows live there, not on `master`; [Tooling branch layout](mirror-init.md#tooling-branch-layout)):

```bash
gh workflow run mirror-sync.yml --repo msys2-apiss/MSYS2-packages --ref msys2-apiss-mirror-sync
gh workflow run mirror-sync.yml --repo msys2-apiss/MINGW-packages --ref msys2-apiss-mirror-sync
gh workflow run mirror-sync.yml --repo msys2-apiss/mingw-w64 --ref msys2-apiss-mirror-sync
gh workflow run mirror-sync.yml --repo msys2-apiss/glibc --ref msys2-apiss-mirror-sync
gh workflow run mirror-sync.yml --repo msys2-apiss/enscript --ref msys2-apiss-mirror-sync
gh workflow run mirror-sync.yml --repo msys2-apiss/gcc --ref msys2-apiss-mirror-sync
```

Each mirror repo uses the same workflow template
[`config/mirror-template/mirror-sync.yml`](../config/mirror-template/mirror-sync.yml).
Per-repo settings come from [`config/mirror-sync/`](../config/mirror-sync/) and are
applied to `.github/mirror-sync.json` on branch `msys2-apiss-mirror-sync` by `yarn mirror-init` when
templates differ or the branch layout is invalid ([Tooling branch layout](mirror-init.md#tooling-branch-layout)).
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
gh workflow run mirror-merge.yml --repo msys2-apiss/msys2-apiss --ref msys2-apiss-mirror-merge
gh run watch --repo msys2-apiss/msys2-apiss-sync
```

### 4. Verify CI run

```bash
gh run list --repo msys2-apiss/msys2-apiss --workflow mirror-merge.yml --ref msys2-apiss-mirror-merge --limit 5
```

Check destination branch tips on `msys2-apiss/msys2-apiss` (`upstream`,
`upstream-ports`, `upstream-ports-mingw`).

To verify the destination matches what replay would produce (dry-run, no push),
run locally: [`run-local.md`](run-local.md#verify-replay-manifest).

### Recovery and special cases

| Goal | Command |
|------|---------|
| Resume after failure | Repeat step 3 (incremental from branch cursors) |
| Reset branches, full replay | `gh workflow run mirror-merge.yml --repo msys2-apiss/msys2-apiss --ref msys2-apiss-mirror-merge -f clean=true` |

## Local machine

Requires **Node.js 26+**, **Yarn**, **git**, and network (mirror clone/fetch).

From the repository root.

### Mirrors

```bash
yarn fetch-mirrors
yarn fetch-mirrors --push
yarn fetch-mirrors --skip-fetch
yarn fetch-mirrors --skip-fetch --push
yarn mirror-poll
```

`--push` runs `git push --force-with-lease origin msys2-apiss-sync` on each mirror when
local `msys2-apiss-sync` differs from `origin/msys2-apiss-sync`. Requires push access to `msys2-apiss/*`
mirror repos.

`yarn mirror-poll` compares upstream tips and dispatches Block 3 when behind.
`yarn mirror-init --push` pushes mirror branches and dispatches Block 3 directly
(no tip comparison). Both use `gh` (`gh auth login` locally; in CI
[`mirror-poll.yml`](../.github/workflows/mirror-poll.yml) uses `SYNC_DISPATCH_TOKEN`
when set).

### Full sync (retrieve, merge, replay, push)

```bash
yarn fetch-mirrors
yarn retrieve-history
yarn merge-queue
yarn mirror-merge --destination-path .work/destination/msys2-apiss
```

Or one step:

```bash
yarn mirror-merge --destination-path .work/destination/msys2-apiss
```

Each script prints `[sync]` progress. Summary JSON is written under
`.work/cache/replay-log/`.

### Skip re-fetch

When mirrors already exist under `.work/mirrors/`:

```bash
yarn mirror-merge --skip-fetch --destination-path .work/destination/msys2-apiss
```

### Resume after interrupt or failure

Re-run without `--clean`. Branch cursors in the destination clone hold progress.

```bash
yarn mirror-merge --skip-fetch --destination-path .work/destination/msys2-apiss --log-file sync-run.log --log-append
```

### Bootstrap from scratch

Reset sync branches and replay from history root:

```bash
yarn mirror-merge --clean --destination-path .work/destination/msys2-apiss
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
yarn mirror-merge --dry-run --skip-fetch --destination-path .work/destination/msys2-apiss
```

Details and log capture: [`run-local.md`](run-local.md#verify-replay-manifest).
