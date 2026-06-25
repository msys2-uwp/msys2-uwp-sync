import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SourceKey } from '../types/replay-entry.ts';
import {
  getDestinationCloneUrl,
  getMirrorCloneUrl,
  getMirrorCloneUrlByRepoName,
  getMirrorOnlyEntryForRepo,
  getSourceConfigEntry,
  getSourceRepoSlug,
  getSyncRepoRoot,
  type SyncConfig
} from './config.ts';
import { parseReplayCommitSourceSha, getFirstParent } from './replay.ts';
import { runGit, runGitText } from './git.ts';
import type { SyncLogger } from './log.ts';

export const MIRROR_SYNC_BRANCH = 'sync';

export const MIRROR_SYNC_COMMIT_MESSAGE =
  'Mirror sync workflow from msys2-apiss-sync\n\n' +
  'https://github.com/msys2-apiss/msys2-apiss-sync/tree/main/config/mirror-sync\n' +
  'https://github.com/msys2-apiss/msys2-apiss-sync/blob/main/config/mirror-template/mirror-sync.yml';

function commitTreeWithMessage(
  mirrorPath: string,
  treeSha: string,
  parent: string,
  message: string
): string {
  const lines = message.split('\n');
  const subject = lines[0] ?? message;
  const body = lines.slice(1).join('\n').trim();
  const args = ['commit-tree', treeSha, '-p', parent, '-m', subject];
  if (body) {
    args.push('-m', body);
  }
  return runGitText(mirrorPath, args).trim();
}

function refExists(mirrorPath: string, ref: string): boolean {
  try {
    runGitText(mirrorPath, ['rev-parse', '--verify', ref]);
    return true;
  } catch {
    return false;
  }
}

function firstCommitOfBranch(mirrorPath: string, branch: string): string {
  const raw = runGitText(mirrorPath, ['rev-list', '--max-parents=0', branch]).trim();
  const first = raw.split('\n')[0]?.trim();
  if (!first) {
    throw new Error(`Could not resolve first commit of ${branch} in ${mirrorPath}`);
  }
  return first;
}

function isSyncBranchLayoutValid(mirrorPath: string, contentBranch: string): boolean {
  const originContent = `origin/${contentBranch}`;
  if (!refExists(mirrorPath, originContent) || !refExists(mirrorPath, MIRROR_SYNC_BRANCH)) {
    return false;
  }
  const root = firstCommitOfBranch(mirrorPath, originContent);
  const syncOnlyCount = runGitText(mirrorPath, [
    'rev-list',
    '--count',
    MIRROR_SYNC_BRANCH,
    `^${originContent}`
  ]).trim();
  if (syncOnlyCount !== '1') {
    return false;
  }
  const syncParent = getFirstParent(mirrorPath, MIRROR_SYNC_BRANCH);
  return syncParent === root;
}

export function repairSyncBranchLayout(
  mirrorPath: string,
  contentBranch: string,
  logger: SyncLogger,
  options?: { CommitMessage?: string; Force?: boolean; SkipCheckout?: boolean }
): boolean {
  assertWorkingCopyMirror(mirrorPath);
  const originContent = `origin/${contentBranch}`;
  if (!refExists(mirrorPath, originContent)) {
    throw new Error(`Cannot repair ${MIRROR_SYNC_BRANCH}: missing ${originContent}`);
  }
  if (!options?.Force && isSyncBranchLayoutValid(mirrorPath, contentBranch)) {
    return false;
  }

  if (!options?.SkipCheckout) {
    runGit(mirrorPath, ['checkout', MIRROR_SYNC_BRANCH], {}, 5, logger);
  }
  runGit(mirrorPath, ['add', '-A', '.github'], {}, 5, logger);
  let githubSubTree: string;
  try {
    githubSubTree = runGitText(mirrorPath, ['write-tree', '--prefix=.github']).trim();
  } catch {
    const commitWithGithub = runGitText(mirrorPath, [
      'log',
      MIRROR_SYNC_BRANCH,
      '--format=%H',
      '-1',
      '--',
      '.github'
    ]).trim();
    if (!commitWithGithub) {
      throw new Error(
        `${mirrorPath}: no .github on ${MIRROR_SYNC_BRANCH}. Copy config/mirror-sync/ before repair.`
      );
    }
    githubSubTree = runGitText(mirrorPath, ['rev-parse', `${commitWithGithub}:.github`]).trim();
  }

  const root = firstCommitOfBranch(mirrorPath, originContent);
  const message = options?.CommitMessage ?? MIRROR_SYNC_COMMIT_MESSAGE;

  runGit(mirrorPath, ['read-tree', root], {}, 5, logger);
  runGit(mirrorPath, ['read-tree', '--prefix=.github', githubSubTree], {}, 5, logger);
  const treeSha = runGitText(mirrorPath, ['write-tree']).trim();
  const newCommit = commitTreeWithMessage(mirrorPath, treeSha, root, message);
  runGit(mirrorPath, ['clean', '-fd'], {}, 5, logger);
  runGit(mirrorPath, ['checkout', '-B', MIRROR_SYNC_BRANCH, newCommit], {}, 5, logger);
  logger.write(
    `Repaired ${MIRROR_SYNC_BRANCH} at ${newCommit.slice(0, 8)} (parent ${root.slice(0, 8)})`
  );
  return true;
}

