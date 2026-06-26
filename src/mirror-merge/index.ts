import { join } from 'node:path';

import { performance } from 'node:perf_hooks';

import { printMirrorMergeCliHelp, readFlag, readIntOption, readStringOption, wantsHelp } from './args.ts';
import { getSourceConfigEntry, getSyncRepoRoot, loadSyncConfig, type SyncConfig, type Logger } from './config.ts';
import { createMirrorMergeLogger, getWorkDirectory, setMirrorMergeUtf8Environment, shouldLogQueueProgress } from './log.ts';
import { getMirrorTipSha, getSourceReplayHistory } from './history.ts';
import {
  buildMirrorCommitParentMap,
  filterReplayQueueByAge,
  getFirstParentFromMap,
  mergeReplayCommitQueues,
  precomputeReplayCursorBranchSafeFlags,
  type CommitParentMap
} from './queue.ts';
import {
  advanceSyncCursorDestShasIfSafe,
  clearDestinationSyncBranches,
  checkoutDestinationReplayBranch,
  ensureDestinationBaseCommit,
  getDestinationBranchSha,
  initializeDestinationAlternates,
  initializeDestinationRepository,
  initializeMirrorRepository,
  pushDestinationBranches,
  resolveSyncRetrieveCursorsFromBranches,
  setDestinationReplayCheckout,
  testAllSyncBranchesExist,
  updateDestinationCursorBranchRefs,
  updateDestinationSyncBranchRefs
} from './repos.ts';
import {
  getMirrorParentGraphCachePath,
  loadOrBuildMirrorCommitParentMap
} from './replay-graph.ts';
import {
  applyUpstreamCommitToIndex,
  formatReplayCommitMessage,
  newReplayCommit,
  testUpstreamCommitHasMappedChanges
} from './replay.ts';
import { runGit, runGitText } from '../git/index.ts';

export type { SyncConfig, Logger, SourceConfigEntry } from './config.ts';

export interface MirrorMergeOptions {
  RepoRoot: string;
  WorkDirectory: string;
  Config: SyncConfig;
  Logger: Logger;
  Clean?: boolean;
  DryRun?: boolean;
  Push?: boolean;
  SkipFetch?: boolean;
  MaxCommits?: number;
  DestinationPath?: string;
}

export interface MirrorMergeResult {
  Status: 'done' | 'dry-run' | 'no-commits';
  Processed: number;
  Replayed: number;
  TipSha?: string;
}

export function resolveMirrorMergeMode(input: {
  Clean: boolean;
  AllSyncBranchesExist: boolean;
}): 'bootstrap' | 'incremental' {
  return input.Clean || !input.AllSyncBranchesExist ? 'bootstrap' : 'incremental';
}

export function formatMirrorMergeCursorSummary(
  config: SyncConfig,
  upstreamCursors: Record<string, string | null>
): string {
  return config.Sources
    .map((source) => `${source.SortKey}=${(upstreamCursors[source.SortKey] ?? 'none').slice(0, 8)}`)
    .join(' ');
}

