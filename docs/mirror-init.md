# mirror-init (Block 1)

Operator workflow for **`yarn mirror-init`**. Pipeline blocks and CI:
[`plan-workflow.md`](plan-workflow.md). Commands and secrets: [`usage.md`](usage.md).
New mirror: [`add-mirror.md`](add-mirror.md).

Code: `src/mirror-init/`.

## Command

```bash
yarn mirror-init [--repo <name>] [--skip-fetch] [--push]
```

| Flag | Purpose |
|------|---------|
| `--repo <name>` | Single mirror from `config/sync.json` `Mirrors.Repos` |
| `--skip-fetch` | Skip `git fetch origin` during ensure-init |
| `--push` | Same as plain init, then push tooling branches, dispatch Block 3 per mirror, run **`yarn mirror-poll`** |

Examples:

```bash
yarn mirror-init --repo glibc
yarn mirror-init --repo glibc --push
yarn mirror-init --push
```

Requires `gh auth login` when using `--push`.

## What Block 1 installs

| Target | Branch | Files |
|--------|--------|-------|
| Each `msys2-apiss/*` mirror repo | **`msys2-apiss-mirror-sync`** | `.github/workflows/mirror-sync.yml`, `.github/mirror-sync.json`, toolings |
| Destination repo **`msys2-apiss/msys2-apiss`** | **`msys2-apiss-mirror-merge`** | `.github/workflows/mirror-merge.yml` |
| Tooling repo `msys2-apiss/msys2-apiss-sync` | `main` | TypeScript, config, templates; Block 2 [`mirror-poll.yml`](../.github/workflows/mirror-poll.yml) |

**Content branch** (`master` or `Branches[].Mirror` in `config/mirror-sync/<repo>.json`):
pure upstream mirror; **no workflow files**. Local working copy: `.work/mirrors/<repo>/`.

