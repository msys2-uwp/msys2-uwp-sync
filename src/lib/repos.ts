import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SourceKey } from '../types/replay-entry.ts';
import {
  getDestinationCloneUrl,
  getMirrorCloneUrl,
  getSourceConfigEntry,
  getSourceRepoSlug,
  type SyncConfig
} from './config.ts';
import { parseReplayCommitSourceSha } from './replay.ts';
import { runGit, runGitText } from './git.ts';
import type { SyncLogger } from './log.ts';

export function initializeMirrorRepository(input: {
  WorkDirectory: string;
  SourceKey: SourceKey;
  Config: SyncConfig;
  SkipFetch: boolean;
  Logger: SyncLogger;
}): string {
  const sourceEntry = getSourceConfigEntry(input.Config, input.SourceKey);
  const mirrorRoot = join(input.WorkDirectory, 'mirrors');
  mkdirSync(mirrorRoot, { recursive: true });

  const mirrorPath = join(mirrorRoot, sourceEntry.Repo);
  const url = getMirrorCloneUrl(input.Config, input.SourceKey);

  if (!existsSync(mirrorPath)) {
    input.Logger.write(`Cloning mirror for ${input.SourceKey} (${url})`);
    runGit(null, ['clone', '--mirror', url, mirrorPath], {}, 5, input.Logger);
    setGitRepoUtf8Encoding(mirrorPath);
  } else if (!input.SkipFetch) {
    input.Logger.write(`Fetching mirror for ${input.SourceKey}`);
    runGit(mirrorPath, ['fetch', '--prune', 'origin'], {}, 5, input.Logger);
  }

  setGitRepoUtf8Encoding(mirrorPath);
  return mirrorPath;
}

export function initializeDestinationRepository(input: {
  WorkDirectory: string;
  Config: SyncConfig;
  DestinationPath?: string;
  SkipFetch: boolean;
  Logger: SyncLogger;
}): string {
  if (input.DestinationPath) {
    return realpathSync(input.DestinationPath);
  }

  const destRoot = join(input.WorkDirectory, 'destination');
  mkdirSync(destRoot, { recursive: true });
  const destPath = join(destRoot, input.Config.Destination.Repo);
  const url = getDestinationCloneUrl(input.Config);

  if (!existsSync(destPath)) {
    input.Logger.write(`Cloning destination (${url})`);
    runGit(null, ['clone', url, destPath], {}, 5, input.Logger);
    setGitRepoUtf8Encoding(destPath);
  } else if (!input.SkipFetch) {
    runGit(destPath, ['fetch', 'origin', '--prune'], {}, 5, input.Logger);
  }

  setGitRepoUtf8Encoding(destPath);
  return destPath;
}

export function setGitRepoUtf8Encoding(repoPath: string): void {
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
    .map((mirrorPath) => join(realpathSync(mirrorPath), 'objects'))
    .filter((objectsPath) => existsSync(objectsPath))
    .map((objectsPath) => objectsPath.replace(/\\/g, '/'));
  writeFileSync(join(alternatesDir, 'alternates'), `${normalized.join('\n')}\n`, 'utf8');
}

