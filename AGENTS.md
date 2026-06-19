# Agent guide: msys2-uwp-sync

This repository builds cross-platform PowerShell tooling to replay upstream
MSYS2 package history into `msys2-uwp/msys2-uwp`.

## Read first

- [docs/PLAN.md](docs/PLAN.md) - architecture, triggers, phases
- [.cursor/rules/](.cursor/rules/) - coding and workflow conventions

## Key facts

- **Sources**: `msys2/MSYS2-packages` -> `ports/`, `msys2/MINGW-packages` -> `ports-mingw/`
- **Destination**: `msys2-uwp/msys2-uwp`, branch `upstream`
- **Base commit**: `6fc20894663468a04dd4986a8b1c15a9d5ae8649` (parent of first replayed commit)
- **Strategy**: deterministic date-ordered replay; same SHAs on every rebuild at same pins
- **Triggers**: mirror push -> `repository_dispatch` (~1-5 min); hourly poll + daily reconciliation as fallback
- **Runtime**: PowerShell 7+ (`pwsh`); scripts must work on Windows, Linux, and macOS
- **State**: `.sync/state.json` tracks cursors and manifest (verify/rebuild)

## Do not

- Ship untestable instructions (dot-source-only recipes); use runnable scripts -- see `.cursor/rules/human-testable.mdc` and [`docs/run-local.md`](docs/run-local.md)
- Use Cursor internal plans (`~/.cursor/plans/`) or untracked shadow plan files; edit [`docs/PLAN.md`](docs/PLAN.md) only (see `.cursor/rules/planning-docs.mdc`)
- Use `git merge` of entire upstream repos into destination (use replay instead)
- Add Windows-only APIs (`Get-WmiObject`, registry, etc.) in shared scripts
- Commit PATs or tokens; use GitHub Actions secrets only
- Modify upstream `msys2/*` repositories from this project

## Typical tasks

| Task | Location |
|------|----------|
| Sync logic | `scripts/Sync-*.ps1`, `scripts/lib/` |
| Config | `config/sync.json` |
| Replay cursors + manifest | `.sync/state.json` (this repo, committed) |
| CI | `.github/workflows/` |
| Design changes | update `docs/PLAN.md` first |
| Run locally | `Fetch-Mirrors.ps1`, `Retrieve-History.ps1`, `Merge-Queue.ps1` -- see [`docs/run-local.md`](docs/run-local.md) |
| Unit tests | `./tests/Test-Sync.ps1` |
