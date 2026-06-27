# Apply mirror patches (path mapping)

Apply a single upstream commit (or range) from the local mirror clones into a
destination checkout, with paths rewritten into `ports/` or `ports-mingw/`.

Full sync replay: [`usage.md`](usage.md). Design: [`PLAN.md`](PLAN.md).

## Shell: bash vs PowerShell

Examples below use **one line** so they work in bash and PowerShell.

PowerShell does **not** treat `\` at end of line as continuation. If you split
a command across lines in PowerShell, use the backtick (`` ` ``), not `\`:

```powershell
# Wrong in PowerShell (runs only the first line; rest are parse errors):
yarn apply-mirror-patch --skip-fetch \
  --source ports

# PowerShell line continuation (backtick at end of line):
yarn apply-mirror-patch --skip-fetch `
  --source ports `
  --range c266c35b..28bfcc09 `
  --branch apply-ports-test `
  --destination-path .work/destination/msys2-apiss `
  --create-commit
```

Or use a **single line** (recommended on Windows):

```powershell
yarn apply-mirror-patch --skip-fetch --source ports --range c266c35b9f59efb8ff387b81d1013d29e09d2939..28bfcc090b6f5ee082fe3de3e7234e8fd1a13de4 --branch apply-ports-test --destination-path .work/destination/msys2-apiss --create-commit
```

Quote the range if PowerShell mis-parses `..`:

```powershell
yarn apply-mirror-patch --skip-fetch --source ports --range "c266c35b..28bfcc09" --branch apply-ports-test --destination-path .work/destination/msys2-apiss --create-commit
```

Git `-C` works the same in PowerShell:

```powershell
git -C .work/mirrors/MSYS2-packages rev-parse origin/master
```

## Path mapping

`--source ports` is not a separate repo named "ports". It selects a mirror clone
and the destination subfolder where paths are rewritten.

| `--source` | GitHub mirror | Local mirror path | Upstream | Destination subdir |
|------------|---------------|-------------------|----------|----------------------|
| `ports` | `msys2-apiss/MSYS2-packages` | `.work/mirrors/MSYS2-packages` | `msys2/MSYS2-packages` | `ports/` |
| `ports-mingw` | `msys2-apiss/MINGW-packages` | `.work/mirrors/MINGW-packages` | `msys2/MINGW-packages` | `ports-mingw/` |

Example path rewrite:

| Mirror | Upstream path | Destination path |
|--------|---------------|------------------|
| `MSYS2-packages` | `cmake/PKGBUILD` | `ports/cmake/PKGBUILD` |
| `MINGW-packages` | `mingw-w64-foo/PKGBUILD` | `ports-mingw/mingw-w64-foo/PKGBUILD` |

## Fetch mirrors

