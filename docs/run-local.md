# Run locally

Requires **Node.js 26+**, **Yarn**, **git**, and network (mirror
clone/fetch).

From the repository root:

```bash
yarn fetch-mirrors
yarn retrieve-history
yarn merge-queue
```

Each script prints `[sync]` progress. Summary JSON is written under
`.work/cache/replay-log/`.

Save every commit entry to JSON (large files):

```bash
yarn retrieve-history --skip-fetch --save-full-json
yarn merge-queue --skip-fetch --save-full-json
```

Writes `history-*-full.json` and `merged-queue-full.json`.

Skip re-fetch if mirrors already exist:

```bash
yarn fetch-mirrors --skip-fetch
yarn retrieve-history --skip-fetch
yarn merge-queue --skip-fetch
```

Full sync (retrieve, merge, replay, push):

```bash
yarn sync --destination-path .work/destination/msys2-apiss
```

Local replay without push (throttle for dev):

```bash
yarn sync --dry-run --skip-fetch --max-commits 5
yarn sync --skip-fetch --max-commits 10 --destination-path .work/destination/msys2-apiss
```

Log to a file under `.work/cache/replay-log/` (`--log-file` suppresses console
`[sync]` info lines; warnings/errors still print). Each run truncates the log
unless you pass `--log-append`. Do not use repo-root log files (`out.txt`,
`msys.txt`).

```bash
yarn sync --dry-run --skip-fetch --log-file .work/cache/replay-log/sync-dryrun.log
```

Throttled dry-run with log file:

```bash
yarn sync --dry-run --skip-fetch --max-commits 5 --log-file .work/cache/replay-log/sync-dryrun.log
```

Continue after interrupt or failure (branch cursors in the destination clone):

```bash
yarn sync --skip-fetch --destination-path .work/destination/msys2-apiss --log-file sync-run.log --log-append
```

Bootstrap from scratch (reset sync branches, force-push):

```bash
yarn sync --clean --destination-path .work/destination/msys2-apiss
```

Unit tests:

```bash
yarn test
yarn typecheck
```