export async function runMirrorMerge(input: MirrorMergeOptions): Promise<MirrorMergeResult> {
  const clean = Boolean(input.Clean);
  const dryRun = Boolean(input.DryRun);
  const push = Boolean(input.Push);
  const skipFetch = Boolean(input.SkipFetch);
  const maxCommits = input.MaxCommits ?? 0;
  const config = input.Config;
  const logger = input.Logger;
  const replayBranch = config.Destination.ReplayTip;

  logger.write(`Mirror-Merge start (clean=${clean} dryRun=${dryRun} push=${push} skipFetch=${skipFetch})`);

  const mirrorPaths = new Map<string, string>();
  for (const source of config.Sources) {
    mirrorPaths.set(
      source.SortKey,
      initializeMirrorRepository({
        WorkDirectory: input.WorkDirectory,
        Source: source,
        Config: config,
        SkipFetch: skipFetch,
        Logger: logger
      })
    );
  }
  const destPath = initializeDestinationRepository({
    WorkDirectory: input.WorkDirectory,
    Config: config,
    DestinationPath: input.DestinationPath,
    SkipFetch: skipFetch,
    Logger: logger
  });

  for (const source of config.Sources) {
    logger.write(`Mirror ${source.SortKey}: ${mirrorPaths.get(source.SortKey)}`);
  }
  logger.write(`Destination: ${destPath}`);

  initializeDestinationAlternates(destPath, [...mirrorPaths.values()]);
  ensureDestinationBaseCommit(destPath, config, logger);

  if (clean) {
    logger.write('Clean: resetting destination sync branches');
    clearDestinationSyncBranches(destPath, config, logger);
  }

  const lastDestShas: Record<string, string | null> = Object.fromEntries(
    config.Sources.map((source) => [source.SortKey, null])
  );
  const upstreamCursors: Record<string, string | null> = Object.fromEntries(
    config.Sources.map((source) => [source.SortKey, null])
  );

  if (!clean) {
    const retrieveCursors = resolveSyncRetrieveCursorsFromBranches(destPath, config);
    for (const source of config.Sources) {
      lastDestShas[source.SortKey] = retrieveCursors[source.SortKey]?.DestSha ?? null;
      upstreamCursors[source.SortKey] = retrieveCursors[source.SortKey]?.UpstreamSha ?? null;
    }
  }

  const mode = resolveMirrorMergeMode({
    Clean: clean,
    AllSyncBranchesExist: !clean && testAllSyncBranchesExist(destPath, config)
  });
  const isFullReplay = mode === 'bootstrap';

  if (isFullReplay) {
    logger.write('Bootstrap: full replay (no age gate)');
  } else {
    logger.write(`Incremental: cursors ${formatMirrorMergeCursorSummary(config, upstreamCursors)}`);
  }

  if (!dryRun) {
    if (clean || isFullReplay) {
      setDestinationReplayCheckout(destPath, config, true);
    } else {
      const replayTipSha = getDestinationBranchSha(destPath, replayBranch);
      if (!replayTipSha) {
        throw new Error(`Missing destination branch origin/${replayBranch}`);
      }
      checkoutDestinationReplayBranch(destPath, replayBranch, replayTipSha);
    }
  } else {
    setDestinationReplayCheckout(destPath, config, isFullReplay);
  }

  const historyLists = await Promise.all(
    config.Sources.map(async (source) => {
      const mirrorPath = mirrorPaths.get(source.SortKey)!;
      const tip = getMirrorTipSha(mirrorPath, source.Branch);
      return getSourceReplayHistory(
        source.SortKey,
        config,
        mirrorPath,
        upstreamCursors[source.SortKey],
        tip
      );
    })
  );
  let queue = mergeReplayCommitQueues(...historyLists);

  const historyCounts = Object.fromEntries(
    config.Sources.map((source, index) => [source.SortKey, historyLists[index]!.length])
  );
  logger.write(
    `Retrieved ${config.Sources.map((source) => `${source.SortKey}=${historyCounts[source.SortKey]}`).join(' ')} merged=${queue.length}`
  );

  if (!isFullReplay) {
    queue = filterReplayQueueByAge(queue, config, (message) => logger.write(message));
    logger.write(`After age gate: ${queue.length} commit(s)`);
  }

  if (queue.length === 0) {
    logger.write('No commits to replay.');
    return { Status: 'no-commits', Processed: 0, Replayed: 0 };
  }

  if (maxCommits > 0 && queue.length > maxCommits) {
    queue = queue.slice(0, maxCommits);
    logger.write(`Throttled to MaxCommits=${maxCommits}`);
  }

  const graphCacheDir = join(input.WorkDirectory, 'cache', 'replay-graph');
  const parentMaps: Record<string, CommitParentMap> = {};
  await Promise.all(
    config.Sources.map(async (source) => {
      const mirrorPath = mirrorPaths.get(source.SortKey)!;
      const tip = getMirrorTipSha(mirrorPath, source.Branch);
      parentMaps[source.SortKey] = await loadOrBuildMirrorCommitParentMap({
        CachePath: getMirrorParentGraphCachePath(graphCacheDir, source.SortKey, source.Branch, tip),
        Branch: source.Branch,
        TipSha: tip,
        Build: () => buildMirrorCommitParentMap(mirrorPath, source.Branch)
      });
    })
  );
  const sourceEntries = Object.fromEntries(
    config.Sources.map((source, index) => [source.SortKey, historyLists[index]!])
  );
  const precomputeStart = performance.now();
  let lastPrecomputeReport = -1;
  const cursorBranchSafeFlags = precomputeReplayCursorBranchSafeFlags({
    Queue: queue,
    ParentMaps: parentMaps,
    SourceEntries: sourceEntries,
    OnSourceProgress: (sourceId, processed, total) => {
      if (processed === 0) {
        logger.write(`Precompute fork-safe flags ${sourceId}: start (${total} entries)`);
        return;
      }
      const pct = Math.round((processed / total) * 100);
      if (processed === total || processed - lastPrecomputeReport >= 5000) {
        logger.write(
          `Precompute fork-safe flags ${sourceId}: ${processed}/${total} (${pct}%) +${Math.round(performance.now() - precomputeStart)}ms`
        );
        lastPrecomputeReport = processed;
      }
    },
    ProgressInterval: 5000
  });
  logger.write('Precomputed fork-safe cursor branch flags');

  let replayed = 0;
  const skipEmpty = Boolean(config.Replay.SkipEmptyTreeDiff);

  for (let index = 0; index < queue.length; index++) {
    const entry = queue[index]!;
    const mirrorPath = mirrorPaths.get(entry.SourceId);
    const parentMap = parentMaps[entry.SourceId];
    if (!mirrorPath || !parentMap) {
      throw new Error(`Unknown SourceId on queue entry: ${entry.SourceId}`);
    }

    const parent = getFirstParentFromMap(parentMap, entry.Sha);
    const sourceEntry = getSourceConfigEntry(config, entry.SourceId);
    const message = formatReplayCommitMessage({
      Template: sourceEntry.CommitMessage,
      SortKey: entry.SortKey,
      Metadata: entry,
      UpstreamRepo: entry.UpstreamRepo,
      UpstreamSha: entry.Sha
    });

    let entryReplayed = false;
    if (dryRun) {
      const hasChanges = testUpstreamCommitHasMappedChanges(mirrorPath, entry.Sha, parent);
      if (!hasChanges && skipEmpty) {
        logger.write(`[${entry.SourceId}] skip empty diff ${entry.Sha.slice(0, 8)} ${entry.Subject}`);
      } else {
        logger.write(`[${entry.SourceId}] dry-run would replay ${entry.Sha.slice(0, 8)} ${entry.Subject}`);
      }
    } else {
      const hasChanges = applyUpstreamCommitToIndex({
        MirrorPath: mirrorPath,
        Commit: entry.Sha,
        Parent: parent,
        DestSubdir: entry.DestSubdir,
        DestinationPath: destPath
      });
      if (!hasChanges && skipEmpty) {
        logger.write(`[${entry.SourceId}] skip empty diff ${entry.Sha.slice(0, 8)} ${entry.Subject}`);
      } else {
        newReplayCommit(destPath, entry, message);
        runGit(destPath, ['reset', '--hard', 'HEAD']);
        replayed++;
        entryReplayed = true;
      }
    }

    if (!dryRun && entryReplayed) {
      const cursorBranchSafe = cursorBranchSafeFlags[index] ?? false;
      if (cursorBranchSafe) {
        const replayTipSha = runGitText(destPath, ['rev-parse', 'HEAD']).trim();
        const previousDestShas = { ...lastDestShas };
        const nextDestShas = advanceSyncCursorDestShasIfSafe({
          SourceId: entry.SourceId,
          ReplayTipSha: replayTipSha,
          CursorBranchSafe: cursorBranchSafe,
          LastDestShas: lastDestShas
        });
        const updates: Partial<Record<string, string | null>> = {};
        for (const source of config.Sources) {
          const nextSha = nextDestShas[source.SortKey];
          if (nextSha !== previousDestShas[source.SortKey]) {
            updates[source.SortKey] = nextSha;
            lastDestShas[source.SortKey] = nextSha;
          }
        }
        if (Object.keys(updates).length > 0) {
          updateDestinationCursorBranchRefs(destPath, config, updates);
        }
      }
    }

    if (shouldLogQueueProgress(index + 1, queue.length)) {
      const processed = index + 1;
      const remaining = queue.length - processed;
      logger.write(`Progress: ${processed}/${queue.length} (${replayed} replayed, ${remaining} remaining)`);
    }
  }

  if (dryRun) {
    logger.write(`Dry run complete; processed ${queue.length} queue entry(ies).`);
    return { Status: 'dry-run', Processed: queue.length, Replayed: 0 };
  }

  if (replayed > 0) {
    runGit(destPath, ['reset', '--hard', 'HEAD']);
  }

  const replayTip = runGitText(destPath, ['rev-parse', 'HEAD']).trim();
  updateDestinationSyncBranchRefs(destPath, config, {
    ReplayTipSha: replayTip,
    CursorDestShas: lastDestShas
  });

  logger.write(`Replayed ${replayed} commit(s); tip=${replayTip.slice(0, 8)}`);
  if (push) {
    logger.write('Pushing destination branches');
    pushDestinationBranches(destPath, config, clean || isFullReplay);
  } else {
    logger.write('Skipping push (pass --push to publish destination branches)');
  }
  logger.write('Mirror-Merge done.');

  return { Status: 'done', Processed: queue.length, Replayed: replayed, TipSha: replayTip };
}

