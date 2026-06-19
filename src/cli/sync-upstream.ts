import { runGitText, runGit } from '../lib/git.ts';
import { clearReplayCheckpoint, getReplayCheckpoint, saveReplayCheckpoint } from '../lib/checkpoint.ts';
import { getSyncRepoRoot, loadSyncConfig } from '../lib/config.ts';
import { getMirrorTipSha, getSourceReplayHistory } from '../lib/history.ts';
import { createSyncLogger, getWorkDirectory, setSyncUtf8Environment } from '../lib/log.ts';
import { filterReplayQueueByAge, mergeReplayCommitQueues } from '../lib/queue.ts';
import {
  clearDestinationSyncBranches,
  ensureDestinationBaseCommit,
  getDestinationBranchSha,
  initializeDestinationAlternates,
  initializeDestinationRepository,
  initializeMirrorRepository,
  pushDestinationBranches,
  setDestinationBranchSha,
  setDestinationReplayCheckout,
  testAllSyncBranchesExist
} from '../lib/repos.ts';
import {
  applyUpstreamCommitToIndex,
  formatReplayCommitMessage,
  getFirstParent,
  newReplayCommit,
  testUpstreamCommitHasMappedChanges
} from '../lib/replay.ts';
import { readFlag, readIntOption, readStringOption } from './args.ts';

