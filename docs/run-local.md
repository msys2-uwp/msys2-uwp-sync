# Run locally (testing)

Operational sync (push, resume, bootstrap): [`usage.md`](usage.md). Block 4:
[`mirror-merge.md`](mirror-merge.md). Mirror tooling branch layout:
[`mirror-init.md` -- Tooling branch layout](mirror-init.md#tooling-branch-layout).

Requires **Node.js 26+**, **Yarn**, **git**, and network when fetching mirrors.

## Unit tests

```bash
yarn test
yarn typecheck
```

## Pipeline steps

Run retrieve and merge without replay (inspect `[sync]` output and JSON under
`.work/cache/replay-log/`):

```bash
yarn fetch-mirrors --skip-fetch
yarn retrieve-history --skip-fetch
yarn merge-queue --skip-fetch
```

Save every commit entry to JSON (large files):

```bash
yarn retrieve-history --skip-fetch --save-full-json
yarn merge-queue --skip-fetch --save-full-json
```

Writes `history-*-full.json` and `merged-queue-full.json`.

## Verify replay manifest

Dry-run verify (no push): [`mirror-merge.md`](mirror-merge.md#operator-flows) and below.

```bash
git clone https://github.com/msys2-apiss/msys2-apiss.git .work/destination/msys2-apiss
yarn fetch-mirrors --skip-fetch
yarn mirror-merge --dry-run --skip-fetch --destination-path .work/destination/msys2-apiss
```

Exit 0: no mismatch. Non-zero: inspect `[sync]` output and [`PLAN.md`](PLAN.md)
recovery steps.

## Dry-run and throttle

See [`mirror-merge.md`](mirror-merge.md) flags. Examples:

```bash
yarn mirror-merge --dry-run --skip-fetch --max-commits 5
yarn mirror-merge --skip-fetch --max-commits 10 --destination-path .work/destination/msys2-apiss
```

## Log capture

`--log-file` suppresses console `[sync]` info lines; warnings and errors still
print. Each run truncates the log unless you pass `--log-append`. Use paths under
`.work/cache/replay-log/`, not repo-root files (`out.txt`, `msys.txt`).

```bash
yarn mirror-merge --dry-run --skip-fetch --log-file .work/cache/replay-log/sync-dryrun.log
yarn mirror-merge --dry-run --skip-fetch --max-commits 5 --log-file .work/cache/replay-log/sync-dryrun.log
```