Clone or update both mirror repos before applying patches (working copies use
**`msys2-apiss-mirror-sync`** layout; see [Tooling branch layout](mirror-init.md#tooling-branch-layout):

```bash
yarn fetch-mirrors
```

This creates or refreshes working-copy clones under `.work/mirrors/`:

- `.work/mirrors/MSYS2-packages` from `https://github.com/msys2-apiss/MSYS2-packages.git`
- `.work/mirrors/MINGW-packages` from `https://github.com/msys2-apiss/MINGW-packages.git`

Mirror-only repos use the same layout when listed in `config/mirror-poll.json` (see
[`add-mirror.md`](add-mirror.md)).

On first run each mirror is cloned with `git clone --mirror`. Later runs run
`git fetch --prune origin`. Output includes each mirror path and `master` tip
SHA, for example:

```text
[sync] Fetching mirrors
[sync] Ports mirror: .work/mirrors/MSYS2-packages (tip master = aac3de01)
[sync] PortsMingw mirror: .work/mirrors/MINGW-packages (tip master = ...)
[sync] Done.
```

Skip network fetch when mirrors are already present and up to date:

```bash
yarn fetch-mirrors --skip-fetch
```

`apply-mirror-patch` uses the same mirror initialization. If a mirror is missing,
omit `--skip-fetch` on that command and it will clone automatically; otherwise
run `yarn fetch-mirrors` first and pass `--skip-fetch` to patch commands.

Check a mirror tip:

```bash
git -C .work/mirrors/MSYS2-packages rev-parse origin/master
git -C .work/mirrors/MINGW-packages rev-parse origin/master
```

## Command

```bash
yarn apply-mirror-patch --source <ports|ports-mingw> --commit <sha> --branch <new-branch> --destination-path <path>
```

`--source` also accepts `MSYS2-packages`, `MINGW-packages`, `Ports`, and
`PortsMingw`.

## Branch: keep `upstream` intact

When applying to a destination clone, you **must** pass `--branch` with a **new**
branch name. The tool checks out that branch from the current `upstream` tip
(or `--base-branch`) and applies patches there. The `upstream` branch ref is
not moved.

```bash
yarn apply-mirror-patch --skip-fetch --source ports --commit aac3de01 --branch apply-ports-test --destination-path .work/destination/msys2-apiss --create-commit
```

| Flag | Purpose |
|------|---------|
| `--branch` | New local branch to create and check out (required for index apply) |
| `--base-branch` | Branch to fork from (default: `upstream` from `config/mirror-merge.json`) |

Rules:

- `--branch` must not equal `--base-branch` (default `upstream`).
- The new branch must not already exist locally (delete it first to retry).
- `--print-patch` and `--list-files` do not need `--branch` (no destination checkout).

## Stage one commit

Same index logic as `yarn mirror-merge` (no destination commit unless
`--create-commit`):

```bash
yarn apply-mirror-patch --skip-fetch --source ports --commit aac3de01 --branch apply-ports-test --destination-path .work/destination/msys2-apiss
```

MINGW mirror:

```bash
yarn apply-mirror-patch --skip-fetch --source ports-mingw --commit <sha> --branch apply-mingw-test --destination-path .work/destination/msys2-apiss
```

Without `--create-commit`, changes are staged only. Inspect with:

```bash
git -C .work/destination/msys2-apiss diff --cached
```

## Print a remapped unified diff

For manual `git apply` in the destination repo:

```bash
yarn apply-mirror-patch --skip-fetch --source ports --commit <sha> --print-patch > mapped.patch
```

Write to a file via `--output` (requires `--print-patch`):

```bash
yarn apply-mirror-patch --skip-fetch --source ports --commit <sha> --print-patch --output mapped.patch
```

## List mapped paths only

```bash
yarn apply-mirror-patch --skip-fetch --source ports --commit <sha> --list-files --destination-path .work/destination/msys2-apiss
```

## Choosing commits: `--commit` vs `--range`

Use **either** `--range` **or** `--commit`, never both in one run.

### Repeated `--commit` = explicit list (not a range)

```bash
yarn apply-mirror-patch --skip-fetch --source ports --commit abc123 --commit def456 --branch apply-ports-test --destination-path .work/destination/msys2-apiss
```

This applies **exactly those SHAs** and nothing else:

- No commits between `abc123` and `def456` are included, even if they exist on
  the mirror.
- There is no open/closed interval semantics; it is not "from A to B".
- Order is **command-line order**: `abc123` first, then `def456` (not sorted by
  author or committer date).
- Each SHA must exist on the mirror. Short prefixes work when git resolves them
  uniquely.

Use this when you want a small, hand-picked set of upstream commits.

### `--range A..B` = git revision range

```bash
yarn apply-mirror-patch --skip-fetch --source ports --range abc123..def456 --branch apply-ports-test --destination-path .work/destination/msys2-apiss
```

This runs `git rev-list --reverse A..B` on the mirror. It uses normal **git
two-dot range** rules:

| Endpoint | Included? |
|----------|-----------|
| Left (`abc123`) | **No** (exclusive) |
| Right (`def456`) | **Yes** (inclusive) |
| Commits between | **Yes**, if reachable from the right tip but not from the left |

Commits are applied **oldest first** (`--reverse`).

**Linear example.** History `A -> B -> C -> D` (each letter is a commit):

| Range | Commits applied (in order) |
|-------|----------------------------|
| `B..D` | `C`, `D` (not `B`) |
| `A..D` | `B`, `C`, `D` (not `A`) |
| `C..C` | none (empty range) |

**After a cursor.** If your destination cursor footer says
`Source: msys2/MSYS2-packages@abc123` and you want every new upstream commit
through tip `def456`:

```bash
--range abc123..def456
```

That matches incremental sync retrieve semantics: start **after** the cursor
(exclusive), include tip (inclusive).

**Non-linear history.** On merge commits, `A..B` includes all commits reachable
from `B` that are not reachable from `A`. Side-branch commits merged into `B`
are included. This matches git log range behavior, not "only first-parent
mainline" (full sync uses additional fork-safe cursor rules; this tool applies
whatever the range resolves to).

### What each applied commit does

For every SHA (from `--commit` or `--range`), the tool:

1. Resolves the mirror commit's **first parent** (`sha^1`; override with
   `--parent`).
