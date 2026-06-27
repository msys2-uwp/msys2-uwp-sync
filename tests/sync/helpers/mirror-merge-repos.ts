import { runGit, runGitText } from '../../../src/git/index.ts';
import {
  checkoutDestinationReplayBranch,
  getDestinationBranchSha
} from '../../../src/mirror-merge/repos.ts';
import { parseReplayCommitSourceSha } from '../../../src/mirror-merge/replay.ts';
import type { Logger } from '../../../src/git/log.ts';

function getLocalDestinationBranchSha(destinationPath: string, branchName: string): string | null {
  try {
    return runGitText(destinationPath, ['rev-parse', branchName]).trim();
  } catch {
    return null;
  }
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

export function resolveUpstreamCursorSha(
  destinationPath: string,
  cursorDestSha: string,
  upstreamRepo: string
): string | null {
  const message = runGitText(destinationPath, ['log', '-1', '--format=%B', cursorDestSha]);
  return parseReplayCommitSourceSha(message, upstreamRepo);
}

function resolveDestinationBranchSha(destinationPath: string, branchName: string): string | null {
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

  checkoutDestinationReplayBranch(destinationPath, branchName, baseSha);
  logger.write(`Checked out new branch ${branchName} from ${baseBranchName} (${baseSha.slice(0, 8)})`);
  return baseSha;
}
