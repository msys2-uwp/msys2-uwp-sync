# mirror-merge (Block 4)

`yarn mirror-merge` replays `MSYS2-packages` and `MINGW-packages` mirror history into
`msys2-apiss/msys2-apiss` on `upstream`, `upstream-ports`, and `upstream-ports-mingw`.
Pipeline: [`usage.md`](usage.md). Code: `src/mirror-merge/`. CI workflow:
[`mirror-merge.yml`](../config/mirror-template/mirror-merge.yml) on destination branch
**`msys2-apiss-mirror-merge`** ([Tooling branch layout](mirror-init.md#tooling-branch-layout)).

## Command

```bash
yarn mirror-merge [options]
```

| Flag | Purpose |
|------|---------|
| `--clean` | Reset the three destination sync branches, then full bootstrap replay |
| `--dry-run` | Replay locally; no push |
| `--push` | Push destination branches after replay |
| `--skip-fetch` | Skip mirror and destination fetch |
| `--max-commits <n>` | Limit queue entries (dev throttle; `0` = no limit) |
| `--destination-path <path>` | Existing clone (default `.work/destination/msys2-apiss`) |
| `--log-file <path>` | Log to file (`--log-append`, `--log-to-console` optional) |

Mirrors must exist under `.work/mirrors/` (Block 1 [`mirror-init`](mirror-init.md)).

## Role

Block 4 reads mirror git history, merge-sorts ports + ports-mingw commits by replay rank
(committer date, then author date, source id, SHA), replays each entry onto the destination
tree, and pushes `upstream*`. Upstream author and committer metadata are preserved.
Commit messages use the template in [`config/mirror-merge.json`](../config/mirror-merge.json).

Sources:

| Mirror | Destination subdir | Cursor branch |
|--------|-------------------|---------------|
| `MSYS2-packages` | `ports/` | `upstream-ports` |
| `MINGW-packages` | `ports-mingw/` | `upstream-ports-mingw` |

Replay tip branch: `upstream` (`Destination.ReplayTip`). First replayed commit parents
`Destination.BaseCommit` (`6fc20894663468a04dd4986a8b1c15a9d5ae8649`).

## Triggers

| Trigger | Where |
|---------|--------|
| `yarn mirror-merge` | Local tooling checkout |
| [`mirror-merge.yml`](../config/mirror-template/mirror-merge.yml) | CI on `msys2-apiss/msys2-apiss`, ref **`msys2-apiss-mirror-merge`** |
| Block 3 notify | [`mirror-sync.md`](mirror-sync.md) -- package mirrors with `Notify.Enabled: true` |
| `workflow_dispatch` | Manual (`clean=true` for full reset) |

Block 1 [`yarn mirror-init --push`](mirror-init.md) can dispatch Block 4 on the destination
when bootstrapping tooling.

## Destination branches

No checkpoint file. Resume state lives in branch tips only.

| Branch | Role |
|--------|------|
| `upstream` | Linear replay tip |
| `upstream-ports` | MSYS2-packages cursor (`Source: msys2/MSYS2-packages@<sha>` footer) |
| `upstream-ports-mingw` | MINGW-packages cursor |

| Condition | Behavior |
|-----------|----------|
| All three branches exist | **Incremental** replay from cursors + age gate |
| Any branch missing | **Bootstrap** full replay from history root |
| `--clean` | Reset all three, then bootstrap |

**Resume:** re-run without `--clean`. **Failure:** local clone branch tips are the
resume point until push succeeds.

## Pipeline

1. **Retrieve** -- cursor SHAs from destination; `git log` on each mirror to tip
2. **Merge-sort** -- deterministic merge of ports + ports-mingw queues
3. **Replay** -- apply each upstream commit; update refs; push unless `--dry-run`

Incremental runs apply `Replay.MinReplayAgeMinutes` (default 5) on committer date.
Destination `upstream` stays linear (one parent per commit); upstream merge topology
is flattened to file deltas under `ports/` and `ports-mingw/`.

## Fork-safe cursors

Cursor branches advance only at **mainline** queue positions (first-parent spine from
mirror tip). Side-branch commits replay onto `upstream` but do not move cursor branches
until a later mainline entry.

Code: `src/mirror-merge/fork-safe.ts`, `src/mirror-merge/queue.ts`
(`testSyncCursorBranchUpdateSafe`).

## Config

[`config/mirror-merge.json`](../config/mirror-merge.json) (read-only at runtime):

| Key | Purpose |
|-----|---------|
| `Destination.*` | Target repo, `BaseCommit`, `ReplayTip` |
| `Sources[]` | Mirror repo, `DestSubdir`, `CursorBranch`, message template |
| `Replay.*` | Age gate, empty-tree skip, line endings |

GitHub Actions secrets: [`mirror-sync.md`](mirror-sync.md#ci-secrets),
[`usage.md`](usage.md#setup-sync_dispatch_token).

## Operator flows

**GitHub (usual path):** Block 2/3 advance mirrors -> Block 4 CI runs automatically
when `Notify.Enabled` is true.

```bash
gh workflow run mirror-merge.yml --repo msys2-apiss/msys2-apiss --ref msys2-apiss-mirror-merge
gh run list --repo msys2-apiss/msys2-apiss --workflow mirror-merge.yml --ref msys2-apiss-mirror-merge --limit 5
```

**Local full run:**

```bash
yarn mirror-merge --destination-path .work/destination/msys2-apiss
```

**Skip fetch** (mirrors and destination already current):

```bash
yarn mirror-merge --skip-fetch --destination-path .work/destination/msys2-apiss
```

**Resume after interrupt:**

```bash
yarn mirror-merge --skip-fetch --destination-path .work/destination/msys2-apiss
```

**Reset and replay from root:**

```bash
yarn mirror-merge --clean --destination-path .work/destination/msys2-apiss
# CI equivalent:
gh workflow run mirror-merge.yml --repo msys2-apiss/msys2-apiss --ref msys2-apiss-mirror-merge -f clean=true
```

**Verify no drift** (dry-run, no push):

```bash
yarn mirror-merge --dry-run --skip-fetch --destination-path .work/destination/msys2-apiss
```

More local testing: [`usage.md`](usage.md#dry-run-and-verify-block-4).

## Related

- [`mirror-sync.md`](mirror-sync.md) -- Block 3 upstream refresh before replay
- [`mirror-poll.md`](mirror-poll.md) -- Block 2 tip compare
- [`mirror-init.md`](mirror-init.md) -- installs `mirror-merge.yml` tooling branch
- [`usage.md`](usage.md) -- pipeline map and secrets
