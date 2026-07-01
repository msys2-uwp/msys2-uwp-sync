# Agent guide: msys2-apiss-sync

This repository builds cross-platform TypeScript tooling to replay upstream
MSYS2 package history into `msys2-apiss/msys2-apiss`.

## Read first

- [docs/plan-workflow.md](docs/plan-workflow.md) - center design (target workflow by block)
- [docs/PLAN.md](docs/PLAN.md) - index and shared replay foundation
- [docs/mirror-merge.md](docs/mirror-merge.md) - Block 4 (`yarn mirror-merge`)
- [docs/mirror-init.md](docs/mirror-init.md) - Block 1 (`yarn mirror-init`; [Tooling branch layout](docs/mirror-init.md#tooling-branch-layout))
- [docs/mirror-poll.md](docs/mirror-poll.md) - Block 2 (`yarn mirror-poll`)
- [.cursor/rules/](.cursor/rules/) - coding and workflow conventions

## Key facts

- **Sources**: mirror `msys2-apiss/*`, commit footer `UpstreamRepo` `msys2/MSYS2-packages` -> `ports/`, `msys2/MINGW-packages` -> `ports-mingw/`
- **Destination**: `msys2-apiss/msys2-apiss`, branch `upstream`
- **Base commit**: `6fc20894663468a04dd4986a8b1c15a9d5ae8649` (parent of first replayed commit)
- **Strategy**: deterministic date-ordered replay; same SHAs on every rebuild at same pins
- **Triggers**: Block 2 mirror-poll (~hourly cron, push to `main`); Block 3 -> Block 4 `workflow_dispatch` after mirrors advance. Plan ~1 h latency.
- **Runtime**: Node.js 26+; TypeScript runs directly with Node type stripping
- **State**: destination branches (`upstream`, `upstream-ports`, `upstream-ports-mingw`) hold replay progress and resume cursors; no checkpoint file
- **Tooling branches**: Block 1 install branches **`msys2-apiss-mirror-sync`** and **`msys2-apiss-mirror-merge`** follow [Tooling branch layout](docs/mirror-init.md#tooling-branch-layout)

## Do not

- Ship untestable instructions (dot-source-only recipes); use runnable scripts -- see `.cursor/rules/human-testable.mdc`, [`docs/usage.md`](docs/usage.md), and [`docs/run-local.md`](docs/run-local.md)
- Use Cursor internal plans (`~/.cursor/plans/`) or untracked shadow plan files; edit [`docs/PLAN.md`](docs/PLAN.md) only (see `.cursor/rules/planning-docs.mdc`)
- Use `git merge` of entire upstream repos into destination (use replay instead)
- Add platform-specific APIs in shared sync code
- Commit PATs or tokens; use GitHub Actions secrets only
- Modify upstream `msys2/*` repositories from this project

## Typical tasks

| Task | Location |
|------|----------|
| Sync logic | `src/cli/`, `src/lib/`, `src/types/` |
| Config | `config/mirror-merge.json`, `config/mirror-poll.json` |
| Replay cursors | destination branches `upstream`, `upstream-ports`, `upstream-ports-mingw` |
| CI | `.github/workflows/` |
| Design changes | update `docs/PLAN.md` first |
| Run sync | GitHub and local ops -- [`docs/usage.md`](docs/usage.md) |
| Local testing | `yarn test`, dry-run, pipeline steps -- [`docs/run-local.md`](docs/run-local.md) |
| Add a mirror | [`docs/add-mirror.md`](docs/add-mirror.md) |