function validateSyncBranchLayout(
  mirrorPath: string,
  contentBranch: string,
  logger: SyncLogger
): void {
  const originContent = `origin/${contentBranch}`;
  if (!refExists(mirrorPath, originContent)) {
    logger.write(`No ${originContent} yet; skip ${MIRROR_SYNC_BRANCH} layout check`, 'Warn');
    return;
  }
  if (isSyncBranchLayoutValid(mirrorPath, contentBranch)) {
    return;
  }
  const root = firstCommitOfBranch(mirrorPath, originContent);
  const syncOnlyCount = runGitText(mirrorPath, [
    'rev-list',
    '--count',
    MIRROR_SYNC_BRANCH,
    `^${originContent}`
  ]).trim();
  logger.write(
    `${MIRROR_SYNC_BRANCH} should have exactly one commit not on ${originContent}; ` +
      `found ${syncOnlyCount}. Squash on ${MIRROR_SYNC_BRANCH} before push.`,
    'Warn'
  );
  const syncParent = getFirstParent(mirrorPath, MIRROR_SYNC_BRANCH);
  logger.write(
    `${MIRROR_SYNC_BRANCH} parent should be first commit of ${originContent} (${root.slice(0, 8)}); ` +
      `got ${syncParent.slice(0, 8)}. Rebuild ${MIRROR_SYNC_BRANCH} per docs/add-mirror.md.`,
    'Warn'
  );
}

function checkoutMirrorSyncBranch(
  mirrorPath: string,
  contentBranch: string,
  logger: SyncLogger,
  autoRepair = true
): void {
  const originSync = `origin/${MIRROR_SYNC_BRANCH}`;
  if (!refExists(mirrorPath, originSync)) {
    throw new Error(
      `${mirrorPath}: missing ${originSync}. Bootstrap ${MIRROR_SYNC_BRANCH} per docs/add-mirror.md.`
    );
  }
  runGit(mirrorPath, ['checkout', '-B', MIRROR_SYNC_BRANCH, originSync], {}, 5, logger);
  if (autoRepair && !isSyncBranchLayoutValid(mirrorPath, contentBranch)) {
    logger.write(`Repairing ${MIRROR_SYNC_BRANCH} layout`, 'Warn');
    repairSyncBranchLayout(mirrorPath, contentBranch, logger);
  } else {
    validateSyncBranchLayout(mirrorPath, contentBranch, logger);
  }
}

function assertWorkingCopyMirror(mirrorPath: string): void {
  const resolved = realpathSync(mirrorPath);
  const bareObjects = join(resolved, 'objects');
  const gitDir = join(resolved, '.git');
  if (existsSync(bareObjects) && !existsSync(gitDir)) {
    throw new Error(
      `${mirrorPath} is a bare clone. Remove the directory and re-run yarn fetch-mirrors ` +
        'for a working copy under .work/mirrors/.'
    );
  }
}

function mirrorGitObjectsPath(mirrorPath: string): string {
  assertWorkingCopyMirror(mirrorPath);
  return join(realpathSync(mirrorPath), '.git', 'objects');
}