Both tooling install branches use [Tooling branch layout](#tooling-branch-layout)
(Block 1 creates or repairs automatically).

Templates: [`config/mirror-template/mirror-sync.yml`](../config/mirror-template/mirror-sync.yml),
`config/mirror-sync/<repo>.json`. Block 1 copies into each mirror when they differ.

## Tooling branch layout

Each install branch (**`msys2-apiss-mirror-sync`**, **`msys2-apiss-mirror-merge`**) is a
**single commit** whose parent is the **first commit** of that repo's default branch.
**`yarn mirror-init`** creates or repairs this layout on every run. Code:
`src/mirror-init/` (`firstCommitOfBranch`, `initializeDestinationRepository`,
`initializeNamedMirrorRepository`, `bootstrapMirrorFromUpstreamRoot`,
`repairSyncBranchLayout`).

| Repo | Tooling branch | Default branch | Tooling under `.github/` |
|------|----------------|----------------|--------------------------|
| Each `msys2-apiss/*` mirror | **`msys2-apiss-mirror-sync`** | content branch (`master` or config) | `workflows/mirror-sync.yml`, `mirror-sync.json`, `toolings/` |
| **`msys2-apiss/msys2-apiss`** (destination) | **`msys2-apiss-mirror-merge`** | **`main`** (`Destination.DefaultBranch` in [`config/sync.json`](../config/sync.json); GitHub default branch) | `workflows/mirror-merge.yml` only |

Replay branches (`upstream`, `upstream-ports`, `upstream-ports-mingw`) and mirror
content branches stay workflow-free. **`ReplayTip`** (`upstream`) is the Block 4 replay
branch; it is not the default branch for **`msys2-apiss-mirror-merge`** (**`main`**; see table).

### Steps

1. **Resolve the default branch** for that repo (table above).
2. **Fetch** commit graph to the root (no blob data):
   - Existing **`origin`**: `git fetch --filter=blob:none origin refs/heads/<default-branch>:refs/remotes/origin/<default-branch>`.
   - **Empty mirror `origin`**: `git init`, add `upstream` remote, same fetch pattern
     against `upstream` (see manual example below).
3. **First commit**: `git rev-list --max-parents=0 origin/<default-branch>` (or
   `upstream/<branch>` during empty-origin bootstrap).
4. **Checkout root**: `git checkout -B <tooling-branch> <root>`. Do not use
   `git checkout --orphan`.
5. **Apply tooling**: copy templates from this repo onto that tree.
6. **Commit once**: one commit on the tooling branch; **parent must be `<root>`**.

```text
R = first commit of default branch
R <- T = tooling branch tip (.github only)
R <- ... <- default branch tip
```

### Manual equivalent (one tooling branch)

```bash
DEFAULT=master   # mirror content branch; or main on msys2-apiss/msys2-apiss (see table)
TOOLING=msys2-apiss-mirror-sync   # or msys2-apiss-mirror-merge
REMOTE=origin    # upstream when bootstrapping an empty mirror origin

# Commit graph only (no blobs); enough to resolve the first commit
git fetch --filter=blob:none "$REMOTE" "refs/heads/$DEFAULT:refs/remotes/$REMOTE/$DEFAULT"
ROOT=$(git rev-list --max-parents=0 "$REMOTE/$DEFAULT")
git checkout -B "$TOOLING" "$ROOT"
# copy template files under .github/ (see config/mirror-template/)
git add .github/
git commit -m "Install tooling from msys2-apiss-sync template"
git push -u origin "$TOOLING"
```

After local edits on a tooling branch, re-run **`yarn mirror-init`** (with or without
**`--push`**) to repair layout and re-apply templates when they differ.

## Workflow

Every **`yarn mirror-init`** run uses the same steps for each target repo. **`--push`**
only adds GitHub push and CI triggers at the end.

### Targets (in order)

| Target | Local path | Tooling branch | Default branch | Tooling files |
|--------|------------|----------------|----------------|---------------|
| **`msys2-apiss/msys2-apiss`** (destination) | `.work/mirror-merge-ci/` | **`msys2-apiss-mirror-merge`** | **`main`** (`Destination.DefaultBranch`) | `workflows/mirror-merge.yml` |
| Each `msys2-apiss/*` mirror | `.work/mirrors/<repo>/` | **`msys2-apiss-mirror-sync`** | content branch (`master` or config) | `workflows/mirror-sync.yml`, `mirror-sync.json`, `toolings/` |

Destination and mirrors share the same [Tooling branch layout](#tooling-branch-layout)
(fetch default-branch graph, checkout root, apply templates, single tooling commit).
Only the branch name, local path, and template files differ.

### Per target (always)

1. Ensure local working copy (clone origin, or upstream bootstrap when mirror origin is empty).
2. Fetch origin (unless `--skip-fetch`).
3. Detect/repair state (none, broken, incomplete, complete) and apply templates when they differ.
4. Log tooling-branch tip.

Mirror repos only: empty GitHub origin uses upstream bootstrap per [Tooling branch layout](#tooling-branch-layout).
Block 3 (mirror-sync) updates the mirror content branch on GitHub; Block 1 does not push it.

### Local working copy states (mirrors)

| State | Detection | Action |
|-------|-----------|--------|
| **None** | No `.work/mirrors/<repo>/` | Clone origin if non-empty; else upstream bootstrap |
| **Broken** | Invalid git repo (no HEAD, bare clone) | Remove and re-init from **None** |
| **Incomplete** | Missing tooling branch or invalid layout | Fetch; repair layout; apply templates |
| **Complete** | Content + valid tooling branch | Fetch; apply templates when differ |

Origin on GitHub is checked separately (`mirrorOriginHasContent`): empty origin uses
upstream bootstrap; non-empty origin uses clone or fetch.

**Reuse local clone:** do not delete `.work/mirrors/<repo>` when only the tooling branch is
missing; bootstrap in place. Complete clones are reused without recloning.

**Large mirrors (gcc):** `PushViaSsh` in mirror config; ensure-init reuses complete clones
when possible.

### With `--push` (after all targets initialized)

**Destination:** push **`msys2-apiss-mirror-merge`** to origin, then dispatch Block 4 with
`gh workflow run mirror-merge.yml` on ref **`msys2-apiss-mirror-merge`** (same bootstrap
pattern as mirror-sync when the workflow is not registered yet).

**Each mirror in scope** (one with **`--repo`**, or every entry in `Mirrors.Repos` without it):

- Ensure GitHub repo exists (`gh repo create` when origin is empty).
- Push **`msys2-apiss-mirror-sync`** to `origin`.
- **Dispatch Block 3** (always after push; no tip comparison). When `mirror-sync.yml` is not
  registered yet, briefly set default branch to **`msys2-apiss-mirror-sync`**, dispatch, then
  restore default to the content branch:

  ```bash
  gh workflow run mirror-sync.yml \
    --repo msys2-apiss/<repo> \
    --ref msys2-apiss-mirror-sync \
    -f event_type=workflow_dispatch_mirror_sync
  ```

- Skip dispatch only when a `mirror-sync` run is already in progress on that repo.
- Does **not** wait for the run to finish.

**Mirror-poll (once, after all mirrors):** run Block 2 **`yarn mirror-poll`** over all
`Mirrors.Repos` entries. Poll compares upstream vs mirror tips and dispatches Block 3 again
on repos still behind:

```bash
yarn mirror-poll
```

- Skip dispatch when tips already match or a `mirror-sync` run is already in progress.
- Does **not** wait for Block 3 runs to finish.

Per-mirror dispatch and mirror-poll dispatch are **both** required in **`--push`**; poll does
not replace the per-mirror dispatch.

Without **`--push`**: no GitHub push, no Block 3 dispatch. Use `yarn mirror-poll` or CI cron later.

## Manual equivalent (one repo)

Per mirror after push ([Tooling branch layout](#tooling-branch-layout) on **`msys2-apiss-mirror-sync`**):

```bash
gh workflow run mirror-sync.yml --repo msys2-apiss/<repo> --ref msys2-apiss-mirror-sync \
  -f event_type=workflow_dispatch_mirror_sync
```

If dispatch fails because the workflow is not registered yet, PATCH default branch to
`msys2-apiss-mirror-sync`, retry dispatch, then PATCH back to the content branch (`master`
or configured `Branches[].Mirror`).

## Related

- [Tooling branch layout](#tooling-branch-layout) (canonical)
- [`plan-workflow.md`](plan-workflow.md) -- Blocks 2-4 and pipeline map
- [`plan-sync-merge.md`](plan-sync-merge.md) -- Block 4 mirror-merge
- [`add-mirror.md`](add-mirror.md) -- add a new mirror
- [`usage.md`](usage.md) -- secrets and run commands
