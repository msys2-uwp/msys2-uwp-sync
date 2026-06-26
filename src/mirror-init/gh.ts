import { spawnSync } from 'node:child_process';

import type { Logger } from '../git/log.ts';

export function runGh(args: string[]): { ok: boolean; stdout: string; stderr: string } {
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

export function requireGhAuthenticated(): void {
  if (!ghCommandAvailable()) {
    throw new Error('gh CLI is required (install gh and run gh auth login)');
  }
  if (!ghAuthenticated()) {
    throw new Error('gh is not authenticated; run gh auth login');
  }
}

export function ghRepoExists(owner: string, repoName: string): boolean {
  return runGh(['repo', 'view', `${owner}/${repoName}`]).ok;
}

export function ghRepoCreate(input: {
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
  requireGhAuthenticated();
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

export function ghRepoClone(owner: string, repoName: string, targetPath: string, logger: Logger): void {
  requireGhAuthenticated();
  logger.write(`Cloning ${owner}/${repoName} with gh`);
  const result = runGh(['repo', 'clone', `${owner}/${repoName}`, targetPath]);
  if (!result.ok) {
    throw new Error(
      `gh repo clone failed for ${owner}/${repoName}: ${result.stderr || result.stdout || 'unknown error'}`
    );
  }
}

export function ghRemoteHasBranch(owner: string, repoName: string, branch: string): boolean {
  const result = runGh([
    'api',
    `repos/${owner}/${repoName}/branches/${encodeURIComponent(branch)}`,
    '--jq',
    '.name'
  ]);
  return result.ok && result.stdout === branch;
}