2. Runs `git diff-tree parent..commit` on the mirror.
3. Rewrites paths into `ports/` or `ports-mingw/` and stages on the
   destination (or prints/list-only when requested).

### Multiple commits and `--create-commit`

Without `--create-commit`, each apply resets the index from `HEAD`
(`read-tree HEAD`). Staged changes from an earlier commit in the same run are
**not kept** when the next commit is applied. For more than one commit, use
`--create-commit` so each upstream commit becomes a destination replay commit
before the next one runs:

```bash
yarn apply-mirror-patch --skip-fetch --source ports --range abc123..def456 --branch apply-ports-test --destination-path .work/destination/msys2-apiss --create-commit
```

Same for an explicit list:

```bash
yarn apply-mirror-patch --skip-fetch --source ports --commit abc123 --commit def456 --branch apply-ports-test --destination-path .work/destination/msys2-apiss --create-commit
```

Single-commit staging (no `--create-commit`) is fine when you only pass one
`--commit`.

## Apply a commit range

Oldest-first git order (`rev-list --reverse`):

```bash
yarn apply-mirror-patch --skip-fetch --source ports --range abc123..def456 --branch apply-ports-test --destination-path .work/destination/msys2-apiss --create-commit
```

Explicit list (two commits only, not everything between them):

```bash
yarn apply-mirror-patch --skip-fetch --source ports --commit abc123 --commit def456 --branch apply-ports-test --destination-path .work/destination/msys2-apiss --create-commit
```

## Stage and create a replay commit

Preserves upstream author/committer name, email, and dates; message uses the
same template as full sync:

```bash
yarn apply-mirror-patch --skip-fetch --source ports --commit <sha> --branch apply-ports-test --destination-path .work/destination/msys2-apiss --create-commit
```

## Flags

| Flag | Purpose |
|------|---------|
| `--source` | `ports`, `ports-mingw`, or mirror/repo alias (required) |
| `--branch` | New local branch to create from `--base-branch` (required for index apply) |
| `--base-branch` | Branch to fork from (default: `upstream`) |
| `--commit` | One upstream mirror SHA; repeat for an explicit list (not a range) |
| `--range` | Git two-dot range `A..B`: A exclusive, B inclusive, oldest first |
| `--destination-path` | Destination clone path (required for index apply) |
| `--skip-fetch` | Do not fetch mirrors |
| `--print-patch` | Print remapped unified diff to stdout |
| `--output` | Write patch file (with `--print-patch`) |
| `--list-files` | List mapped paths only |
| `--create-commit` | Create a replay commit after staging |
| `--parent` | Override first parent for the diff (default: `sha^1`) |

`--create-commit` cannot be combined with `--print-patch` or `--list-files`.

## Troubleshooting

**`unable to normalize alternate object path`** - the destination clone's
`.git/objects/info/alternates` still points at mirror paths from an old checkout
location (for example after moving the repo from another directory). Re-run
`apply-mirror-patch` or `yarn mirror-merge`; both refresh alternates to the current
`.work/mirrors/` paths before touching the destination index.

Check alternates:

```powershell
Get-Content .work/destination/msys2-apiss/.git/objects/info/alternates
```

Paths should be under your current repo root, not a stale directory.
