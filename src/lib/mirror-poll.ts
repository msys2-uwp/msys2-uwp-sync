import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import type { MirrorSyncConfig } from '../types/mirror-sync-config.ts';
import { getMirrorPollRepoNames, loadSyncConfig, type SyncConfig } from './config.ts';
import type { SyncLogger } from './log.ts';
import { getMirrorSyncConfigPath } from './repos.ts';

const GITHUB_API_VERSION = '2026-03-10';

export interface MirrorPollGitHub {
  getBranchSha(repo: string, branch: string): Promise<string | null>;
  dispatchMirrorSync(repo: string, contentBranch: string): Promise<void>;
}

export function loadMirrorSyncConfigFile(repoRoot: string, repoName: string): MirrorSyncConfig | null {
  const configPath = getMirrorSyncConfigPath(repoRoot, repoName);
  if (!existsSync(configPath)) {
    return null;
  }
  return JSON.parse(readFileSync(configPath, 'utf8')) as MirrorSyncConfig;
}

export function getUpstreamRefSha(upstreamUrl: string, branch: string, logger: SyncLogger): string | null {
  try {
    const out = execSync(`git ls-remote "${upstreamUrl}" "refs/heads/${branch}"`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
    if (!out) {
      return null;
    }
    return out.split(/\s+/)[0] ?? null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.write(`Could not read upstream ${upstreamUrl} ${branch}: ${message}; will dispatch`, 'Warn');
    return null;
  }
}

export async function mirrorRepoNeedsSync(input: {
  RepoName: string;
  MirrorConfig: MirrorSyncConfig | null;
  GitHub: MirrorPollGitHub;
  Logger: SyncLogger;
  GetUpstreamSha?: (upstreamUrl: string, branch: string) => string | null;
}): Promise<boolean> {
  const getUpstreamSha = input.GetUpstreamSha ?? ((url, branch) => getUpstreamRefSha(url, branch, input.Logger));

  if (!input.MirrorConfig) {
    input.Logger.write(`No config/mirror-sync/${input.RepoName}.json; dispatching ${input.RepoName}`, 'Warn');
    return true;
  }

  const { UpstreamUrl, Branches } = input.MirrorConfig;
  if (!UpstreamUrl || !Branches?.length) {
    input.Logger.write(`Invalid mirror-sync config for ${input.RepoName}; dispatching`, 'Warn');
    return true;
  }

  for (const entry of Branches) {
    const upstreamSha = getUpstreamSha(UpstreamUrl, entry.Upstream);
    if (!upstreamSha) {
      return true;
    }

    const mirrorSha = await input.GitHub.getBranchSha(input.RepoName, entry.Mirror);
    if (!mirrorSha) {
      input.Logger.write(
        `${input.RepoName}: missing mirror branch ${entry.Mirror}; dispatching mirror-sync`
      );
      return true;
    }
    if (mirrorSha !== upstreamSha) {
      input.Logger.write(
        `${input.RepoName}: ${entry.Mirror} ${mirrorSha.slice(0, 8)} != upstream ${upstreamSha.slice(0, 8)}`
      );
      return true;
    }
    input.Logger.write(`${input.RepoName}: ${entry.Mirror} matches upstream ${upstreamSha.slice(0, 8)}`);
  }

  return false;
}

class GitHubApiError extends Error {
  status: number;
  body: string;

  constructor(status: number, body: string) {
    super(`GitHub API ${status}: ${body}`);
    this.status = status;
    this.body = body;
  }
}

async function githubRequest<T>(
  token: string,
  path: string,
  init?: RequestInit
): Promise<T | undefined> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      ...(init?.headers ?? {})
    }
  });
  if (res.status === 404) {
    throw new GitHubApiError(404, await res.text());
  }
  if (!res.ok) {
    throw new GitHubApiError(res.status, await res.text());
  }
  if (res.status === 204) {
    return undefined;
  }
  return (await res.json()) as T;
}

async function mirrorSyncRunInProgress(
  token: string,
  owner: string,
  repo: string
): Promise<boolean> {
  const data = await githubRequest<{ workflow_runs: { status: string }[] }>(
    token,
    `/repos/${owner}/${repo}/actions/workflows/mirror-sync.yml/runs` +
      '?branch=sync&status=in_progress&per_page=1'
  );
  return (data?.workflow_runs.length ?? 0) > 0;
}

async function dispatchMirrorSyncWorkflow(
  token: string,
  owner: string,
  repo: string,
  logger?: SyncLogger
): Promise<boolean> {
  if (logger && (await mirrorSyncRunInProgress(token, owner, repo))) {
    logger.write(`Skip mirror-sync dispatch on ${owner}/${repo}: run already in progress`);
    return false;
  }
  await githubRequest(
    token,
    `/repos/${owner}/${repo}/actions/workflows/mirror-sync.yml/dispatches`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'sync' })
    }
  );
  return true;
}

