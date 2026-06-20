import type { ReplayEntry } from '../types/replay-entry.ts';
import { runGit, runGitStdin, runGitText } from './git.ts';
import { convertToUnixLineEndings } from './log.ts';

const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

interface DiffDeleteEntry {
  Kind: 'Delete';
  Path: string;
}

interface DiffUpdateEntry {
  Kind: 'Update';
  Path: string;
  Mode: string;
  Sha: string;
}

type DiffTreeEntry = DiffDeleteEntry | DiffUpdateEntry;

export function getFirstParent(mirrorPath: string, commit: string): string {
  const parents = runGitText(mirrorPath, ['rev-list', '--parents', '-n', '1', commit]).trim().split(/\s+/);
  if (parents.length <= 1) {
    return emptyTree;
  }
  return parents[1]!;
}

export function formatReplayCommitMessage(input: {
  SortKey: string;
  Metadata: Pick<ReplayEntry, 'Subject' | 'Body'>;
  UpstreamRepo: string;
  UpstreamSha: string;
}): string {
  const subject = input.Metadata.Subject;
  const footer = `Source: ${input.UpstreamRepo}@${input.UpstreamSha}`;
  if (input.Metadata.Body) {
    return convertToUnixLineEndings(`[${input.SortKey}] ${subject}\n\n${input.Metadata.Body}\n${footer}`);
  }
  return convertToUnixLineEndings(`[${input.SortKey}] ${subject}\n${footer}`);
}

export function parseReplayCommitSourceSha(message: string, upstreamRepo: string): string | null {
  const footer = `Source: ${upstreamRepo}@`;
  const index = message.lastIndexOf(footer);
  if (index < 0) {
    return null;
  }
  const sha = message.slice(index + footer.length, index + footer.length + 40);
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

export function getDiffTreeEntries(mirrorPath: string, parent: string, commit: string): DiffTreeEntry[] {
  const raw = runGitText(mirrorPath, ['diff-tree', '-r', '-z', '-M', '--no-commit-id', parent, commit]);
  if (!raw) {
    return [];
  }

  const tokens = raw.split('\0').filter((token) => token.length > 0);
  const entries: DiffTreeEntry[] = [];
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i]!;
    const match = /^:(\d+) (\d+) ([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(token);
    if (!match) {
      i++;
      continue;
    }

    const newMode = match[2]!;
    const newSha = match[4]!;
    const status = match[5]!;
    i++;

    if (/^R/.test(status)) {
      if (i + 1 >= tokens.length) {
        throw new Error(`Unexpected diff-tree rename payload for commit ${commit}`);
      }
      entries.push({ Kind: 'Delete', Path: tokens[i]! });
      entries.push({ Kind: 'Update', Path: tokens[i + 1]!, Mode: newMode, Sha: newSha });
      i += 2;
      continue;
    }

    if (i >= tokens.length) {
      throw new Error(`Unexpected diff-tree payload for commit ${commit}`);
    }

    const path = tokens[i++]!;
    if (status === 'D' || newMode === '000000') {
      entries.push({ Kind: 'Delete', Path: path });
    } else {
      entries.push({ Kind: 'Update', Path: path, Mode: newMode, Sha: newSha });
    }
  }

  return entries;
}

export function applyUpstreamCommitToIndex(input: {
  MirrorPath: string;
  Commit: string;
  Parent: string;
  DestSubdir: string;
  DestinationPath: string;
}): boolean {
  const diffEntries = getDiffTreeEntries(input.MirrorPath, input.Parent, input.Commit);
  if (diffEntries.length === 0) {
    return false;
  }

  runGit(input.DestinationPath, ['read-tree', 'HEAD']);
  const indexLines: string[] = [];
  const removePaths: string[] = [];

  for (const entry of diffEntries) {
    if (entry.Kind === 'Delete') {
      removePaths.push(`${input.DestSubdir}/${entry.Path}`);
    } else {
      indexLines.push(`${entry.Mode} ${entry.Sha}\t${input.DestSubdir}/${entry.Path}`);
    }
  }

  if (indexLines.length > 0) {
    runGitStdin(input.DestinationPath, ['update-index', '--index-info'], `${indexLines.join('\n')}\n`);
  }

  if (removePaths.length > 0) {
    runGit(input.DestinationPath, ['rm', '--cached', '-r', '-f', '--ignore-unmatch', '--', ...removePaths]);
  }

  return runGitText(input.DestinationPath, ['diff', '--cached', '--name-only']).trim().length > 0;
}

export function testUpstreamCommitHasMappedChanges(mirrorPath: string, commit: string, parent: string): boolean {
  return getDiffTreeEntries(mirrorPath, parent, commit).length > 0;
}

export function formatGitReplayDateEnv(unixSeconds: number): string {
  return `@${unixSeconds}`;
}

export function newReplayCommit(destinationPath: string, entry: ReplayEntry, message: string): void {
  const env = {
    GIT_AUTHOR_NAME: entry.AuthorName,
    GIT_AUTHOR_EMAIL: entry.AuthorEmail,
    GIT_AUTHOR_DATE: formatGitReplayDateEnv(entry.AuthorDateUnix),
    GIT_COMMITTER_NAME: entry.CommitterName,
    GIT_COMMITTER_EMAIL: entry.CommitterEmail,
    GIT_COMMITTER_DATE: formatGitReplayDateEnv(entry.CommitterDateUnix)
  };
  runGitStdin(destinationPath, ['commit', '-F', '-'], message, env);
}
