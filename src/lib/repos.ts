import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  copyFileSync,
  readFileSync,
  rmSync
} from 'node:fs';
import { join } from 'node:path';

import {
  getDestinationCloneUrl,
  getMirrorCloneUrlByRepoName,
  getMirrorCloneUrlForSource,
  getSyncRepoRoot,
  type SourceConfigEntry,
  type SyncConfig
} from './config.ts';
import { parseReplayCommitSourceSha, getFirstParent } from './replay.ts';
import { runGit, runGitText, testGitAncestor, githubSshPushUrl } from './git.ts';
import type { Logger } from './log.ts';

export const MIRROR_SYNC_BRANCH = 'msys2-apiss-mirror-sync';

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
  logger: Logger,
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
  const githubDir = join(mirrorPath, '.github');
  if (!existsSync(githubDir)) {
    throw new Error(
      `${mirrorPath}: no .github on ${MIRROR_SYNC_BRANCH}. Apply mirror-sync templates before repair.`
    );
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
  logger: Logger
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

function fetchOriginBranchOptional(
  mirrorPath: string,
  branch: string,
  logger: Logger
): void {
  try {
    runGit(
      mirrorPath,
      ['fetch', 'origin', `${branch}:refs/remotes/origin/${branch}`],
      {},
      5,
      logger
    );
  } catch {
    // Remote branch may not exist.
  }
}

function fetchOriginMirrorSyncRefs(
  mirrorPath: string,
  contentBranch: string,
  logger: Logger
): void {
  fetchOriginBranchOptional(mirrorPath, MIRROR_SYNC_BRANCH, logger);
  fetchOriginBranchOptional(mirrorPath, contentBranch, logger);
}

function bootstrapLocalMirrorSyncBranch(
  mirrorPath: string,
  contentBranch: string,
  logger: Logger
): void {
  const originContent = `origin/${contentBranch}`;
  if (!refExists(mirrorPath, originContent)) {
    throw new Error(
      `${mirrorPath}: cannot bootstrap ${MIRROR_SYNC_BRANCH}; missing ${originContent}`
    );
  }
  const root = firstCommitOfBranch(mirrorPath, originContent);
  logger.write(
    `Bootstrapping local ${MIRROR_SYNC_BRANCH} from first commit of ${originContent} ` +
      `(${root.slice(0, 8)})`
  );
  runGit(mirrorPath, ['checkout', '-B', MIRROR_SYNC_BRANCH, root], {}, 5, logger);
}

function checkoutMirrorSyncBranch(
  mirrorPath: string,
  contentBranch: string,
  logger: Logger,
  autoRepair = true
): void {
  fetchOriginMirrorSyncRefs(mirrorPath, contentBranch, logger);
  const originSync = `origin/${MIRROR_SYNC_BRANCH}`;
  let bootstrapped = false;
  if (refExists(mirrorPath, originSync)) {
    runGit(mirrorPath, ['checkout', '-B', MIRROR_SYNC_BRANCH, originSync], {}, 5, logger);
  } else {
    bootstrapLocalMirrorSyncBranch(mirrorPath, contentBranch, logger);
    bootstrapped = true;
  }
  if (bootstrapped) {
    return;
  }
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

export function mirrorOriginHasContent(originUrl: string, contentBranch: string): boolean {
  return (
    remoteHasGitBranch(originUrl, contentBranch) ||
    remoteHasGitBranch(originUrl, MIRROR_SYNC_BRANCH)
  );
}

function isMirrorWorkingCopyBroken(mirrorPath: string): boolean {
  if (!existsSync(mirrorPath)) {
    return false;
  }
  if (!existsSync(join(mirrorPath, '.git'))) {
    return true;
  }
  try {
    assertWorkingCopyMirror(mirrorPath);
  } catch {
    return true;
  }
  if (!refExists(mirrorPath, 'HEAD')) {
    return true;
  }
  return false;
}

function loadMirrorUpstreamUrl(config: SyncConfig, repoName: string, repoRoot: string): string | null {
  const configPath = getMirrorSyncConfigPath(repoRoot, repoName);
  if (existsSync(configPath)) {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as { UpstreamUrl?: string };
    if (parsed.UpstreamUrl) {
      return parsed.UpstreamUrl;
    }
  }
  return null;
}

export function bootstrapMirrorFromUpstreamRoot(input: {
  UpstreamUrl: string;
  OriginUrl: string;
  MirrorPath: string;
  ContentBranch: string;
  RepoName: string;
  Logger: Logger;
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
  Logger: Logger;
}): void {
  input.Logger.write(`Cloning mirror working copy ${input.Label} (${input.Url})`);
  runGit(null, ['clone', input.Url, input.MirrorPath], {}, 5, input.Logger);
  checkoutMirrorSyncBranch(input.MirrorPath, input.ContentBranch, input.Logger);
}

function fetchMirrorWorkingCopy(
  mirrorPath: string,
  contentBranch: string,
  label: string,
  logger: Logger
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
  Logger: Logger;
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

function ensureGithubSshPushUrl(mirrorPath: string, logger: Logger): void {
  let originUrl: string;
  try {
    originUrl = runGitText(mirrorPath, ['remote', 'get-url', 'origin']).trim();
  } catch {
    return;
  }
  const sshUrl = githubSshPushUrl(originUrl);
  if (!sshUrl) {
    return;
  }
  let pushUrl = originUrl;
  try {
    pushUrl = runGitText(mirrorPath, ['remote', 'get-url', '--push', 'origin']).trim();
  } catch {
    // no separate push URL yet
  }
  if (pushUrl === sshUrl) {
    return;
  }
  runGit(mirrorPath, ['remote', 'set-url', '--push', 'origin', sshUrl], {}, 5, logger);
  logger.write(`origin push URL: ${sshUrl}`);
}

function mirrorPushViaSsh(mirrorPath: string): boolean {
  const configPath = join(mirrorPath, '.github', 'mirror-sync.json');
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as { PushViaSsh?: boolean };
    return parsed.PushViaSsh === true;
  } catch {
    return false;
  }
}

function maybeEnsureGithubSshPushUrl(mirrorPath: string, logger: Logger): void {
  if (mirrorPushViaSsh(mirrorPath)) {
    ensureGithubSshPushUrl(mirrorPath, logger);
  }
}

export function pushMirrorContentBranch(
  mirrorPath: string,
  contentBranch: string,
  repoName: string,
  logger: Logger
): boolean {
  if (!refExists(mirrorPath, contentBranch)) {
    return false;
  }
  try {
    runGit(mirrorPath, ['fetch', 'origin', '--prune'], {}, 5, logger);
  } catch {
    // Empty origin during bootstrap may have nothing to fetch.
  }
  const originRef = `origin/${contentBranch}`;
  const originSha = refExists(mirrorPath, originRef)
    ? runGitText(mirrorPath, ['rev-parse', originRef]).trim()
    : null;
  const pushSha = runGitText(mirrorPath, ['rev-parse', contentBranch]).trim();
  const originUrl = runGitText(mirrorPath, ['remote', 'get-url', 'origin']).trim();
  const remoteSha = remoteGitBranchSha(originUrl, contentBranch);
  if (remoteSha !== null && originSha === remoteSha) {
    logger.write(`${repoName}: ${contentBranch} already on origin`);
    return false;
  }
  if (remoteSha === pushSha) {
    logger.write(`${repoName}: ${contentBranch} already on origin`);
    return false;
  }
  if (remoteSha === null) {
    maybeEnsureGithubSshPushUrl(mirrorPath, logger);
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
  if (testGitAncestor(mirrorPath, pushSha, remoteSha)) {
    logger.write(`${repoName}: remote ${contentBranch} ahead of local; skip content push`);
    return false;
  }
  if (testGitAncestor(mirrorPath, remoteSha, pushSha)) {
    maybeEnsureGithubSshPushUrl(mirrorPath, logger);
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
  logger.write(`${repoName}: ${contentBranch} diverges from origin; skip content push`, 'Warn');
  return false;
}

export function pushMirrorSyncBranch(
  mirrorPath: string,
  repoName: string,
  logger: Logger
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
  maybeEnsureGithubSshPushUrl(mirrorPath, logger);
  runGit(mirrorPath, ['push', '--force-with-lease', 'origin', MIRROR_SYNC_BRANCH], {}, 5, logger);
  logger.write(`Pushed ${MIRROR_SYNC_BRANCH} to origin for ${repoName}`);
  return true;
}

function finishMirrorWorkingCopy(input: {
  MirrorPath: string;
  RepoName: string;
  ContentBranch: string;
  Logger: Logger;
}): void {
  if (!refExists(input.MirrorPath, MIRROR_SYNC_BRANCH)) {
    return;
  }
  applyMirrorSyncTemplate(input);
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
  const contentBranch = input.Source.Branch;

  if (!existsSync(mirrorPath)) {
    cloneMirrorWorkingCopy({
      Url: url,
      MirrorPath: mirrorPath,
      ContentBranch: contentBranch,
      Label: input.Source.SortKey,
      Logger: input.Logger
    });
    setGitRepoUtf8Encoding(mirrorPath);
  } else if (!input.SkipFetch) {
    fetchMirrorWorkingCopy(mirrorPath, contentBranch, input.Source.SortKey, input.Logger);
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
    RepoName: input.Source.Repo,
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
  Logger: Logger;
}): string {
  const mirrorRoot = join(input.WorkDirectory, 'mirrors');
  mkdirSync(mirrorRoot, { recursive: true });

  const mirrorPath = join(mirrorRoot, input.RepoName);
  const url = getMirrorCloneUrlByRepoName(input.Config, input.RepoName);
  const repoRoot = getSyncRepoRoot();

  if (isMirrorWorkingCopyBroken(mirrorPath)) {
    input.Logger.write(
      `${input.RepoName}: invalid local mirror (not a git working copy); re-initializing`,
      'Warn'
    );
    rmSync(mirrorPath, { recursive: true, force: true });
  }

  if (!existsSync(mirrorPath)) {
    if (mirrorOriginHasContent(url, input.ContentBranch)) {
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
      input.Logger.write(
        `${input.RepoName}: initializing mirror (upstream root only, origin empty on GitHub)`
      );
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
    if (mirrorOriginHasContent(url, input.ContentBranch)) {
      fetchMirrorWorkingCopy(mirrorPath, input.ContentBranch, input.RepoName, input.Logger);
    } else {
      input.Logger.write(`${input.RepoName}: origin empty on GitHub; using local working copy`);
      assertWorkingCopyMirror(mirrorPath);
      runGit(mirrorPath, ['checkout', MIRROR_SYNC_BRANCH], {}, 5, input.Logger);
    }
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
  Logger: Logger;
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
  logger: Logger
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

export function resolveUpstreamCursorSha(
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
