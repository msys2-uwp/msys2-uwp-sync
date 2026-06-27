import { existsSync } from 'node:fs';

import {
  assertWorkingCopyMirror,
  commitToolingBranchAtRoot,
  fetchOriginBranchOptional,
  fetchRemoteBranchGraph,
  firstCommitOfBranch,
  isToolingLayoutValid,
  refExists
} from './layout.ts';
import { ghRepoClone } from '../git/gh.ts';
import { runGit, runGitText } from '../git/index.ts';
import type { Logger } from '../git/log.ts';

export function defaultBranchRef(repoPath: string, branch: string): string {
  const originRef = `origin/${branch}`;
  return refExists(repoPath, originRef) ? originRef : branch;
}

export function ensureOriginWorkingCopy(input: {
  RepoPath: string;
  Owner: string;
  RepoName: string;
  SkipFetch: boolean;
  Logger: Logger;
}): void {
  if (!existsSync(input.RepoPath)) {
    ghRepoClone(input.Owner, input.RepoName, input.RepoPath, input.Logger);
    return;
  }
  if (!input.SkipFetch) {
    runGit(input.RepoPath, ['fetch', 'origin', '--prune'], {}, 5, input.Logger);
  }
}

export function prepareDefaultBranchGraph(input: {
  RepoPath: string;
  DefaultBranch: string;
  Logger: Logger;
}): void {
  fetchRemoteBranchGraph(input.RepoPath, 'origin', input.DefaultBranch, input.Logger);
  const originDefault = `origin/${input.DefaultBranch}`;
  if (!refExists(input.RepoPath, originDefault)) {
    throw new Error(`Cannot install tooling: missing ${originDefault}`);
  }
}

export function ensureToolingBranchCheckout(input: {
  RepoPath: string;
  DefaultBranch: string;
  ToolingBranch: string;
  Logger: Logger;
}): void {
  fetchOriginBranchOptional(input.RepoPath, input.ToolingBranch, input.Logger);
  fetchOriginBranchOptional(input.RepoPath, input.DefaultBranch, input.Logger);
  const defaultRef = defaultBranchRef(input.RepoPath, input.DefaultBranch);
  if (refExists(input.RepoPath, `origin/${input.ToolingBranch}`)) {
    runGit(
      input.RepoPath,
      ['checkout', '-B', input.ToolingBranch, `origin/${input.ToolingBranch}`],
      {},
      5,
      input.Logger
    );
  } else if (!refExists(input.RepoPath, input.ToolingBranch)) {
    const root = firstCommitOfBranch(input.RepoPath, defaultRef);
    runGit(input.RepoPath, ['checkout', '-B', input.ToolingBranch, root], {}, 5, input.Logger);
  } else {
    runGit(input.RepoPath, ['checkout', input.ToolingBranch], {}, 5, input.Logger);
  }
}

export function repairToolingBranchLayout(input: {
  RepoPath: string;
  DefaultBranch: string;
  ToolingBranch: string;
  Paths: string[];
  Message: string;
  Logger: Logger;
  Force?: boolean;
}): boolean {
  assertWorkingCopyMirror(input.RepoPath);
  const defaultRef = defaultBranchRef(input.RepoPath, input.DefaultBranch);
  if (!refExists(input.RepoPath, defaultRef)) {
    throw new Error(`Cannot repair ${input.ToolingBranch}: missing ${defaultRef}`);
  }
  if (
    !input.Force &&
    isToolingLayoutValid(input.RepoPath, defaultRef, input.ToolingBranch)
  ) {
    return false;
  }
  if (
    !refExists(input.RepoPath, input.ToolingBranch) &&
    !refExists(input.RepoPath, `origin/${input.ToolingBranch}`)
  ) {
    throw new Error(
      `${input.RepoPath}: no tooling on ${input.ToolingBranch}. Apply templates first.`
    );
  }
  const restoreFrom = refExists(input.RepoPath, input.ToolingBranch)
    ? input.ToolingBranch
    : `origin/${input.ToolingBranch}`;
  commitToolingBranchAtRoot({
    RepoPath: input.RepoPath,
    DefaultRef: defaultRef,
    ToolingBranch: input.ToolingBranch,
    Paths: input.Paths,
    Message: input.Message,
    Logger: input.Logger,
    RestoreFromRef: restoreFrom
  });
  input.Logger.write(`Repaired ${input.ToolingBranch} on ${input.RepoPath}`);
  return true;
}

export function pushToolingBranch(input: {
  RepoPath: string;
  ToolingBranch: string;
  Label: string;
  Logger: Logger;
  ForceWithLease?: boolean;
}): boolean {
  if (!refExists(input.RepoPath, input.ToolingBranch)) {
    return false;
  }
  fetchOriginBranchOptional(input.RepoPath, input.ToolingBranch, input.Logger);
  const originTooling = `origin/${input.ToolingBranch}`;
  if (refExists(input.RepoPath, originTooling)) {
    const local = runGitText(input.RepoPath, ['rev-parse', input.ToolingBranch]).trim();
    const remote = runGitText(input.RepoPath, ['rev-parse', originTooling]).trim();
    if (local === remote) {
      input.Logger.write(`${input.Label}: ${input.ToolingBranch} already on origin`);
      return false;
    }
  }
  const pushArgs = input.ForceWithLease
    ? ['push', '--force-with-lease', 'origin', input.ToolingBranch]
    : refExists(input.RepoPath, originTooling)
      ? ['push', 'origin', input.ToolingBranch]
      : ['push', '-u', 'origin', input.ToolingBranch];
  runGit(input.RepoPath, pushArgs, {}, 5, input.Logger);
  input.Logger.write(`Pushed ${input.ToolingBranch} to origin for ${input.Label}`);
  return true;
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
