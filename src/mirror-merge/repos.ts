import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  getDestinationCloneUrl,
  getMirrorCloneUrlForSource,
  type SourceConfigEntry,
  type SyncConfig,
  type Logger
} from './config.ts';
import { runGit, runGitText } from '../git/index.ts';
import { parseReplayCommitSourceSha } from './replay.ts';

function mirrorGitObjectsPath(mirrorPath: string): string {
  return join(realpathSync(mirrorPath), '.git', 'objects');
}

export function initializeMirrorRepository(input: {
  WorkDirectory: string;
  Source: SourceConfigEntry;
  Config: SyncConfig;
  SkipFetch: boolean;
  Logger: Logger;
}): string {
  const mirrorRoot = join(input.WorkDirectory, 'mirrors');
  mkdirSync(mirrorRoot, { recursive: true });

  const mirrorPath = join(mirrorRoot, input.Source.Repo);
  const url = getMirrorCloneUrlForSource(input.Config, input.Source);

  if (!existsSync(mirrorPath)) {
    input.Logger.write(`Cloning mirror ${input.Source.SortKey} to ${mirrorPath} (${url})`);
    runGit(null, ['clone', url, mirrorPath], {}, 5, input.Logger);
    setGitRepoUtf8Encoding(mirrorPath);
  } else if (!input.SkipFetch) {
    input.Logger.write(`Fetching mirror ${input.Source.SortKey} (${mirrorPath})`);
    runGit(mirrorPath, ['fetch', 'origin', '--prune'], {}, 5, input.Logger);
  }

  setGitRepoUtf8Encoding(mirrorPath);
  return mirrorPath;
}

export function initializeDestinationRepository(input: {
  WorkDirectory: string;
  Config: SyncConfig;
  DestinationPath?: string;
  SkipFetch: boolean;
  Logger: Logger;
}): string {
  if (input.DestinationPath) {
    const destPath = realpathSync(input.DestinationPath);
    if (!input.SkipFetch) {
      input.Logger.write(`Fetching destination (${destPath})`);
      runGit(destPath, ['fetch', 'origin', '--prune'], {}, 5, input.Logger);
    }
    setGitRepoUtf8Encoding(destPath);
    return destPath;
  }

  const destRoot = join(input.WorkDirectory, 'destination');
  mkdirSync(destRoot, { recursive: true });
  const destPath = join(destRoot, input.Config.Destination.Repo);
  const url = getDestinationCloneUrl(input.Config);

  if (!existsSync(destPath)) {
    input.Logger.write(`Cloning destination to ${destPath} (${url})`);
    runGit(null, ['clone', url, destPath], {}, 5, input.Logger);
    setGitRepoUtf8Encoding(destPath);
  } else if (!input.SkipFetch) {
    input.Logger.write(`Fetching destination (${destPath})`);
    runGit(destPath, ['fetch', 'origin', '--prune'], {}, 5, input.Logger);
  }

  setGitRepoUtf8Encoding(destPath);
  return destPath;
}

function setGitRepoUtf8Encoding(repoPath: string): void {
  for (const [key, value] of [
    ['i18n.logOutputEncoding', 'utf-8'],
    ['i18n.commitEncoding', 'utf-8'],
    ['core.quotepath', 'false']
  ]) {
    runGit(repoPath, ['config', key, value]);
  }
}

export function initializeDestinationAlternates(destinationPath: string, mirrorPaths: string[]): void {
  const alternatesDir = join(destinationPath, '.git', 'objects', 'info');
  mkdirSync(alternatesDir, { recursive: true });
  const normalized = mirrorPaths
    .map((mirrorPath) => mirrorGitObjectsPath(mirrorPath))
    .filter((objectsPath) => existsSync(objectsPath))
    .map((objectsPath) => objectsPath.replace(/\\/g, '/'));
  writeFileSync(join(alternatesDir, 'alternates'), `${normalized.join('\n')}\n`, 'utf8');
}

export function ensureDestinationBaseCommit(destinationPath: string, config: SyncConfig, logger: Logger): void {
  const base = config.Destination.BaseCommit;
  try {
    runGit(destinationPath, ['cat-file', '-e', `${base}^{commit}`]);
    return;
  } catch {
    logger.write('Base commit not in clone; fetching from origin', 'Warn');
  }
  runGit(destinationPath, ['fetch', 'origin', base], {}, 5, logger);
  runGit(destinationPath, ['cat-file', '-e', `${base}^{commit}`]);
}

function prepareDestinationWorkingTree(destinationPath: string): void {
  runGit(destinationPath, ['clean', '-fd']);
}

export function checkoutDestinationReplayBranch(
  destinationPath: string,
  branchName: string,
  sha: string
): void {
  prepareDestinationWorkingTree(destinationPath);
  runGit(destinationPath, ['checkout', '-f', '-B', branchName, sha]);
  runGit(destinationPath, ['reset', '--hard', 'HEAD']);
}

export function setDestinationReplayCheckout(
  destinationPath: string,
  config: SyncConfig,
  isFullReplay: boolean
): void {
  const replayBranch = config.Destination.ReplayTip;
  if (isFullReplay) {
    checkoutDestinationReplayBranch(destinationPath, replayBranch, config.Destination.BaseCommit);
    return;
  }
  const replayTipSha = getDestinationBranchSha(destinationPath, replayBranch);
  if (!replayTipSha) {
    throw new Error(`Missing destination branch origin/${replayBranch}`);
  }
  checkoutDestinationReplayBranch(destinationPath, replayBranch, replayTipSha);
}