function remoteHasGitBranch(url: string, branch: string): boolean {
  try {
    const out = execSync(`git ls-remote "${url}" "refs/heads/${branch}"`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

function loadMirrorUpstreamUrl(config: SyncConfig, repoName: string, repoRoot: string): string | null {
  const configPath = getMirrorSyncConfigPath(repoRoot, repoName);
  if (existsSync(configPath)) {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as { UpstreamUrl?: string };
    if (parsed.UpstreamUrl) {
      return parsed.UpstreamUrl;
    }
  }
  return getMirrorOnlyEntryForRepo(config, repoName)?.UpstreamUrl ?? null;
}

export function bootstrapMirrorFromUpstreamRoot(input: {
  UpstreamUrl: string;
  OriginUrl: string;
  MirrorPath: string;
  ContentBranch: string;
  RepoName: string;
  Logger: SyncLogger;
}): void {
  input.Logger.write(
    `Bootstrapping ${input.RepoName}: fetch upstream ${input.ContentBranch} commit graph ` +
      '(blob:none), checkout root only'
  );
  runGit(null, ['init', input.MirrorPath], {}, 5, input.Logger);
  runGit(input.MirrorPath, ['remote', 'add', 'upstream', input.UpstreamUrl], {}, 5, input.Logger);
  runGit(input.MirrorPath, ['remote', 'add', 'origin', input.OriginUrl], {}, 5, input.Logger);
  runGit(
    input.MirrorPath,
    [
      'fetch',
      '--filter=blob:none',
      'upstream',
      `refs/heads/${input.ContentBranch}:refs/remotes/upstream/${input.ContentBranch}`
    ],
    {},
    5,
    input.Logger
  );
  const upstreamRef = `upstream/${input.ContentBranch}`;
  const root = firstCommitOfBranch(input.MirrorPath, upstreamRef);
  runGit(input.MirrorPath, ['checkout', '-B', input.ContentBranch, root], {}, 5, input.Logger);
  runGit(
    input.MirrorPath,
    ['update-ref', `refs/remotes/origin/${input.ContentBranch}`, root],
    {},
    5,
    input.Logger
  );
  runGit(input.MirrorPath, ['checkout', '-B', MIRROR_SYNC_BRANCH, root], {}, 5, input.Logger);
  input.Logger.write(
    `${input.RepoName}: content root ${root.slice(0, 8)} on ${input.ContentBranch}, ${MIRROR_SYNC_BRANCH} ready`
  );
}

function cloneMirrorWorkingCopy(input: {
  Url: string;
  MirrorPath: string;
  ContentBranch: string;
  Label: string;
  Logger: SyncLogger;
}): void {
  input.Logger.write(`Cloning mirror working copy ${input.Label} (${input.Url})`);
  runGit(null, ['clone', input.Url, input.MirrorPath], {}, 5, input.Logger);
  checkoutMirrorSyncBranch(input.MirrorPath, input.ContentBranch, input.Logger);
}

function fetchMirrorWorkingCopy(
  mirrorPath: string,
  contentBranch: string,
  label: string,
  logger: SyncLogger
): void {
  assertWorkingCopyMirror(mirrorPath);
  logger.write(`Fetching mirror working copy ${label}`);
  runGit(mirrorPath, ['fetch', 'origin', '--prune'], {}, 5, logger);
  checkoutMirrorSyncBranch(mirrorPath, contentBranch, logger);
}

export function getMirrorSyncConfigPath(repoRoot: string, repoName: string): string {
  return join(repoRoot, 'config', 'mirror-sync', `${repoName}.json`);
}

export function getMirrorSyncWorkflowTemplatePath(repoRoot: string): string {
  return join(repoRoot, 'config', 'mirror-template', 'mirror-sync.yml');
}

function normalizeText(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

function jsonFilesEqual(pathA: string, pathB: string): boolean {
  const a = JSON.parse(readFileSync(pathA, 'utf8')) as unknown;
  const b = JSON.parse(readFileSync(pathB, 'utf8')) as unknown;
  return JSON.stringify(a) === JSON.stringify(b);
}

function textFilesEqual(pathA: string, pathB: string): boolean {
  return normalizeText(readFileSync(pathA, 'utf8')) === normalizeText(readFileSync(pathB, 'utf8'));
}

function mirrorSyncFilesMatchTemplates(
  mirrorPath: string,
  repoRoot: string,
  repoName: string
): boolean {
  const configPath = getMirrorSyncConfigPath(repoRoot, repoName);
  const workflowPath = getMirrorSyncWorkflowTemplatePath(repoRoot);
  const mirrorJson = join(mirrorPath, '.github', 'mirror-sync.json');
  const mirrorYml = join(mirrorPath, '.github', 'workflows', 'mirror-sync.yml');
  if (!existsSync(mirrorJson) || !existsSync(mirrorYml)) {
    return false;
  }
  return jsonFilesEqual(mirrorJson, configPath) && textFilesEqual(mirrorYml, workflowPath);
}

export function applyMirrorSyncTemplate(input: {
  MirrorPath: string;
  RepoName: string;
  ContentBranch: string;
  Logger: SyncLogger;
  RepoRoot?: string;
}): boolean {
  const repoRoot = input.RepoRoot ?? getSyncRepoRoot();
  const configPath = getMirrorSyncConfigPath(repoRoot, input.RepoName);
  const workflowPath = getMirrorSyncWorkflowTemplatePath(repoRoot);

  if (!existsSync(configPath)) {
    input.Logger.write(`No config/mirror-sync/${input.RepoName}.json template`, 'Warn');
    return false;
  }
  if (!existsSync(workflowPath)) {
    throw new Error(`Missing mirror workflow template: ${workflowPath}`);
  }

  if (!refExists(input.MirrorPath, MIRROR_SYNC_BRANCH)) {
    return false;
  }

  runGit(input.MirrorPath, ['checkout', MIRROR_SYNC_BRANCH], {}, 5, input.Logger);

  const filesInSync = mirrorSyncFilesMatchTemplates(input.MirrorPath, repoRoot, input.RepoName);
  const layoutValid = isSyncBranchLayoutValid(input.MirrorPath, input.ContentBranch);

  if (filesInSync && layoutValid) {
    input.Logger.write(`${input.RepoName}: ${MIRROR_SYNC_BRANCH} templates already in sync`);
    return false;
  }

  if (!filesInSync) {
    const githubDir = join(input.MirrorPath, '.github');
    const workflowsDir = join(githubDir, 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    copyFileSync(configPath, join(githubDir, 'mirror-sync.json'));
    copyFileSync(workflowPath, join(workflowsDir, 'mirror-sync.yml'));
    input.Logger.write(`Applied config/mirror-sync/${input.RepoName}.json to ${input.MirrorPath}`);
  } else {
    input.Logger.write(`Repairing ${input.RepoName} ${MIRROR_SYNC_BRANCH} layout`, 'Warn');
  }

  repairSyncBranchLayout(input.MirrorPath, input.ContentBranch, input.Logger, {
    Force: true,
    SkipCheckout: true
  });
  return true;
}

function remoteGitBranchSha(url: string, branch: string): string | null {
  try {
    const out = execSync(`git ls-remote "${url}" "refs/heads/${branch}"`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
    if (!out) {
      return null;
    }
    return out.split(/\s+/)[0] ?? null;
  } catch {
    return null;
  }
}

export function pushMirrorContentBranch(
  mirrorPath: string,
  contentBranch: string,
  repoName: string,
  logger: SyncLogger
): boolean {
  if (!refExists(mirrorPath, contentBranch)) {
    return false;
  }
  const local = runGitText(mirrorPath, ['rev-parse', contentBranch]).trim();
  const originUrl = runGitText(mirrorPath, ['remote', 'get-url', 'origin']).trim();
  const remote = remoteGitBranchSha(originUrl, contentBranch);
  if (remote === local) {
    logger.write(`${repoName}: ${contentBranch} already on origin`);
    return false;
  }
  runGit(
    mirrorPath,
    ['push', '-u', 'origin', `${contentBranch}:${contentBranch}`],
    {},
    5,
    logger
  );
  logger.write(`Pushed ${contentBranch} to origin for ${repoName}`);
  return true;
}

export function pushMirrorSyncBranch(
  mirrorPath: string,
  repoName: string,
  logger: SyncLogger
): boolean {
  if (!refExists(mirrorPath, MIRROR_SYNC_BRANCH)) {
    return false;
  }
  const originSync = `origin/${MIRROR_SYNC_BRANCH}`;
  if (refExists(mirrorPath, originSync)) {
    const local = runGitText(mirrorPath, ['rev-parse', MIRROR_SYNC_BRANCH]).trim();
    const remote = runGitText(mirrorPath, ['rev-parse', originSync]).trim();
    if (local === remote) {
      logger.write(`${repoName}: ${MIRROR_SYNC_BRANCH} already on origin`);
      return false;
    }
  }
  runGit(mirrorPath, ['push', '--force-with-lease', 'origin', MIRROR_SYNC_BRANCH], {}, 5, logger);
  logger.write(`Pushed ${MIRROR_SYNC_BRANCH} to origin for ${repoName}`);
  return true;
}

function finishMirrorWorkingCopy(input: {
  MirrorPath: string;
  RepoName: string;
  ContentBranch: string;
  Logger: SyncLogger;
}): void {
  if (!refExists(input.MirrorPath, MIRROR_SYNC_BRANCH)) {
    return;
  }
  applyMirrorSyncTemplate(input);
}

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
  const contentBranch = sourceEntry.Branch;

  if (!existsSync(mirrorPath)) {
    cloneMirrorWorkingCopy({
      Url: url,
      MirrorPath: mirrorPath,
      ContentBranch: contentBranch,
      Label: input.SourceKey,
      Logger: input.Logger
    });
    setGitRepoUtf8Encoding(mirrorPath);
  } else if (!input.SkipFetch) {
    fetchMirrorWorkingCopy(mirrorPath, contentBranch, input.SourceKey, input.Logger);
  } else {
    assertWorkingCopyMirror(mirrorPath);
    if (refExists(mirrorPath, MIRROR_SYNC_BRANCH)) {
      runGit(mirrorPath, ['checkout', MIRROR_SYNC_BRANCH], {}, 5, input.Logger);
    } else {
      checkoutMirrorSyncBranch(mirrorPath, contentBranch, input.Logger);
    }
  }

  finishMirrorWorkingCopy({
    MirrorPath: mirrorPath,
    RepoName: sourceEntry.Repo,
    ContentBranch: contentBranch,
    Logger: input.Logger
  });

  setGitRepoUtf8Encoding(mirrorPath);
  return mirrorPath;
}

export function initializeNamedMirrorRepository(input: {
  WorkDirectory: string;
  RepoName: string;
  ContentBranch: string;
  Config: SyncConfig;
  SkipFetch: boolean;
  Logger: SyncLogger;
}): string {
  const mirrorRoot = join(input.WorkDirectory, 'mirrors');
  mkdirSync(mirrorRoot, { recursive: true });

  const mirrorPath = join(mirrorRoot, input.RepoName);
  const url = getMirrorCloneUrlByRepoName(input.Config, input.RepoName);
  const repoRoot = getSyncRepoRoot();

  if (!existsSync(mirrorPath)) {
    const hasOriginBranch =
      remoteHasGitBranch(url, input.ContentBranch) ||
      remoteHasGitBranch(url, MIRROR_SYNC_BRANCH);
    if (hasOriginBranch) {
      cloneMirrorWorkingCopy({
        Url: url,
        MirrorPath: mirrorPath,
        ContentBranch: input.ContentBranch,
        Label: input.RepoName,
        Logger: input.Logger
      });
    } else {
      const upstreamUrl = loadMirrorUpstreamUrl(input.Config, input.RepoName, repoRoot);
      if (!upstreamUrl) {
        throw new Error(
          `${input.RepoName}: empty origin and no UpstreamUrl; add config/mirror-sync/${input.RepoName}.json`
        );
      }
      bootstrapMirrorFromUpstreamRoot({
        UpstreamUrl: upstreamUrl,
        OriginUrl: url,
        MirrorPath: mirrorPath,
        ContentBranch: input.ContentBranch,
        RepoName: input.RepoName,
        Logger: input.Logger
      });
    }
    setGitRepoUtf8Encoding(mirrorPath);
  } else if (!input.SkipFetch) {
    fetchMirrorWorkingCopy(mirrorPath, input.ContentBranch, input.RepoName, input.Logger);
  } else {
    assertWorkingCopyMirror(mirrorPath);
    if (refExists(mirrorPath, MIRROR_SYNC_BRANCH)) {
      runGit(mirrorPath, ['checkout', MIRROR_SYNC_BRANCH], {}, 5, input.Logger);
    } else {
      checkoutMirrorSyncBranch(mirrorPath, input.ContentBranch, input.Logger);
    }
  }

  finishMirrorWorkingCopy({
    MirrorPath: mirrorPath,
    RepoName: input.RepoName,
    ContentBranch: input.ContentBranch,
    Logger: input.Logger
  });

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
    const destPath = realpathSync(input.DestinationPath);
    if (!input.SkipFetch) {
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
    .map((mirrorPath) => mirrorGitObjectsPath(mirrorPath))
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

export function prepareDestinationWorkingTree(destinationPath: string): void {
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

export function resolveDestinationBranchSha(destinationPath: string, branchName: string): string | null {
  return getLocalDestinationBranchSha(destinationPath, branchName)
    ?? getDestinationBranchSha(destinationPath, branchName);
}

export function checkoutNewDestinationBranchFromBase(
  destinationPath: string,
  branchName: string,
  baseBranchName: string,
  logger: SyncLogger
): string {
  const protectedNames = new Set([baseBranchName]);
  if (protectedNames.has(branchName)) {
    throw new Error(`--branch must not be ${baseBranchName}; use a new branch name`);
  }
  if (getLocalDestinationBranchSha(destinationPath, branchName)) {
    throw new Error(`Branch ${branchName} already exists locally; choose a new name or delete it`);
  }

  const baseSha = resolveDestinationBranchSha(destinationPath, baseBranchName);
  if (!baseSha) {
    throw new Error(`Missing base branch ${baseBranchName} in destination clone`);
  }

  prepareDestinationWorkingTree(destinationPath);
  runGit(destinationPath, ['checkout', '-b', branchName, baseSha]);
  runGit(destinationPath, ['reset', '--hard', 'HEAD']);
  logger.write(`Checked out new branch ${branchName} from ${baseBranchName} (${baseSha.slice(0, 8)})`);
  return baseSha;
}

export function setDestinationReplayCheckout(
  destinationPath: string,
  config: SyncConfig,
  isFullReplay: boolean
): void {
  const replayBranch = config.Destination.Branches.Replay;
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

/** Remote destination branch tip (origin/<branch> only). */
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

export function updateDestinationCursorBranchRefs(
  destinationPath: string,
  config: SyncConfig,
  input: {
    PortsDestSha: string | null;
    PortsMingwDestSha: string | null;
  }
): void {
  if (input.PortsDestSha) {
    setDestinationBranchSha(destinationPath, config.Destination.Branches.CursorPorts, input.PortsDestSha);
  }
  if (input.PortsMingwDestSha) {
    setDestinationBranchSha(destinationPath, config.Destination.Branches.CursorPortsMingw, input.PortsMingwDestSha);
  }
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
  updateDestinationCursorBranchRefs(destinationPath, config, {
    PortsDestSha: input.PortsDestSha,
    PortsMingwDestSha: input.PortsMingwDestSha
  });
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
    checkoutDestinationReplayBranch(destinationPath, replayBranch, base);
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
    try {
      runGit(destinationPath, ['update-ref', '-d', `refs/remotes/origin/${branchName}`]);
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
  const replayBranch = config.Destination.Branches.Replay;
  runGit(destinationPath, ['push', 'origin', ...(forceReplayBranch ? ['--force'] : []), replayBranch]);

  for (const branchName of [
    config.Destination.Branches.CursorPorts,
    config.Destination.Branches.CursorPortsMingw
  ]) {
    const sha = getLocalDestinationBranchSha(destinationPath, branchName);
    if (sha) {
      runGit(destinationPath, ['push', 'origin', branchName]);
    } else {
      runGit(destinationPath, ['push', 'origin', '--delete', branchName]);
    }
  }
}
