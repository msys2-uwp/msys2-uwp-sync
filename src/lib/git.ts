import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import type { SyncLogger } from './log.ts';

export type GitEnv = Record<string, string | undefined>;

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function gitLockError(text: string): boolean {
  return /index\.lock|Unable to create.*\.lock|Another git process/.test(text);
}

export function clearGitLockFiles(repoPath: string, logger?: SyncLogger): void {
  const gitDir = join(repoPath, '.git');
  for (const name of ['index.lock', 'shallow.lock', 'HEAD.lock']) {
    const lockPath = join(gitDir, name);
    if (!existsSync(lockPath)) {
      continue;
    }
    try {
      rmSync(lockPath, { force: true });
      logger?.write(`Removed stale git lock: ${name}`, 'Warn');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger?.write(`Could not remove git lock ${name} : ${message}`, 'Warn');
    }
  }
}

export function runGit(
  repoPath: string | null,
  gitArgs: string[],
  env: GitEnv = {},
  maxAttempts = 5,
  logger?: SyncLogger
): string {
  return runGitInternal(repoPath, gitArgs, undefined, env, maxAttempts, logger);
}

export function runGitText(repoPath: string | null, gitArgs: string[]): string {
  return runGitInternal(repoPath, gitArgs, undefined, {}, 1);
}

export function runGitStdin(
  repoPath: string | null,
  gitArgs: string[],
  inputText: string,
  env: GitEnv = {},
  maxAttempts = 5,
  logger?: SyncLogger
): string {
  return runGitInternal(repoPath, gitArgs, inputText, env, maxAttempts, logger);
}

function runGitInternal(
  repoPath: string | null,
  gitArgs: string[],
  inputText: string | undefined,
  env: GitEnv,
  maxAttempts: number,
  logger?: SyncLogger
): string {
  let attempt = 0;
  let lastOutput = '';

  while (attempt < maxAttempts) {
    attempt++;
    const args = repoPath ? ['-C', repoPath, ...gitArgs] : gitArgs;
    const result = spawnSync('git', args, {
      input: inputText,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      windowsHide: true
    });

    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';

    if (result.status === 0) {
      return stdout || stderr;
    }

    lastOutput = (stderr || stdout || result.error?.message || '').trim();
    if (repoPath && gitLockError(lastOutput) && attempt < maxAttempts) {
      clearGitLockFiles(repoPath, logger);
      sleep(200 * attempt);
      continue;
    }

    const command = repoPath ? `git -C ${repoPath} ${gitArgs.join(' ')}` : `git ${gitArgs.join(' ')}`;
    throw new Error(`git command failed (${command}): ${lastOutput}`);
  }

  const command = repoPath ? `git -C ${repoPath} ${gitArgs.join(' ')}` : `git ${gitArgs.join(' ')}`;
  throw new Error(`git command failed (${command}): ${lastOutput}`);
}
