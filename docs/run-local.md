# Run locally

Requires **PowerShell 7+**, **git**, and network (mirror clone/fetch).

From the repository root:

```powershell
./scripts/Fetch-Mirrors.ps1
./scripts/Retrieve-History.ps1
./scripts/Merge-Queue.ps1
```

Each script prints `[sync]` progress. Summary JSON is written under
`.work/cache/replay-log/`.

Save every commit entry to JSON (large files):

```powershell
./scripts/Retrieve-History.ps1 -SkipFetch -SaveFullJson
./scripts/Merge-Queue.ps1 -SkipFetch -SaveFullJson
```

Writes `history-*-full.json` and `merged-queue-full.json`.

Skip re-fetch if mirrors already exist:

```powershell
./scripts/Fetch-Mirrors.ps1 -SkipFetch
./scripts/Retrieve-History.ps1 -SkipFetch
./scripts/Merge-Queue.ps1 -SkipFetch
```

Unit tests:

```powershell
./tests/Test-Sync.ps1
```
