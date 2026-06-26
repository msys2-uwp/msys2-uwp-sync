import { spawnSync } from 'node:child_process';

import type { Logger } from './log.ts';
import { MIRROR_SYNC_BRANCH, WORKFLOW_DISPATCH_MIRROR_SYNC } from '../types/constants.ts';

function runGh(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim()
  };
}

export function ghCommandAvailable(): boolean {
  return runGh(['--version']).ok;
}

export function ghAuthenticated(): boolean {
  if (!ghCommandAvailable()) {
    return false;
  }
  return runGh(['auth', 'status']).ok;
}

export function requireGhCommand(): void {
  if (!ghCommandAvailable()) {
    throw new Error('gh CLI is required (install gh and run gh auth login)');
  }
  if (!ghAuthenticated()) {
    throw new Error('gh is not authenticated; run gh auth login');
  }
}

export function ghGetBranchSha(owner: string, repoName: string, branch: string): string | null {
  if (!ghCommandAvailable()) {
    return null;
  }
  const result = runGh([
    'api',
    `repos/${owner}/${repoName}/branches/${encodeURIComponent(branch)}`,
    '--jq',
    '.commit.sha'
  ]);
  if (!result.ok) {
    return null;
  }
  return result.stdout || null;
}

export function ghRepoExists(owner: string, repoName: string): boolean {
  return runGh(['repo', 'view', `${owner}/${repoName}`]).ok;
}

export function getGhRepoDefaultBranch(owner: string, repoName: string): string | null {
  if (!ghCommandAvailable()) {
    return null;
  }
  const result = runGh(['api', `repos/${owner}/${repoName}`, '--jq', '.default_branch']);
  return result.ok && result.stdout ? result.stdout : null;
}

export function setGhRepoDefaultBranch(
  owner: string,
  repoName: string,
  branch: string,
  logger: Logger
): boolean {
  if (!ghCommandAvailable()) {
    return false;
  }
  const result = runGh([
    'api',
    `repos/${owner}/${repoName}`,
    '-X',
    'PATCH',
    '-f',
    `default_branch=${branch}`
  ]);
  if (result.ok) {
    logger.write(`Set ${repoName} default branch to ${branch}`);
    return true;
  }
  return false;
}

export function ghMirrorSyncWorkflowRegistered(owner: string, repoName: string): boolean | null {
  if (!ghCommandAvailable()) {
    return null;
  }
  const result = runGh([
    'api',
    `repos/${owner}/${repoName}/contents/.github/workflows/mirror-sync.yml?ref=${MIRROR_SYNC_BRANCH}`,
    '--jq',
    '.name'
  ]);
  if (!result.ok) {
    const detail = `${result.stderr} ${result.stdout}`.toLowerCase();
    if (detail.includes('404') || detail.includes('not found')) {
      return false;
    }
    return null;
  }
  return result.stdout === 'mirror-sync.yml';
}

export function ghMirrorSyncRunInProgress(owner: string, repoName: string): boolean | null {
  if (!ghCommandAvailable()) {
    return null;
  }
  const result = runGh([
    'run',
    'list',
    '--repo',
    `${owner}/${repoName}`,
    '--workflow',
    'mirror-sync.yml',
    '--branch',
    MIRROR_SYNC_BRANCH,
    '--status',
    'in_progress',
    '--limit',
    '1',
    '--json',
    'databaseId',
    '-q',
    'length'
  ]);
  if (!result.ok) {
    return null;
  }
  return result.stdout !== '0' && result.stdout.length > 0;
}

export function ghDispatchMirrorSyncWorkflow(
  owner: string,
  repoName: string,
  logger?: Logger
): { ok: boolean; skipped?: boolean; notFound?: boolean } {
  if (!ghCommandAvailable()) {
    return { ok: false };
  }
  const inProgress = ghMirrorSyncRunInProgress(owner, repoName);
  if (inProgress === true) {
    logger?.write(`Skip mirror-sync dispatch on ${owner}/${repoName}: run already in progress`);
    return { ok: false, skipped: true };
  }
  const result = runGh([
    'workflow',
    'run',
    'mirror-sync.yml',
    '--repo',
    `${owner}/${repoName}`,
    '--ref',
    MIRROR_SYNC_BRANCH,
    '-f',
    `event_type=${WORKFLOW_DISPATCH_MIRROR_SYNC}`
  ]);
  if (result.ok) {
    return { ok: true };
  }
  const detail = `${result.stderr} ${result.stdout}`.toLowerCase();
  const notFound = detail.includes('404') || detail.includes('not found');
  return { ok: false, notFound };
}

export function ensureGhMirrorRepo(input: {
  Owner: string;
  RepoName: string;
  Description?: string;
  Url?: string;
  Logger: Logger;
}): void {
  if (ghRepoExists(input.Owner, input.RepoName)) {
    input.Logger.write(`${input.Owner}/${input.RepoName} already exists on GitHub`);
    return;
  }
  if (!ghCommandAvailable()) {
    throw new Error(
      `GitHub repo ${input.Owner}/${input.RepoName} not found and gh CLI is unavailable. ` +
        'Install gh, run gh auth login, or create the empty repo on GitHub manually.'
    );
  }
  input.Logger.write(`Creating GitHub repo ${input.Owner}/${input.RepoName} with gh`);
  const args = ['repo', 'create', `${input.Owner}/${input.RepoName}`, '--public'];
  if (input.Description) {
    args.push('--description', input.Description);
  }
  if (input.Url) {
    args.push('--homepage', input.Url);
  }
  const result = runGh(args);
  if (!result.ok) {
    throw new Error(
      `gh repo create failed for ${input.Owner}/${input.RepoName}: ` +
        (result.stderr || result.stdout || 'unknown error')
    );
  }
  input.Logger.write(`Created ${input.Owner}/${input.RepoName} on GitHub`);
}