export function getDestinationBranchSha(destinationPath: string, branchName: string): string | null {
  try {
    return runGitText(destinationPath, ['rev-parse', `origin/${branchName}`]).trim();
  } catch {
    return null;
  }
}

function getLocalDestinationBranchSha(destinationPath: string, branchName: string): string | null {
  try {
    return runGitText(destinationPath, ['rev-parse', branchName]).trim();
  } catch {
    return null;
  }
}

export function testAllSyncBranchesExist(destinationPath: string, config: SyncConfig): boolean {
  if (!getDestinationBranchSha(destinationPath, config.Destination.ReplayTip)) {
    return false;
  }
  for (const source of config.Sources) {
    if (!getDestinationBranchSha(destinationPath, source.CursorBranch)) {
      return false;
    }
  }
  return true;
}

function setDestinationBranchSha(destinationPath: string, branchName: string, sha: string): void {
  let currentBranch: string | null = null;
  try {
    currentBranch = runGitText(destinationPath, ['symbolic-ref', '--short', 'HEAD']).trim();
  } catch {
    // Detached HEAD.
  }

  if (currentBranch === branchName) {
    const head = runGitText(destinationPath, ['rev-parse', 'HEAD']).trim();
    if (head !== sha) {
      runGit(destinationPath, ['reset', '--hard', sha]);
    }
    return;
  }

  runGit(destinationPath, ['branch', '-f', branchName, sha]);
}

export function updateDestinationCursorBranchRefs(
  destinationPath: string,
  config: SyncConfig,
  updates: Partial<Record<string, string | null>>
): void {
  for (const source of config.Sources) {
    const sha = updates[source.SortKey];
    if (sha) {
      setDestinationBranchSha(destinationPath, source.CursorBranch, sha);
    }
  }
}

export function updateDestinationSyncBranchRefs(
  destinationPath: string,
  config: SyncConfig,
  input: {
    ReplayTipSha: string;
    CursorDestShas: Record<string, string | null>;
  }
): void {
  setDestinationBranchSha(destinationPath, config.Destination.ReplayTip, input.ReplayTipSha);
  updateDestinationCursorBranchRefs(destinationPath, config, input.CursorDestShas);
}

function resolveUpstreamCursorSha(
  destinationPath: string,
  cursorDestSha: string,
  upstreamRepo: string
): string | null {
  const message = runGitText(destinationPath, ['log', '-1', '--format=%B', cursorDestSha]);
  return parseReplayCommitSourceSha(message, upstreamRepo);
}

export interface SourceCursor {
  DestSha: string | null;
  UpstreamSha: string | null;
}

export type SyncRetrieveCursors = Record<string, SourceCursor>;

export function resolveSyncRetrieveCursorsFromBranches(
  destinationPath: string,
  config: SyncConfig
): SyncRetrieveCursors {
  const cursors: SyncRetrieveCursors = {};
  for (const source of config.Sources) {
    const destSha = getDestinationBranchSha(destinationPath, source.CursorBranch);
    cursors[source.SortKey] = {
      DestSha: destSha,
      UpstreamSha: destSha
        ? resolveUpstreamCursorSha(destinationPath, destSha, source.UpstreamRepo)
        : null
    };
  }
  return cursors;
}

export function advanceSyncCursorDestShasIfSafe(input: {
  SourceId: string;
  ReplayTipSha: string;
  CursorBranchSafe: boolean;
  LastDestShas: Record<string, string | null>;
}): Record<string, string | null> {
  const result = { ...input.LastDestShas };
  if (!input.CursorBranchSafe) {
    return result;
  }
  result[input.SourceId] = input.ReplayTipSha;
  return result;
}

export function clearDestinationSyncBranches(destinationPath: string, config: SyncConfig, logger: Logger): void {
  const base = config.Destination.BaseCommit;
  const replayBranch = config.Destination.ReplayTip;
  try {
    runGit(destinationPath, ['cat-file', '-e', `${base}^{commit}`]);
    checkoutDestinationReplayBranch(destinationPath, replayBranch, base);
  } catch {
    logger.write(`Base commit not in clone; deleting replay branch ${replayBranch}`, 'Warn');
    try {
      runGit(destinationPath, ['branch', '-D', replayBranch]);
    } catch {
      // Branch may not exist.
    }
  }

  for (const source of config.Sources) {
    try {
      runGit(destinationPath, ['branch', '-D', source.CursorBranch]);
    } catch {
      // Branch may not exist.
    }
    try {
      runGit(destinationPath, ['update-ref', '-d', `refs/remotes/origin/${source.CursorBranch}`]);
    } catch {
      // Remote-tracking ref may not exist.
    }
  }

  try {
    runGit(destinationPath, ['update-ref', '-d', `refs/remotes/origin/${replayBranch}`]);
  } catch {
    // Remote-tracking ref may not exist.
  }
}

export function pushDestinationBranches(
  destinationPath: string,
  config: SyncConfig,
  forceReplayBranch: boolean
): void {
  const replayBranch = config.Destination.ReplayTip;
  runGit(destinationPath, ['push', 'origin', ...(forceReplayBranch ? ['--force'] : []), replayBranch]);

  for (const source of config.Sources) {
    const sha = getLocalDestinationBranchSha(destinationPath, source.CursorBranch);
    if (sha) {
      runGit(destinationPath, ['push', 'origin', source.CursorBranch]);
    } else {
      runGit(destinationPath, ['push', 'origin', '--delete', source.CursorBranch]);
    }
  }
}