async function main(): Promise<void> {
  setSyncUtf8Environment();
  const args = process.argv.slice(2);
  const repoRoot = getSyncRepoRoot();
  const config = loadSyncConfig(repoRoot);
  const logger = createSyncLogger(repoRoot, {
    logFile: readStringOption(args, '--log-file'),
    append: readFlag(args, '--log-append'),
    logToConsole: readFlag(args, '--log-to-console')
  });

  try {
    const work = getWorkDirectory(repoRoot);
    const clean = readFlag(args, '--clean');
    const dryRun = readFlag(args, '--dry-run');
    const skipFetch = readFlag(args, '--skip-fetch');
    const resume = readFlag(args, '--resume');
    const clearCheckpoint = readFlag(args, '--clear-checkpoint');
    const maxCommits = readIntOption(args, '--max-commits', 0);
    const destinationPathArg = readStringOption(args, '--destination-path');
    const replayBranch = config.Destination.Branches.Replay;
    const cursorPortsBranch = config.Destination.Branches.CursorPorts;
    const cursorMingwBranch = config.Destination.Branches.CursorPortsMingw;

    if (clearCheckpoint) {
      clearReplayCheckpoint(work);
      logger.write('Checkpoint cleared.');
    }

    logger.write(`Sync-Upstream start (clean=${clean} dryRun=${dryRun} skipFetch=${skipFetch} resume=${resume})`);

    const mirrorPorts = initializeMirrorRepository({
      WorkDirectory: work,
      SourceKey: 'Ports',
      Config: config,
      SkipFetch: skipFetch,
      Logger: logger
    });
    const mirrorMingw = initializeMirrorRepository({
      WorkDirectory: work,
      SourceKey: 'PortsMingw',
      Config: config,
      SkipFetch: skipFetch,
      Logger: logger
    });
    const destPath = initializeDestinationRepository({
      WorkDirectory: work,
      Config: config,
      DestinationPath: destinationPathArg,
      SkipFetch: skipFetch,
      Logger: logger
    });

    initializeDestinationAlternates(destPath, [mirrorPorts, mirrorMingw]);
    ensureDestinationBaseCommit(destPath, config, logger);

    if (clean) {
      logger.write('Clean: resetting sync branches');
      clearDestinationSyncBranches(destPath, config, logger);
      clearReplayCheckpoint(work);
    }

    let cursorPorts = getDestinationBranchSha(destPath, cursorPortsBranch);
    let cursorMingw = getDestinationBranchSha(destPath, cursorMingwBranch);
    let isFullReplay = !testAllSyncBranchesExist(destPath, config);
    const checkpoint = resume ? getReplayCheckpoint(work) : null;

    if (resume) {
      if (!checkpoint) {
        logger.write('Resume requested but no checkpoint found; starting from cursors.', 'Warn');
      } else if (Boolean(checkpoint.DryRun) !== dryRun) {
        throw new Error('Checkpoint DryRun flag does not match this run. Use the same --dry-run setting as the interrupted run.');
      } else if (checkpoint.ReplaySpecVersion !== config.ReplaySpecVersion) {
        throw new Error(`Checkpoint ReplaySpecVersion ${checkpoint.ReplaySpecVersion} does not match config ${config.ReplaySpecVersion}.`);
      } else {
        cursorPorts = checkpoint.LastPortsSha;
        cursorMingw = checkpoint.LastPortsMingwSha;
        logger.write(`Resume: continuing after ${checkpoint.ProcessedCount} processed entry(ies)`);
      }
    }

    if (isFullReplay && !checkpoint) {
      logger.write('Bootstrap: full replay (no age gate)');
    } else if (!checkpoint && cursorPorts && cursorMingw) {
      logger.write(`Incremental: cursors ports=${cursorPorts.slice(0, 8)} mingw=${cursorMingw.slice(0, 8)}`);
    }

    if (checkpoint?.ReplayTipSha && !dryRun) {
      runGit(destPath, ['checkout', '-B', replayBranch, checkpoint.ReplayTipSha]);
      isFullReplay = false;
    } else {
      setDestinationReplayCheckout(destPath, config, isFullReplay);
    }

    const tipPorts = getMirrorTipSha(mirrorPorts, config.Sources.Ports.Branch);
    const tipMingw = getMirrorTipSha(mirrorMingw, config.Sources.PortsMingw.Branch);
    const portsList = getSourceReplayHistory('Ports', config, mirrorPorts, cursorPorts, tipPorts);
    const mingwList = getSourceReplayHistory('PortsMingw', config, mirrorMingw, cursorMingw, tipMingw);
    let queue = mergeReplayCommitQueues(portsList, mingwList);

    logger.write(`Retrieved ports=${portsList.length} mingw=${mingwList.length} merged=${queue.length}`);

    if (!isFullReplay) {
      queue = filterReplayQueueByAge(queue, config, (message) => logger.write(message));
      logger.write(`After age gate: ${queue.length} commit(s)`);
    }

    if (queue.length === 0) {
      logger.write('No commits to replay.');
      if (resume && checkpoint) {
        clearReplayCheckpoint(work);
      }
      process.exitCode = 0;
      return;
    }

    if (maxCommits > 0 && queue.length > maxCommits) {
      queue = queue.slice(0, maxCommits);
      logger.write(`Throttled to MaxCommits=${maxCommits}`);
    }

    let lastPortsSha = cursorPorts;
    let lastMingwSha = cursorMingw;
    let replayed = 0;
    const priorProcessed = checkpoint ? checkpoint.ProcessedCount : 0;
    const skipEmpty = Boolean(config.Replay.SkipEmptyTreeDiff);

    for (let index = 0; index < queue.length; index++) {
      const entry = queue[index]!;
      const mirrorPath = entry.SourceId === 'ports' ? mirrorPorts : entry.SourceId === 'ports-mingw' ? mirrorMingw : null;
      if (!mirrorPath) {
        throw new Error(`Unknown SourceId on queue entry: ${entry.SourceId}`);
      }

      const parent = getFirstParent(mirrorPath, entry.Sha);
      const message = formatReplayCommitMessage({
        SortKey: entry.SortKey,
        Metadata: entry,
        UpstreamRepo: entry.UpstreamRepo,
        UpstreamSha: entry.Sha
      });

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
          replayed++;
        }
      }

      if (entry.SourceId === 'ports') {
        lastPortsSha = entry.Sha;
      } else {
        lastMingwSha = entry.Sha;
      }

      const replayTipSha = dryRun ? null : runGitText(destPath, ['rev-parse', 'HEAD']).trim();
      saveReplayCheckpoint({
        WorkDirectory: work,
        Config: config,
        DryRun: dryRun,
        LastPortsSha: lastPortsSha,
        LastPortsMingwSha: lastMingwSha,
        ReplayTipSha: replayTipSha,
        ProcessedCount: priorProcessed + index + 1
      });

      if ((index + 1) % 100 === 0) {
        logger.write(`Progress: ${priorProcessed + index + 1} total (${index + 1} this run, ${replayed} replayed)`);
      }
    }

    clearReplayCheckpoint(work);

    if (dryRun) {
      logger.write(`Dry run complete; processed ${priorProcessed + queue.length} queue entry(ies) (${queue.length} this run).`);
      process.exitCode = 0;
      return;
    }

    if (replayed > 0) {
      runGit(destPath, ['reset', '--hard', 'HEAD']);
    }

    const replayTip = runGitText(destPath, ['rev-parse', 'HEAD']).trim();
    setDestinationBranchSha(destPath, replayBranch, replayTip);
    if (lastPortsSha) {
      setDestinationBranchSha(destPath, cursorPortsBranch, lastPortsSha);
    }
    if (lastMingwSha) {
      setDestinationBranchSha(destPath, cursorMingwBranch, lastMingwSha);
    }

    logger.write(`Replayed ${replayed} commit(s); tip=${replayTip.slice(0, 8)}`);
    logger.write('Pushing destination branches');
    pushDestinationBranches(destPath, config, clean || isFullReplay);
    logger.write('Sync-Upstream done.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.write(message, 'Error');
    logger.write('Checkpoint retained; re-run with --resume to continue.', 'Warn');
    process.exitCode = 1;
  } finally {
    logger.close();
  }
}

void main();