async function dispatchWithRetry(
  token: string,
  owner: string,
  repo: string,
  contentBranch: string,
  logger: SyncLogger,
  maxAttempts = 4
): Promise<void> {
  let bootstrapped = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await dispatchMirrorSyncWorkflow(token, owner, repo, logger);
      return;
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404 && !bootstrapped) {
        bootstrapped = true;
        logger.write(`${repo}: mirror-sync not registered; bootstrapping workflow`, 'Warn');
        await bootstrapMirrorWorkflowIfNeeded({
          Owner: owner,
          RepoName: repo,
          ContentBranch: contentBranch,
          Token: token,
          Logger: logger,
          TriggerSync: false
        });
        continue;
      }
      if (error instanceof GitHubApiError && error.status === 404) {
        throw new Error(
          `${owner}/${repo}: mirror-sync.yml not found for workflow_dispatch after bootstrap. ` +
            `See docs/add-mirror.md. API: ${error.body}`
        );
      }
      const status = error instanceof GitHubApiError ? error.status : undefined;
      const retryable = status === undefined || status >= 500 || status === 429;
      if (!retryable || attempt === maxAttempts) {
        throw error;
      }
      const delayMs = 1000 * 2 ** (attempt - 1);
      logger.write(
        `Dispatch attempt ${attempt} failed (${status ?? 'unknown'}), retry in ${delayMs}ms`,
        'Warn'
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export function getMirrorAdminGitHubToken(): string | undefined {
  return process.env.MSYS2_APISS_SYNC_TOKEN ?? process.env.GITHUB_TOKEN;
}

export async function mirrorSyncWorkflowRegistered(
  token: string,
  owner: string,
  repoName: string
): Promise<boolean> {
  const data = await githubRequest<{ workflows: { path: string }[] }>(
    token,
    `/repos/${owner}/${repoName}/actions/workflows`
  );
  return data?.workflows.some((w) => w.path === '.github/workflows/mirror-sync.yml') ?? false;
}

async function getMirrorRepoDefaultBranch(
  token: string,
  owner: string,
  repoName: string
): Promise<string | null> {
  const repo = await githubRequest<{ default_branch: string }>(
    token,
    `/repos/${owner}/${repoName}`
  );
  return repo?.default_branch ?? null;
}

async function setMirrorRepoDefaultBranch(
  token: string,
  owner: string,
  repoName: string,
  branch: string,
  logger: SyncLogger
): Promise<void> {
  await githubRequest(token, `/repos/${owner}/${repoName}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ default_branch: branch })
  });
  logger.write(`Set ${repoName} default branch to ${branch}`);
}

async function waitForMirrorSyncWorkflowRegistered(
  token: string,
  owner: string,
  repoName: string,
  logger: SyncLogger,
  maxAttempts = 5
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (await mirrorSyncWorkflowRegistered(token, owner, repoName)) {
      return true;
    }
    if (attempt === maxAttempts) {
      return false;
    }
    const delayMs = 2000;
    logger.write(
      `${repoName}: waiting for mirror-sync workflow registration (${attempt}/${maxAttempts})`,
      'Warn'
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

async function waitForMirrorSyncWorkflowRun(input: {
  Token: string;
  Owner: string;
  RepoName: string;
  Logger: SyncLogger;
  TimeoutMs?: number;
}): Promise<void> {
  const timeoutMs = input.TimeoutMs ?? 6 * 60 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;
  const pollMs = 15_000;
  input.Logger.write(`Waiting for mirror-sync on ${input.RepoName} to finish`);
  let seenRunId: number | null = null;
  while (Date.now() < deadline) {
    const data = await githubRequest<{
      workflow_runs: { id: number; status: string; conclusion: string | null }[];
    }>(
      input.Token,
      `/repos/${input.Owner}/${input.RepoName}/actions/workflows/mirror-sync.yml/runs` +
        '?branch=sync&event=workflow_dispatch&per_page=1'
    );
    const run = data?.workflow_runs[0];
    if (run) {
      if (seenRunId !== run.id) {
        seenRunId = run.id;
        input.Logger.write(`${input.RepoName}: mirror-sync run ${run.id} (${run.status})`);
      }
      if (run.status === 'completed') {
        if (run.conclusion !== 'success') {
          throw new Error(`${input.RepoName}: mirror-sync run ${run.id} ${run.conclusion ?? 'failed'}`);
        }
        input.Logger.write(`${input.RepoName}: mirror-sync run ${run.id} completed`);
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`${input.RepoName}: timed out waiting for mirror-sync (${timeoutMs}ms)`);
}

export async function bootstrapMirrorWorkflowIfNeeded(input: {
  Owner: string;
  RepoName: string;
  ContentBranch: string;
  Token: string;
  Logger: SyncLogger;
  TriggerSync?: boolean;
  WaitForSync?: boolean;
}): Promise<void> {
  const registered = await mirrorSyncWorkflowRegistered(
    input.Token,
    input.Owner,
    input.RepoName
  );
  const currentDefault = await getMirrorRepoDefaultBranch(
    input.Token,
    input.Owner,
    input.RepoName
  );
  const contentBranch = input.ContentBranch;

  if (!registered) {
    input.Logger.write(
      `${input.RepoName}: registering mirror-sync (temporary default branch sync)`
    );
    if (currentDefault !== 'sync') {
      await setMirrorRepoDefaultBranch(
        input.Token,
        input.Owner,
        input.RepoName,
        'sync',
        input.Logger
      );
    }
    const ready = await waitForMirrorSyncWorkflowRegistered(
      input.Token,
      input.Owner,
      input.RepoName,
      input.Logger
    );
    if (!ready) {
      throw new Error(
        `${input.Owner}/${input.RepoName}: mirror-sync workflow did not register after ` +
          'setting default branch to sync'
      );
    }
    if (input.TriggerSync !== false) {
      const triggered = await dispatchMirrorSyncWorkflow(
        input.Token,
        input.Owner,
        input.RepoName,
        input.Logger
      );
      if (triggered) {
        input.Logger.write(`Triggered initial mirror-sync on ${input.Owner}/${input.RepoName}`);
      }
      if (triggered && input.WaitForSync !== false) {
        await waitForMirrorSyncWorkflowRun({
          Token: input.Token,
          Owner: input.Owner,
          RepoName: input.RepoName,
          Logger: input.Logger
        });
      }
    }
    if (contentBranch !== 'sync') {
      await setMirrorRepoDefaultBranch(
        input.Token,
        input.Owner,
        input.RepoName,
        contentBranch,
        input.Logger
      );
    }
    return;
  }

  if (currentDefault === 'sync' && contentBranch !== 'sync') {
    await setMirrorRepoDefaultBranch(
      input.Token,
      input.Owner,
      input.RepoName,
      contentBranch,
      input.Logger
    );
  }

  if (input.TriggerSync) {
    const triggered = await dispatchMirrorSyncWorkflow(
      input.Token,
      input.Owner,
      input.RepoName,
      input.Logger
    );
    if (triggered) {
      input.Logger.write(`Triggered mirror-sync on ${input.Owner}/${input.RepoName}`);
    }
  }
}

export async function bootstrapMirrorWorkflowIfToken(input: {
  Owner: string;
  RepoName: string;
  ContentBranch: string;
  Logger: SyncLogger;
  TriggerSync?: boolean;
  WaitForSync?: boolean;
}): Promise<void> {
  const token = getMirrorAdminGitHubToken();
  if (!token) {
    input.Logger.write(
      `No MSYS2_APISS_SYNC_TOKEN or GITHUB_TOKEN; bootstrap ${input.RepoName} manually ` +
        '(see docs/add-mirror.md)',
      'Warn'
    );
    return;
  }
  await bootstrapMirrorWorkflowIfNeeded({ ...input, Token: token });
}

export function createMirrorPollGitHub(token: string, owner: string, logger: SyncLogger): MirrorPollGitHub {
  return {
    async getBranchSha(repo, branch) {
      try {
        const data = await githubRequest<{ commit: { sha: string } }>(
          token,
          `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`
        );
        return data?.commit.sha ?? null;
      } catch (error) {
        if (error instanceof GitHubApiError && error.status === 404) {
          return null;
        }
        throw error;
      }
    },
    async dispatchMirrorSync(repo, contentBranch) {
      await dispatchWithRetry(token, owner, repo, contentBranch, logger);
    }
  };
}

export async function runMirrorPoll(input: {
  RepoRoot: string;
  Config: SyncConfig;
  MirrorOwner: string;
  GitHub: MirrorPollGitHub;
  Logger: SyncLogger;
}): Promise<void> {
  const mirrorOwner = input.MirrorOwner;
  for (const repo of getMirrorPollRepoNames(input.Config)) {
    const mirrorConfig = loadMirrorSyncConfigFile(input.RepoRoot, repo);
    const needsSync = await mirrorRepoNeedsSync({
      RepoName: repo,
      MirrorConfig: mirrorConfig,
      GitHub: input.GitHub,
      Logger: input.Logger
    });
    if (!needsSync) {
      input.Logger.write(`Skip mirror-sync on ${mirrorOwner}/${repo}: branch HEAD matches upstream`);
      continue;
    }
    const contentBranch = mirrorConfig?.Branches?.[0]?.Mirror ?? 'master';
    await input.GitHub.dispatchMirrorSync(repo, contentBranch);
    input.Logger.write(`Triggered mirror-sync on ${mirrorOwner}/${repo}`);
  }
}