export async function runMirrorMergeCli(): Promise<void> {
  setMirrorMergeUtf8Environment();
  const args = process.argv.slice(2);
  const repoRoot = getSyncRepoRoot();
  const config = loadSyncConfig(repoRoot);
  const defaultDestinationPath = join('.work', 'destination', config.Destination.Repo);
  if (wantsHelp(args)) {
    printMirrorMergeCliHelp(defaultDestinationPath);
    return;
  }

  const logger = createMirrorMergeLogger(repoRoot, {
    logFile: readStringOption(args, '--log-file'),
    append: readFlag(args, '--log-append'),
    logToConsole: readFlag(args, '--log-to-console')
  });

  try {
    await runMirrorMerge({
      RepoRoot: repoRoot,
      WorkDirectory: getWorkDirectory(repoRoot),
      Config: config,
      Logger: logger,
      Clean: readFlag(args, '--clean'),
      DryRun: readFlag(args, '--dry-run'),
      Push: readFlag(args, '--push'),
      SkipFetch: readFlag(args, '--skip-fetch'),
      MaxCommits: readIntOption(args, '--max-commits', 0),
      DestinationPath: readStringOption(args, '--destination-path')
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.write(message, 'Error');
    logger.write('Re-run without --clean to continue from branch cursors.', 'Warn');
    process.exitCode = 1;
  } finally {
    logger.close();
  }
}
