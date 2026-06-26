import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  getMirrorMergeWorkflowTemplatePath,
  MIRROR_MERGE_BRANCH,
  type SyncConfig
} from './config.ts';
import { ghRemoteHasBranch, ghRepoClone } from './gh.ts';
import { runGit, runGitText } from '../git/index.ts';
import type { Logger } from '../git/log.ts';

function refExists(repoPath: string, ref: string): boolean {
  try {
    runGitText(repoPath, ['rev-parse', '--verify', ref]);
    return true;
  } catch {
    return false;
  }
}

function workflowFileMatchesTemplate(repoPath: string, templatePath: string): boolean {
  const installed = join(repoPath, '.github', 'workflows', 'mirror-merge.yml');
  if (!existsSync(installed)) {
    return false;
  }
  const left = readFileSync(installed, 'utf8').replace(/\r\n/g, '\n');
  const right = readFileSync(templatePath, 'utf8').replace(/\r\n/g, '\n');
  return left === right;
}

export function installMirrorMergeWorkflow(input: {
  RepoRoot: string;
  WorkDirectory: string;
  Config: SyncConfig;
  Push: boolean;
  Logger: Logger;
}): boolean {
  const owner = input.Config.Owner;
  const repo = input.Config.Destination.Repo;
  const templatePath = getMirrorMergeWorkflowTemplatePath(input.RepoRoot);
  if (!existsSync(templatePath)) {
    throw new Error(`Missing mirror-merge template: ${templatePath}`);
  }

  const repoPath = join(input.WorkDirectory, 'mirror-merge-ci');
  if (!existsSync(repoPath)) {
    ghRepoClone(owner, repo, repoPath, input.Logger);
  } else {
    input.Logger.write(`Using existing ${repoPath}`);
    runGit(repoPath, ['fetch', 'origin', '--prune'], {}, 5, input.Logger);
  }

  const originBranch = `origin/${MIRROR_MERGE_BRANCH}`;
  if (refExists(repoPath, originBranch)) {
    runGit(repoPath, ['checkout', '-B', MIRROR_MERGE_BRANCH, originBranch], {}, 5, input.Logger);
  } else if (refExists(repoPath, MIRROR_MERGE_BRANCH)) {
    runGit(repoPath, ['checkout', MIRROR_MERGE_BRANCH], {}, 5, input.Logger);
  } else {
    input.Logger.write(`Creating local ${MIRROR_MERGE_BRANCH} branch`);
    runGit(repoPath, ['checkout', '--orphan', MIRROR_MERGE_BRANCH], {}, 5, input.Logger);
    runGit(repoPath, ['rm', '-rf', '--ignore-unmatch', '.'], {}, 5, input.Logger);
  }

  if (workflowFileMatchesTemplate(repoPath, templatePath)) {
    input.Logger.write(`${owner}/${repo}: ${MIRROR_MERGE_BRANCH} workflow already matches template`);
    return false;
  }

  const workflowsDir = join(repoPath, '.github', 'workflows');
  mkdirSync(workflowsDir, { recursive: true });
  copyFileSync(templatePath, join(workflowsDir, 'mirror-merge.yml'));
  runGit(repoPath, ['add', '.github/workflows/mirror-merge.yml'], {}, 5, input.Logger);

  if (runGitText(repoPath, ['status', '--porcelain']).trim()) {
    runGit(
      repoPath,
      ['commit', '-m', 'Install mirror-merge workflow from msys2-apiss-sync template'],
      {},
      5,
      input.Logger
    );
    input.Logger.write(`Updated ${MIRROR_MERGE_BRANCH} workflow on ${owner}/${repo}`);
  }

  if (!input.Push) {
    return true;
  }

  if (!ghRemoteHasBranch(owner, repo, MIRROR_MERGE_BRANCH)) {
    runGit(repoPath, ['push', '-u', 'origin', MIRROR_MERGE_BRANCH], {}, 5, input.Logger);
  } else {
    runGit(repoPath, ['push', 'origin', MIRROR_MERGE_BRANCH], {}, 5, input.Logger);
  }
  input.Logger.write(`Pushed ${MIRROR_MERGE_BRANCH} to ${owner}/${repo}`);
  return true;
}
