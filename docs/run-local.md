# Run locally

Requires **Node.js 22.18+**, **npm**, **git**, and network (mirror
clone/fetch).

From the repository root:

```bash
npm run fetch-mirrors
npm run retrieve-history
npm run merge-queue
```

Each script prints `[sync]` progress. Summary JSON is written under
`.work/cache/replay-log/`.

Save every commit entry to JSON (large files):

```bash
npm run retrieve-history -- --skip-fetch --save-full-json
npm run merge-queue -- --skip-fetch --save-full-json
```

Writes `history-*-full.json` and `merged-queue-full.json`.

Skip re-fetch if mirrors already exist:

```bash
npm run fetch-mirrors -- --skip-fetch
npm run retrieve-history -- --skip-fetch
npm run merge-queue -- --skip-fetch
```

Full sync (retrieve, merge, replay, push):

```bash
npm run sync -- --destination-path .work/destination/msys2-uwp
```

Local replay without push (throttle for dev):

```bash
npm run sync -- --dry-run --skip-fetch --max-commits 5
npm run sync -- --skip-fetch --max-commits 10 --destination-path .work/destination/msys2-uwp
```

Log to a file only (`--log-file` suppresses console `[sync]` info lines; warnings/errors
still print). Each run truncates the log unless you pass `--log-append`.

Option A ¡ª close `out.txt` in the editor, then:

```bash
npm run sync -- --dry-run --skip-fetch --log-file out.txt
```

Option B ¡ª log to a path the editor is not holding open:

```bash
npm run sync -- --dry-run --skip-fetch --log-file .work/cache/replay-log/sync-dryrun.log
```

Throttled dry-run with log file:

```bash
npm run sync -- --dry-run --skip-fetch --max-commits 5 --log-file .work/cache/replay-log/sync-dryrun.log
```

Resume after interrupt or failure (uses `.work/cache/replay-log/replay-checkpoint.json`):

```bash
npm run sync -- --dry-run --skip-fetch --log-file .work/cache/replay-log/sync-dryrun.log --log-append --resume
npm run sync -- --clear-checkpoint
```

Bootstrap from scratch (reset sync branches, force-push):

```bash
npm run sync -- --clean --destination-path .work/destination/msys2-uwp
```

Unit tests:

```bash
npm test
npm run typecheck
```

Minimal-safe-editing checker (after `npm install`):

```powershell
npm run build
npm run msec:check
npm test -- tests/minimal-safe-editing-check
```
