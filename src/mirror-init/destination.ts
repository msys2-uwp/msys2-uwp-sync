import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  getMirrorMergeWorkflowTemplatePath,
  type SyncConfig
} from './config.ts';
import { MIRROR_MERGE_BRANCH } from '../types/constants.ts';
import { isToolingLayoutValid, firstCommitOfBranch } from './layout.ts';
import {
  defaultBranchRef,
  ensureOriginWorkingCopy,
  ensureToolingBranchCheckout,
  prepareDefaultBranchGraph,
  pushToolingBranch,
  setGitRepoUtf8Encoding
} from './tooling-repo.ts';
import { runGit, runGitText } from '../git/index.ts';
import type { Logger } from '../git/log.ts';

const MIRROR_MERGE_COMMIT_MESSAGE =
  'Install mirror-merge workflow from msys2-apiss-sync template';

function mergeWorkflowMatchesTemplate(repoPath: string, templatePath: string): boolean {
  try {
    const remote = runGitText(repoPath, [
      'show',
      `${MIRROR_MERGE_BRANCH}:.github/workflows/mirror-merge.yml`
    ]);
    return remote.replace(/\r\n/g, '\n') === readFileSync(templatePath, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return false;
  }
}

function applyMirrorMergeTemplate(input: {
  RepoPath: string;
  RepoRoot: string;
  DefaultBranch: string;
  Logger: Logger;
}): boolean {
  const templatePath = getMirrorMergeWorkflowTemplatePath(input.RepoRoot);
  if (!existsSync(templatePath)) {
    throw new Error(`Missing mirror-merge template: ${templatePath}`);
  }
  const defaultRef = defaultBranchRef(input.RepoPath, input.DefaultBranch);
  if (
    isToolingLayoutValid(input.RepoPath, defaultRef, MIRROR_MERGE_BRANCH) &&
    mergeWorkflowMatchesTemplate(input.RepoPath, templatePath)
  ) {
    return false;
  }
  const root = firstCommitOfBranch(input.RepoPath, defaultRef);
  runGit(input.RepoPath, ['checkout', '-B', MIRROR_MERGE_BRANCH, root], {}, 5, input.Logger);
  const workflowsDir = join(input.RepoPath, '.github', 'workflows');
  mkdirSync(workflowsDir, { recursive: true });
  copyFileSync(templatePath, join(workflowsDir, 'mirror-merge.yml'));
  runGit(input.RepoPath, ['add', '.github/workflows/mirror-merge.yml'], {}, 5, input.Logger);
  runGit(input.RepoPath, ['commit', '-m', MIRROR_MERGE_COMMIT_MESSAGE], {}, 5, input.Logger);
  return true;
}

export function initializeDestinationRepository(input: {
  RepoRoot: string;
  WorkDirectory: string;
  Config: SyncConfig;
  SkipFetch: boolean;
  Logger: Logger;
}): string {
  const owner = input.Config.Owner;
  const repo = input.Config.Destination.Repo;
  const defaultBranch = input.Config.Destination.DefaultBranch ?? 'main';
  const repoPath = join(input.WorkDirectory, 'mirror-merge-ci');

  ensureOriginWorkingCopy({
    RepoPath: repoPath,
    Owner: owner,
    RepoName: repo,
    SkipFetch: input.SkipFetch,
    Logger: input.Logger
  });
  prepareDefaultBranchGraph({ RepoPath: repoPath, DefaultBranch: defaultBranch, Logger: input.Logger });
  ensureToolingBranchCheckout({
    RepoPath: repoPath,
    DefaultBranch: defaultBranch,
    ToolingBranch: MIRROR_MERGE_BRANCH,
    Logger: input.Logger
  });
  const updated = applyMirrorMergeTemplate({
    RepoPath: repoPath,
    RepoRoot: input.RepoRoot,
    DefaultBranch: defaultBranch,
    Logger: input.Logger
  });
  if (updated) {
    input.Logger.write(`Updated ${MIRROR_MERGE_BRANCH} workflow on ${owner}/${repo}`);
  } else {
    input.Logger.write(`${owner}/${repo}: ${MIRROR_MERGE_BRANCH} workflow already matches template`);
  }
  setGitRepoUtf8Encoding(repoPath);
  return repoPath;
}

export function pushDestinationToolingBranch(input: {
  RepoPath: string;
  Config: SyncConfig;
  Logger: Logger;
}): void {
  const owner = input.Config.Owner;
  const repo = input.Config.Destination.Repo;
  pushToolingBranch({
    RepoPath: input.RepoPath,
    ToolingBranch: MIRROR_MERGE_BRANCH,
    Label: `${owner}/${repo}`,
    Logger: input.Logger,
    ForceWithLease: true
  });
}