export function ensureDestinationBaseCommit(destinationPath: string, config: SyncConfig, logger: SyncLogger): void {
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

export function setDestinationReplayCheckout(
  destinationPath: string,
  config: SyncConfig,
  isFullReplay: boolean
): void {
  const replayBranch = config.Destination.Branches.Replay;
  if (isFullReplay) {
    runGit(destinationPath, ['checkout', '-B', replayBranch, config.Destination.BaseCommit]);
    return;
  }
  runGit(destinationPath, ['checkout', replayBranch]);
}

export function getDestinationBranchSha(destinationPath: string, branchName: string): string | null {
  try {
    return runGitText(destinationPath, ['rev-parse', branchName]).trim();
  } catch {
    return null;
  }
}

export function testAllSyncBranchesExist(destinationPath: string, config: SyncConfig): boolean {
  for (const branchName of [
    config.Destination.Branches.Replay,
    config.Destination.Branches.CursorPorts,
    config.Destination.Branches.CursorPortsMingw
  ]) {
    if (!getDestinationBranchSha(destinationPath, branchName)) {
      return false;
    }
  }
  return true;
}

export function setDestinationBranchSha(destinationPath: string, branchName: string, sha: string): void {
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

export function updateDestinationSyncBranchRefs(
  destinationPath: string,
  config: SyncConfig,
  input: {
    ReplayTipSha: string;
    PortsDestSha: string | null;
    PortsMingwDestSha: string | null;
  }
): void {
  setDestinationBranchSha(destinationPath, config.Destination.Branches.Replay, input.ReplayTipSha);
  if (input.PortsDestSha) {
    setDestinationBranchSha(destinationPath, config.Destination.Branches.CursorPorts, input.PortsDestSha);
  }
  if (input.PortsMingwDestSha) {
    setDestinationBranchSha(destinationPath, config.Destination.Branches.CursorPortsMingw, input.PortsMingwDestSha);
  }
}

export function resolveUpstreamCursorSha(
  destinationPath: string,
  cursorDestSha: string,
  upstreamRepo: string
): string | null {
  const message = runGitText(destinationPath, ['log', '-1', '--format=%B', cursorDestSha]);
  return parseReplayCommitSourceSha(message, upstreamRepo);
}

export interface SyncRetrieveCursors {
  PortsDestSha: string | null;
  PortsMingwDestSha: string | null;
  PortsUpstreamSha: string | null;
  PortsMingwUpstreamSha: string | null;
}

export function resolveSyncRetrieveCursorsFromBranches(
  destinationPath: string,
  config: SyncConfig
): SyncRetrieveCursors {
  const portsSource = getSourceConfigEntry(config, 'Ports');
  const mingwSource = getSourceConfigEntry(config, 'PortsMingw');
  const portsDestSha = getDestinationBranchSha(destinationPath, config.Destination.Branches.CursorPorts);
  const mingwDestSha = getDestinationBranchSha(destinationPath, config.Destination.Branches.CursorPortsMingw);
  return {
    PortsDestSha: portsDestSha,
    PortsMingwDestSha: mingwDestSha,
    PortsUpstreamSha: portsDestSha
      ? resolveUpstreamCursorSha(destinationPath, portsDestSha, getSourceRepoSlug(portsSource))
      : null,
    PortsMingwUpstreamSha: mingwDestSha
      ? resolveUpstreamCursorSha(destinationPath, mingwDestSha, getSourceRepoSlug(mingwSource))
      : null
  };
}

export function advanceSyncCursorDestShasIfSafe(input: {
  SourceId: string;
  ReplayTipSha: string;
  CursorBranchSafe: boolean;
  LastPortsDestSha: string | null;
  LastMingwDestSha: string | null;
}): { PortsDestSha: string | null; PortsMingwDestSha: string | null } {
  let portsDestSha = input.LastPortsDestSha;
  let mingwDestSha = input.LastMingwDestSha;
  if (!input.CursorBranchSafe) {
    return { PortsDestSha: portsDestSha, PortsMingwDestSha: mingwDestSha };
  }
  if (input.SourceId === 'ports') {
    portsDestSha = input.ReplayTipSha;
  } else if (input.SourceId === 'ports-mingw') {
    mingwDestSha = input.ReplayTipSha;
  }
  return { PortsDestSha: portsDestSha, PortsMingwDestSha: mingwDestSha };
}

export function clearDestinationSyncBranches(destinationPath: string, config: SyncConfig, logger: SyncLogger): void {
  const base = config.Destination.BaseCommit;
  const replayBranch = config.Destination.Branches.Replay;
  try {
    runGit(destinationPath, ['cat-file', '-e', `${base}^{commit}`]);
    runGit(destinationPath, ['checkout', '-B', replayBranch, base]);
  } catch {
    logger.write(`Base commit not in clone; deleting replay branch ${replayBranch}`, 'Warn');
    try {
      runGit(destinationPath, ['branch', '-D', replayBranch]);
    } catch {
      // Branch may not exist.
    }
  }

  for (const branchName of [
    config.Destination.Branches.CursorPorts,
    config.Destination.Branches.CursorPortsMingw
  ]) {
    try {
      runGit(destinationPath, ['branch', '-D', branchName]);
    } catch {
      // Branch may not exist.
    }
  }
}

export function pushDestinationBranches(
  destinationPath: string,
  config: SyncConfig,
  forceReplayBranch: boolean
): void {
  const replayBranch = config.Destination.Branches.Replay;
  runGit(destinationPath, ['push', 'origin', ...(forceReplayBranch ? ['--force'] : []), replayBranch]);

  for (const branchName of [
    config.Destination.Branches.CursorPorts,
    config.Destination.Branches.CursorPortsMingw
  ]) {
    const sha = getDestinationBranchSha(destinationPath, branchName);
    if (sha) {
      runGit(destinationPath, ['push', 'origin', branchName]);
    } else {
      runGit(destinationPath, ['push', 'origin', '--delete', branchName]);
    }
  }
}
