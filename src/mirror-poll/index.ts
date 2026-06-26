import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Logger } from '../git/log.ts';
import { GITHUB_API, MIRROR_SYNC_BRANCH, WORKFLOW_DISPATCH_MIRROR_SYNC } from '../types/constants.ts';
import type { MirrorSyncConfig } from '../types/mirror-sync-config.ts';

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

function getGitHubToken(): string {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN or GH_TOKEN is required');
  }
  return token;
}

async function githubFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${getGitHubToken()}`);
  headers.set('Accept', 'application/vnd.github+json');
  headers.set('X-GitHub-Api-Version', '2022-11-28');
  return fetch(`${GITHUB_API}${path}`, { ...init, headers });
}

async function fetchBranchSha(owner: string, repo: string, branch: string): Promise<string | null> {
  const response = await githubFetch(
    `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} for ${owner}/${repo}@${branch}`);
  }
  const body = (await response.json()) as { commit?: { sha?: string } };
  return body.commit?.sha ?? null;
}

async function dispatchMirrorSync(owner: string, repo: string, logger: Logger): Promise<void> {
  const response = await githubFetch(
    `/repos/${owner}/${repo}/actions/workflows/mirror-sync.yml/dispatches`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ref: MIRROR_SYNC_BRANCH,
        inputs: {
          event_type: WORKFLOW_DISPATCH_MIRROR_SYNC
        }
      })
    }
  );
  if (!response.ok) {
    throw new Error(`${WORKFLOW_DISPATCH_MIRROR_SYNC} failed for ${owner}/${repo} (${response.status})`);
  }
  logger.write(`dispatched ${owner}/${repo}`);
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

export async function runMirrorPoll(): Promise<void> {
  process.env.LANG = 'C.UTF-8';
  process.env.LC_ALL = 'C.UTF-8';

  getGitHubToken();

  const logger = createLogger();
  const repoRoot = getSyncRepoRoot();
  const config = loadSyncConfig(repoRoot);
  const mirrorOwner = config.Owner;

  logger.write('start');

  for (const repo of getMirrorPollRepoNames(config)) {
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
    await dispatchMirrorSync(mirrorOwner, repo, logger);
  }

  logger.write('done');
}

export async function runMirrorPollCli(): Promise<void> {
  const logger = createLogger();
  try {
    await runMirrorPoll();
  } catch (error) {
    logger.write(error instanceof Error ? error.message : String(error), 'Error');
    process.exitCode = 1;
  }
}
