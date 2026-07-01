# mirror-init (Block 1)

`yarn mirror-init` installs Block 3/4 workflow YAML on tooling branches. Pipeline:
[`plan-workflow.md`](plan-workflow.md). Secrets: [`usage.md`](usage.md). New mirror:
[`add-mirror.md`](add-mirror.md). Code: `src/mirror-init/`.

## Command

```bash
yarn mirror-init [--repo <name>] [--skip-fetch] [--push] [--no-poll]
```

| Flag | Purpose |
|------|---------|
| `--repo <name>` | Single mirror from `config/mirror-poll.json` `Repos` |
| `--skip-fetch` | Skip `git fetch origin` during ensure-init |
| `--push` | Push tooling branches, dispatch Block 3/4 on bootstrapped repos, write digest pins |
| `--no-poll` | Skip Block 2 dispatch at end ([`mirror-poll.md`](mirror-poll.md)) |

Requires `gh auth login` unless `--no-poll`.

After changing Block 3/4 TypeScript: `yarn pack-toolings` (writes
`config/mirror-template/toolings/*.mjs`).

Block 1 copies **`mirror-sync.yml`** / **`mirror-merge.yml`** only. Per-mirror JSON,
`config/mirror-merge.json`, and `.mjs` bundles stay on this repo; CI downloads them
from `msys2-apiss-sync` `main`.

## Installs

| Target | Tooling branch | Workflow | Content branch |
|--------|----------------|----------|----------------|
| Each `msys2-apiss/*` mirror | **`msys2-apiss-mirror-sync`** | `mirror-sync.yml` | `master` or `Branches[].Mirror` |
| **`msys2-apiss/msys2-apiss`** | **`msys2-apiss-mirror-merge`** | `mirror-merge.yml` | **`main`** |

Local paths: `.work/mirrors/<repo>/`, `.work/mirror-merge-ci/`. Content branches stay
workflow-free.

## Tooling branch layout

Each tooling branch is **one commit** whose parent is the **first commit** of that
repo's default/content branch (`R <- T`). Block 1 creates or repairs this on every run.

Steps: fetch default-branch graph (`blob:none`) -> resolve root ->
`git checkout -B <tooling-branch> <root>` -> copy templates under `.github/` -> single
commit. Do not use `git checkout --orphan`.

```text
R = first commit of default/content branch
R <- T = tooling branch tip (.github only)
R <- ... <- default branch tip
```

Re-run `yarn mirror-init` after local tooling edits or when templates differ.

## Digest pins

Optional **`config/digest.json`**: repo name -> SHA256 of installed tooling inputs.
Updated only by **`yarn mirror-init --push`** after a successful bootstrap for that repo.
Plain `yarn mirror-init` (no `--push`) never writes this file.

Per-repo hash includes:

| Shared (all repos) | Per mirror | Per destination |
|--------------------|------------|-----------------|
| `config/mirror-template/toolings/*` | `mirror-sync.yml`, `config/mirror-sync/<repo>.json` | `mirror-merge.yml`, `config/mirror-merge.json` |

Not hashed: `config/digest.json`, `config/mirror-poll.json`, other mirrors' JSON.

| Digest state | Behavior |
|--------------|----------|
| Missing/`{}`/stale repo key | Bootstrap that repo (clone, layout, apply; push/dispatch with `--push`) |
| Matches current hash | Skip init, push, and Block 3/4 dispatch for that repo |
| All pinned | Skip all repo work; Block 2 still runs unless `--no-poll` |

Shared template or bundle change re-bootstrap **all** repos on next `--push`. One
mirror JSON change re-bootstraps **that mirror only** (`--repo <name>`).

```bash
yarn pack-toolings              # after TS changes to bundles
yarn mirror-init --push         # shared template/bundle change
yarn mirror-init --push --repo elfutils   # one mirror JSON change
# commit config/digest.json when pins were updated
```

Missing or invalid `config/digest.json`: treated as unpinned. Invalid JSON logs a
warning and treats the map as empty. Code: `src/lib/tooling-digest.ts`.

## Run behavior

**Without `--push`:** ensure local clones, fetch (unless `--skip-fetch`), repair layout,
apply templates when unpinned; no GitHub push or Block 3/4 dispatch. Block 2 at end
unless `--no-poll` ([`mirror-poll.md`](mirror-poll.md)).

**With `--push`:** above, then for each unpinned target in scope:

- **Destination:** push `main` if missing; push **`msys2-apiss-mirror-merge`**; dispatch
  Block 4 on that ref.
- **Mirror:** `gh repo create` if empty origin; push content branch if missing; push
  **`msys2-apiss-mirror-sync`**; dispatch Block 3 on that ref (skip only if a run is
  in progress). May temporarily set default branch to the tooling branch until GitHub
  registers the workflow.

Working copy: **none** (clone or upstream bootstrap), **broken** (re-init),
**incomplete** (repair layout), **complete** (reuse; apply when needed). Empty GitHub
origin uses upstream bootstrap (`UpstreamUrl` in mirror config). `PushViaSsh` mirrors:
reuse complete clones when possible.

## Dispatch 404 (new mirror)

After first `--push`, `gh workflow run mirror-sync.yml` may return **404** until GitHub
indexes the workflow on **`msys2-apiss-mirror-sync`**. Pushing the content branch alone
does not fix this. Wait a few minutes and re-run:

```bash
yarn mirror-init --push --repo <name> --skip-fetch
```

Or dispatch manually once indexed:

```bash
gh workflow run mirror-sync.yml --repo msys2-apiss/<repo> --ref msys2-apiss-mirror-sync \
  -f event_type=workflow_dispatch_mirror_sync
```

Check: `gh api repos/msys2-apiss/<repo>/actions/workflows -q ".total_count"` returns `1`
when ready.

## Related

- [`mirror-poll.md`](mirror-poll.md) -- Block 2 tip compare and dispatch
- [`plan-workflow.md`](plan-workflow.md) -- Blocks 3-4
- [`add-mirror.md`](add-mirror.md) -- register a mirror
- [`usage.md`](usage.md) -- secrets and commands
