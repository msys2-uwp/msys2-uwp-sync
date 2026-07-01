# mirror-poll (Block 2)

`yarn mirror-poll` compares upstream vs mirror tips and dispatches Block 3 when behind.
Pipeline: [`plan-workflow.md`](plan-workflow.md). Secrets: [`usage.md`](usage.md#setup-sync_dispatch_token).
Code: `src/mirror-poll/`. Workflow: [`.github/workflows/mirror-poll.yml`](../.github/workflows/mirror-poll.yml)
on **`msys2-apiss/msys2-apiss-sync`** `main`.

## Command

```bash
yarn mirror-poll [--repo <name>]
```

| Flag | Purpose |
|------|---------|
| `--repo <name>` | Single mirror from `config/mirror-poll.json` `Repos` |

Requires `gh auth login`.

## Role

For each repo in `config/mirror-poll.json` `Repos`:

1. Read upstream tip (`UpstreamUrl` + `Branches[].Upstream` in `config/mirror-sync/<repo>.json`)
2. Read mirror content-branch tip on `msys2-apiss/<repo>` (`Branches[].Mirror`)
3. **Match:** log and skip
4. **Differ:** dispatch Block 3 `mirror-sync.yml` on ref **`msys2-apiss-mirror-sync`**
5. **Invalid config or missing tip:** log and skip that repo

Upstream tips use GitHub API when `UpstreamUrl` is GitHub; otherwise `git ls-remote`.
Mirror tips use `gh` on the content branch (not the tooling branch).

Block 3 then fast-forwards the mirror content branch. Package mirrors with
`Notify.Enabled: true` may dispatch Block 4; mirror-only repos stop after Block 3.

## Triggers

| Trigger | Where |
|---------|--------|
| `yarn mirror-poll` | Local checkout |
| [`mirror-poll.yml`](../.github/workflows/mirror-poll.yml) cron (~hourly) | CI on tooling repo `main` |
| Push to tooling repo `main` | Same workflow |
| `workflow_dispatch` on `mirror-poll.yml` | Manual |
| End of `yarn mirror-init` | Dispatches `mirror-poll.yml` unless [`--no-poll`](mirror-init.md#command) |

`yarn mirror-init --push` dispatches Block 3 directly on bootstrapped repos (no tip
compare). Block 2 still runs at the end of mirror-init unless `--no-poll`.

## Config

[`config/mirror-poll.json`](../config/mirror-poll.json):

| Key | Purpose |
|-----|---------|
| `Owner` | GitHub org (`msys2-apiss`) |
| `Destination.*` | Destination repo for Block 1 init (not polled by Block 2) |
| `Repos` | Mirror repo names to poll |

Per-mirror upstream URL, branches, notify, and SSH push: `config/mirror-sync/<repo>.json`.

## CI secrets

[`mirror-poll.yml`](../.github/workflows/mirror-poll.yml) sets `GH_TOKEN` from
`secrets.SYNC_DISPATCH_TOKEN` (fallback `github.token`). The PAT must dispatch
`mirror-sync.yml` on mirror repos. Setup: [`usage.md`](usage.md#setup-sync_dispatch_token).

Dispatch uses input `workflow_dispatch_mirror_sync` on ref **`msys2-apiss-mirror-sync`**
([Tooling branch layout](mirror-init.md#tooling-branch-layout)).

## Operator flows

**Routine refresh (CI):** cron on `main` polls all `Repos`; Block 3 runs only when behind.

**Local poll:**

```bash
yarn mirror-poll
yarn mirror-poll --repo gcc
```

**After adding a mirror:** register in `config/mirror-poll.json`, run Block 1
[`yarn mirror-init --push --repo <name>`](mirror-init.md), then Block 2 picks up the
new repo on the next cron or mirror-init end dispatch.

**Manual Block 3** (bypass poll; workflows on tooling branch, not content branch):

```bash
gh workflow run mirror-sync.yml --repo msys2-apiss/<repo> --ref msys2-apiss-mirror-sync \
  -f event_type=workflow_dispatch_mirror_sync
```

**Manual Block 2:**

```bash
gh workflow run mirror-poll.yml --repo msys2-apiss/msys2-apiss-sync --ref main
```

## Mirror list (reference)

| Mirror | Upstream (config) | Feeds Block 4 |
|--------|-------------------|---------------|
| `MSYS2-packages` | `msys2/MSYS2-packages` | yes (`ports/`) |
| `MINGW-packages` | `msys2/MINGW-packages` | yes (`ports-mingw/`) |
| Others in `Repos` | per `config/mirror-sync/*.json` | per `Notify.Enabled` ([`mirror-merge.md`](mirror-merge.md)) |

## Related

- [`mirror-init.md`](mirror-init.md) -- Block 1 tooling install; `--no-poll`
- [`plan-workflow.md`](plan-workflow.md) -- Blocks 3-4
- [`mirror-merge.md`](mirror-merge.md) -- package replay sources and `Notify.Enabled`
- [`add-mirror.md`](add-mirror.md) -- register a repo in `Repos`
- [`usage.md`](usage.md) -- PAT setup and full GitHub operator flow
