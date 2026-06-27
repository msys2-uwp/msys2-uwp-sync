# MSYS2-APISS mirror pipeline architecture

**Center design** for the MSYS2-APISS sync pipeline. Edit this file first when changing
repos, blocks, CI boundaries, or operator flows.

**Block IDs:** 0 config -> 1 **mirror-init** -> 2 **mirror-poll** -> 3 **mirror-sync** -> 4 **mirror-merge**.

| Block | Name | CLI / workflow |
|-------|------|----------------|
| **1** | mirror-init | `yarn mirror-init` (`fetch-mirrors`) |
| **2** | mirror-poll | `yarn mirror-poll`, `mirror-poll.yml` |
| **3** | mirror-sync | `mirror-sync.yml` on mirror branch **`msys2-apiss-mirror-sync`** ([Tooling branch layout](mirror-init.md#tooling-branch-layout)) |
| **4** | mirror-merge | `yarn mirror-merge`, `mirror-merge.yml` on branch **`msys2-apiss-mirror-merge`** ([Tooling branch layout](mirror-init.md#tooling-branch-layout)) |

---

## Detail docs

| Area | Detail doc |
|------|------------|
| Block 1: mirror-init | [`mirror-init.md`](mirror-init.md) ([Tooling branch layout](mirror-init.md#tooling-branch-layout)) |
| Blocks 2-3: mirror-poll, mirror-sync | This file (sections below) |
| Block 4: mirror-merge replay algorithm and destination branches | [`plan-sync-merge.md`](plan-sync-merge.md), [`PLAN.md`](PLAN.md) |
| Operator commands and local testing | [`usage.md`](usage.md), [`run-local.md`](run-local.md) |

---

## Principles

| Principle | Detail |
|-----------|--------|
| **Entry point** | **Local checkout** of [`msys2-apiss/msys2-apiss-sync`](https://github.com/msys2-apiss/msys2-apiss-sync) -- all operator commands run here |
| External upstream | `UpstreamUrl` in `config/mirror-sync/*.json` only; not a workflow actor |
| Block 1 init | From **msys2-apiss/msys2-apiss-sync** code/templates: **initialize Block 3** on each `msys2-apiss/*` mirror (branch **`msys2-apiss-mirror-sync`**) and **Block 4 CI** on destination branch **`msys2-apiss-mirror-merge`** on **`msys2-apiss/msys2-apiss`**. Same [Tooling branch layout](mirror-init.md#tooling-branch-layout) for both. Every `yarn mirror-init` run deploys/repairs these; **`yarn mirror-init --push`** pushes to the **msys2-apiss** org, dispatches Block 3 on each pushed mirror, then dispatches Block 2 **`mirror-poll.yml`** on GitHub |
| Block 2 poll | Compare tips; **trigger Block 3** when behind. Runs via **`yarn mirror-poll`** or **`mirror-poll.yml`** cron |
| Block 3 mirror-sync | On each **`msys2-apiss/*` mirror repo**; **only configured mirrors** (e.g. `MSYS2-packages`, `MINGW-packages` with `Notify.Enabled`) dispatch Block 4 CI |
| Block 4 mirror-merge | `yarn mirror-merge` locally **or** [`mirror-merge.yml`](../config/mirror-template/mirror-merge.yml) CI; replay + `git push` to `msys2-apiss/msys2-apiss` on `upstream*` |
| Git surface | TypeScript wraps `git` subprocesses only |

---

## msys2-apiss org (Block 1 scope)

All Block 1 init code lives in **`msys2-apiss/msys2-apiss-sync`**. Block 1 prepares the
**msys2-apiss** GitHub org for Blocks 3-4:

| GitHub repo | Block 1 role |
|-------------|--------------|
| **`msys2-apiss/msys2-apiss-sync`** (tooling) | Source of templates + TypeScript; Block 2 [`mirror-poll.yml`](../.github/workflows/mirror-poll.yml) on **`main`** |
| **`msys2-apiss/*`** (mirror repos) | Install Block 3 [`mirror-sync.yml`](../config/mirror-template/mirror-sync.yml) + `mirror-sync.json` on branch **`msys2-apiss-mirror-sync`** ([Tooling branch layout](mirror-init.md#tooling-branch-layout)); bootstrap `.work/mirrors/<repo>/` locally |
| **`msys2-apiss/msys2-apiss`** (destination) | Install Block 4 [`mirror-merge.yml`](../config/mirror-template/mirror-merge.yml) on branch **`msys2-apiss-mirror-merge`** ([Tooling branch layout](mirror-init.md#tooling-branch-layout)) |

With **`--push`**, Block 1 pushes mirror workflow branches to **`msys2-apiss/*`**
and the Block 4 workflow branch to **`msys2-apiss/msys2-apiss`**, then dispatches Block 3 on each pushed mirror repo.

---

## Repo map

| Repo | Stores code? | GitHub workflow? | Receives |
|------|--------------|------------------|----------|
| `msys2-apiss-sync` (tooling repo) | Yes (TypeScript + templates) | Block 2: `mirror-poll.yml` on `main` | Block 3 `workflow_dispatch_mirror_merge` (package mirrors) |
| `msys2-apiss/*` (mirror repos) | No (content only) | Block 3: `mirror-sync.yml` on mirror branch `msys2-apiss-mirror-sync` (installed by Block 1) | Block 2 `workflow_dispatch_mirror_sync`; updates mirror `master` |
| `msys2-apiss/msys2-apiss` (destination) | No (replay output only) | Block 4: `mirror-merge.yml` on branch **`msys2-apiss-mirror-merge`** (installed by Block 1; [Tooling branch layout](mirror-init.md#tooling-branch-layout)) | `workflow_dispatch` from Block 3 notify or manual; Block 4 pushes `upstream*` |
| `msys2/*`, SourceForge, etc. | N/A | N/A | Block 2 reads upstream tip via `ls-remote` |

---

## Target workflow (by block)

| Block | Repo | Workflow | Command / runs | Git / I/O | Output |
|-------|------|----------|----------------|-----------|--------|
| **0** | External (`msys2/*`, SourceForge, ...) | None | Config only | `UpstreamUrl` in `config/mirror-sync/*.json` | -- |
| **1** | `msys2-apiss/msys2-apiss-sync` (**local checkout**) | None | `yarn mirror-init` `[--push] [--repo <name>]` | From tooling repo code: initialize Block 3 on **`msys2-apiss/*`** + Block 4 CI on **`msys2-apiss/msys2-apiss`** ([Tooling branch layout](mirror-init.md#tooling-branch-layout)); with **`--push`**: push to msys2-apiss org, dispatch Block 3 per pushed mirror, then dispatch Block 2 **`mirror-poll.yml`** | Block 3/4 workflows deployed; **`--push`**: per-mirror Block 3 + Block 2 poll dispatch |
| **2** | `msys2-apiss/msys2-apiss-sync` (local or CI) | [`mirror-poll.yml`](../.github/workflows/mirror-poll.yml) on `main` (cron) | `yarn mirror-poll`; CI cron | Poll only; `workflow_dispatch_mirror_sync` Block 3 when behind | Block 3 triggered |
| **3** | **`msys2-apiss/*` mirror repos** | [`mirror-sync.yml`](../config/mirror-template/mirror-sync.yml) on mirror branch `msys2-apiss-mirror-sync` | Block 2 dispatch | Fetch upstream; push mirror `master` | Mirror updated; **if `Notify.Enabled`**: dispatch Block 4 CI (e.g. `MSYS2-packages`, `MINGW-packages`) |
| **4** | Destination `msys2-apiss/msys2-apiss` (CI) + tooling checkout (local) | [`mirror-merge.yml`](../config/mirror-template/mirror-merge.yml) on branch **`msys2-apiss-mirror-merge`** | `yarn mirror-merge` or CI (`workflow_dispatch_mirror_merge` from Block 3, cron, manual) | Retrieve -> merge-sort -> replay -> push `upstream*` on destination | Destination replay complete |

```mermaid
flowchart TB
  B0["Block 0\nupstream config"]
  B1["Block 1\nmirror-init"]
  B2["Block 2\nmirror-poll"]
  B3["Block 3\nmirror-sync"]
  B4["Block 4\nmirror-merge"]

  B0 -->|UpstreamUrl| B1
  B1 -->|--push| B3
  B2 -->|workflow_dispatch_mirror_sync| B3
  B3 -->|workflow_dispatch_mirror_merge\nNotify.Enabled only| B4

  B0 -.->|tip compare| B2
  B0 -.->|git fetch| B3
```

Every **`yarn mirror-init`** initializes Block 3 and Block 4 workflow files from
**msys2-apiss-sync** code (local `.work/mirrors/` + [Tooling branch layout](mirror-init.md#tooling-branch-layout)). **`yarn mirror-init --push`**
additionally pushes to **`msys2-apiss/*`** and tooling repo, then dispatches Block 3 on pushed repos.

Block 2 also runs standalone (`yarn mirror-poll`, `mirror-poll.yml` cron) without Block 1.

Block 3 dispatches Block 4 **only when configured** in `.github/mirror-sync.json`
(`Notify.Enabled: true` in `config/mirror-sync/<repo>.json`, e.g. `MSYS2-packages`,
`MINGW-packages`). Mirror-only repos (`mingw-w64`, `glibc`, etc.) set
`Notify.Enabled: false` and do not dispatch Block 4.

**CI note:** Block 2 cron runs on tooling repo `main`. Block 4 CI workflow file lives on
destination repo **`msys2-apiss/msys2-apiss`**, branch **`msys2-apiss-mirror-merge`**
(installed by Block 1). Same [Tooling branch layout](mirror-init.md#tooling-branch-layout)
as Block 3 on mirror branch **`msys2-apiss-mirror-sync`**.

## Operator flows

All flows start from a **local checkout** of `msys2-apiss/msys2-apiss-sync` unless noted.

| Scenario | Blocks 1-3 | Block 4 |
|----------|----------|---------|
| Local mirror init only | Block 1 (`yarn mirror-init`) -- initializes Block 3 + Block 4 files locally | -- |
| Full pipeline (local) | Block 1 **`--push`** -> Block 3 -> Block 4 (if `Notify.Enabled`) | or `yarn mirror-merge --skip-fetch` after mirrors advance |
| Full mirror refresh (CI) | Block 2 cron -> Block 3 -> dispatch (package mirrors only) | `mirror-merge.yml` on **`msys2-apiss/msys2-apiss`** |
| Poll only | Block 2 -> Block 3 | `yarn mirror-merge --skip-fetch` or wait for dispatch |
| Reset destination replay | -- | `yarn mirror-merge --clean` or `workflow_dispatch_mirror_sync clean=true` |

---

## Block 2: mirror-poll

**Role:** compare upstream vs mirror tips; dispatch Block 3 **only when behind**.

| Trigger | Where |
|---------|--------|
| `yarn mirror-poll [--repo <name>]` | Local checkout |
| [`mirror-poll.yml`](../.github/workflows/mirror-poll.yml) cron / push to `main` | CI on tooling repo |

Code: `src/mirror-poll/`. Uses `gh` and `mirrorRepoPollStatus` (GitHub API tip
compare when `UpstreamUrl` is GitHub; non-GitHub upstream logs **tips compare invalid**
and skips dispatch). When SHAs differ, dispatch
`workflow_dispatch_mirror_sync` on ref **`msys2-apiss-mirror-sync`**.

CI: `GH_TOKEN` from `secrets.SYNC_DISPATCH_TOKEN` on `msys2-apiss/msys2-apiss-sync`
(fallback `github.token`). See [`usage.md`](usage.md).

Block 2 also runs at end of Block 1 **`--push`** (after per-mirror Block 3 dispatch, GitHub dispatch of **`mirror-poll.yml`**).

Keep: in-progress run skip; workflow registration bootstrap on 404; default-branch dance
for first dispatch when needed.

---

## Block 3: mirror-sync

Runs on each **`msys2-apiss/*` mirror repo**, mirror branch **`msys2-apiss-mirror-sync`**
([Tooling branch layout](mirror-init.md#tooling-branch-layout)).
Block 1 installs the workflow; Block 1 **`--push`** or Block 2 poll triggers it.

Template: [`mirror-sync.yml`](../config/mirror-template/mirror-sync.yml). Code:
`src/mirror-sync/`.

For each `Branches[]` entry in mirror config:

1. Ensure `upstream` remote = `UpstreamUrl`
2. `git fetch upstream <UpstreamBranch>`
3. Compare with `origin/<MirrorBranch>`
4. If different: fast-forward push to mirror content branch (SSH when `PushViaSsh`)
5. If `SyncTags`: fetch and push tags

Package mirrors with `Notify.Enabled` dispatch Block 4 via `gh workflow run mirror-merge.yml`
(`SYNC_DISPATCH_TOKEN` on mirror repo). Mirror-only repos use `github.token` when unset.

---

## Mirror list (reference)

| Mirror | Upstream (config) | Feeds mirror-merge |
|--------|-------------------|--------------------|
| `msys2-apiss/MSYS2-packages` | `msys2/MSYS2-packages` | yes (`ports/`) |
| `msys2-apiss/MINGW-packages` | `msys2/MINGW-packages` | yes (`ports-mingw/`) |
| `msys2-apiss/mingw-w64` | SourceForge mingw-w64 | no |
| `msys2-apiss/glibc` | sourceware glibc | no |
| Others in `config/mirror-poll.json` `Repos` | per `config/mirror-sync/*.json` | per `Notify.Enabled` |

---

## Implementation status

| Item | Status |
|------|--------|
| Block 4 algorithm (PLAN phases 1a-1d) | Implemented |
| Block 2 `mirror-poll.yml` | Present |
| Block 1 init Block 3 + Block 4 from tooling code (every run) | Partial (Block 3 yes; Block 4 branch pending) |
| Block 1 `--push` per-mirror dispatch + mirror-poll.yml dispatch after push | Implemented |
| Block 3 dispatch -> Block 4 CI | Present when `Notify.Enabled` (e.g. `MSYS2-packages`, `MINGW-packages`) |
| Update [`usage.md`](usage.md), [`run-local.md`](run-local.md) | Pending |
