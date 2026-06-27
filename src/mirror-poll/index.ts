import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Logger } from '../git/log.ts';
import type { MirrorSyncConfig } from '../types/mirror-sync-config.ts';
import { ghDispatchMirrorBlock, ghGetBranchSha, MIRROR_SYNC_BLOCK, requireGhAuthenticated } from '../git/gh.ts';
import { printMirrorPollCliHelp, readStringOption, wantsHelp } from './args.ts';

export interface SyncConfig {
  Owner: string;
  Mirrors: {
    Repos: string[];
  };
}

export function getSyncRepoRoot(startPath = dirname(fileURLToPath(import.meta.url))): string {
  let current = startPath;
  while (true) {
    try {
      readFileSync(join(current, 'config', 'sync.json'), 'utf8');
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        throw new Error('Could not locate sync repo root (config/sync.json not found).');
      }
      current = parent;
    }
  }
}

export function loadSyncConfig(repoRoot = getSyncRepoRoot(), configPath?: string): SyncConfig {
  const path = configPath ?? join(repoRoot, 'config', 'sync.json');
  return JSON.parse(readFileSync(path, 'utf8')) as SyncConfig;
}

export function getMirrorPollRepoNames(config: SyncConfig): string[] {
  return config.Mirrors.Repos;
}

export function getMirrorSyncConfigPath(repoRoot: string, repoName: string): string {
  return join(repoRoot, 'config', 'mirror-sync', `${repoName}.json`);
}

export function loadMirrorSyncConfigFile(repoRoot: string, repoName: string): MirrorSyncConfig | null {
  const configPath = getMirrorSyncConfigPath(repoRoot, repoName);
  if (!existsSync(configPath)) {
    return null;
  }
  return JSON.parse(readFileSync(configPath, 'utf8')) as MirrorSyncConfig;
}

export function getMirrorContentBranch(repoRoot: string, repoName: string): string {
  const mirrorConfig = loadMirrorSyncConfigFile(repoRoot, repoName);
  const branch = mirrorConfig?.Branches?.[0]?.Mirror;
  if (!branch) {
    throw new Error(`config/mirror-sync/${repoName}.json: missing Branches[0].Mirror`);
  }
  return branch;
}

export function parseGitHubRepoFromUrl(url: string): { Owner: string; Repo: string } | null {
  const match = url.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/i);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return { Owner: match[1], Repo: match[2] };
}

function fetchBranchSha(owner: string, repo: string, branch: string): string | null {
  return ghGetBranchSha(owner, repo, branch);
}

function dispatchMirrorSync(
  owner: string,
  repo: string,
  contentBranch: string,
  logger: Logger
): void {
  ghDispatchMirrorBlock(MIRROR_SYNC_BLOCK, owner, repo, contentBranch, logger, {
    ForbiddenDetail:
      'gh token cannot dispatch mirror-sync on other repos; set secret ' +
      'SYNC_DISPATCH_TOKEN on msys2-apiss/msys2-apiss-sync ' +
      '(same PAT as package mirror repos; workflow scope on msys2-apiss/*)'
  });
}

function createLogger(): Logger {
  return {
    write(message, level = 'Info') {
      const prefix =
        level === 'Warn' ? '[mirror-poll][warn]' : level === 'Error' ? '[mirror-poll][error]' : '[mirror-poll]';
      console.log(`${prefix} ${message}`);
    },
    close() {}
  };
}

export async function mirrorRepoNeedsSync(input: {
  RepoName: string;
  MirrorOwner: string;
  MirrorConfig: MirrorSyncConfig | null;
  GetUpstreamSha?: (upstreamUrl: string, branch: string) => string | null | Promise<string | null>;
  GetMirrorSha?: (repo: string, branch: string) => string | null | Promise<string | null>;
}): Promise<boolean> {
  const getUpstreamSha =
    input.GetUpstreamSha ??
    (async (url, branch) => {
      const upstream = parseGitHubRepoFromUrl(url);
      if (!upstream) {
        return null;
      }
      return fetchBranchSha(upstream.Owner, upstream.Repo, branch);
    });
  const getMirrorSha =
    input.GetMirrorSha ??
    ((repo, branch) => fetchBranchSha(input.MirrorOwner, repo, branch));

  if (!input.MirrorConfig?.UpstreamUrl || !input.MirrorConfig.Branches?.length) {
    return true;
  }

  for (const entry of input.MirrorConfig.Branches) {
    const upstreamSha = await getUpstreamSha(input.MirrorConfig.UpstreamUrl, entry.Upstream);
    if (!upstreamSha) {
      return true;
    }
    const mirrorSha = await getMirrorSha(input.RepoName, entry.Mirror);
    if (!mirrorSha || mirrorSha !== upstreamSha) {
      return true;
    }
  }

  return false;
}

export async function runMirrorPoll(input: { RepoFilter?: string } = {}): Promise<void> {
  process.env.LANG = 'C.UTF-8';
  process.env.LC_ALL = 'C.UTF-8';

  requireGhAuthenticated();

  const logger = createLogger();
  const repoRoot = getSyncRepoRoot();
  const config = loadSyncConfig(repoRoot);
  const mirrorOwner = config.Owner;

  if (input.RepoFilter && !getMirrorPollRepoNames(config).includes(input.RepoFilter)) {
    throw new Error(`Unknown mirror repo: ${input.RepoFilter}`);
  }

  logger.write('start');

  let dispatchFailed = false;

  for (const repo of getMirrorPollRepoNames(config)) {
    if (input.RepoFilter && input.RepoFilter !== repo) {
      continue;
    }
    const mirrorConfig = loadMirrorSyncConfigFile(repoRoot, repo);
    if (!(await mirrorRepoNeedsSync({
      RepoName: repo,
      MirrorOwner: mirrorOwner,
      MirrorConfig: mirrorConfig
    }))) {
      logger.write(`${repo}: tips match`);
      continue;
    }
    logger.write(`${repo}: tips differ`);
    try {
      const contentBranch = getMirrorContentBranch(repoRoot, repo);
      dispatchMirrorSync(mirrorOwner, repo, contentBranch, logger);
    } catch (error) {
      dispatchFailed = true;
      logger.write(error instanceof Error ? error.message : String(error), 'Error');
    }
  }

  logger.write('done');
  if (dispatchFailed) {
    process.exitCode = 1;
  }
}

export async function runMirrorPollCli(): Promise<void> {
  const args = process.argv.slice(2);
  if (wantsHelp(args)) {
    printMirrorPollCliHelp();
    return;
  }

  const logger = createLogger();
  try {
    await runMirrorPoll({
      RepoFilter: readStringOption(args, '--repo')
    });
  } catch (error) {
    logger.write(error instanceof Error ? error.message : String(error), 'Error');
    process.exitCode = 1;
  }
}
