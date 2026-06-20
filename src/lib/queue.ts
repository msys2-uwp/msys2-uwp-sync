import type { ReplayEntry } from '../types/replay-entry.ts';
import type { SyncConfig } from './config.ts';
import { runGitText, streamGitText } from './git.ts';

export type CommitParentMap = Map<string, readonly string[]>;

export function compareReplayRank(left: ReplayEntry, right: ReplayEntry): number {
  if (left.CommitterDateUnix !== right.CommitterDateUnix) {
    return Math.sign(left.CommitterDateUnix - right.CommitterDateUnix);
  }
  if (left.AuthorDateUnix !== right.AuthorDateUnix) {
    return Math.sign(left.AuthorDateUnix - right.AuthorDateUnix);
  }
  if (left.SourceId !== right.SourceId) {
    return left.SourceId < right.SourceId ? -1 : 1;
  }
  if (left.Sha === right.Sha) {
    return 0;
  }
  return left.Sha < right.Sha ? -1 : 1;
}

export function getReplaySortRank(input: {
  AuthorDateUnix: number;
  CommitterDateUnix: number;
  SourceId: string;
  Sha: string;
}): string {
  return `${input.CommitterDateUnix.toString().padStart(12, '0')}|${input.AuthorDateUnix.toString().padStart(12, '0')}|${input.SourceId}|${input.Sha}`;
}

export function mergeReplayCommitQueues(portsList: ReplayEntry[], portsMingwList: ReplayEntry[]): ReplayEntry[] {
  const merged: ReplayEntry[] = [];
  let i = 0;
  let j = 0;

  while (i < portsList.length && j < portsMingwList.length) {
    if (compareReplayRank(portsList[i]!, portsMingwList[j]!) <= 0) {
      merged.push(portsList[i]!);
      i++;
    } else {
      merged.push(portsMingwList[j]!);
      j++;
    }
  }

  while (i < portsList.length) {
    merged.push(portsList[i]!);
    i++;
  }

  while (j < portsMingwList.length) {
    merged.push(portsMingwList[j]!);
    j++;
  }

  return merged;
}

export function getReplayAgeCutoffUnix(config: SyncConfig, nowUnix = Math.floor(Date.now() / 1000)): number {
  const minutes = config.Replay.MinReplayAgeMinutes === undefined || config.Replay.MinReplayAgeMinutes < 0
    ? 5
    : config.Replay.MinReplayAgeMinutes;
  return nowUnix - minutes * 60;
}

export async function buildMirrorCommitParentMap(mirrorPath: string, branch = 'master'): Promise<CommitParentMap> {
  const raw = await streamGitText(mirrorPath, ['rev-list', '--parents', branch]);
  const map = new Map<string, readonly string[]>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const parts = trimmed.split(/\s+/);
    map.set(parts[0]!, parts.slice(1));
  }
  return map;
}

export function buildCommitParentMapForShas(mirrorPath: string, shas: Iterable<string>): CommitParentMap {
  const map = new Map<string, readonly string[]>();
  for (const sha of new Set(shas)) {
    const line = runGitText(mirrorPath, ['rev-list', '--parents', '-n', '1', sha]).trim();
    if (!line) {
      continue;
    }
    const parts = line.split(/\s+/);
    map.set(parts[0]!, parts.slice(1));
  }
  return map;
}

export function testCommitIsAncestor(
  parentMap: CommitParentMap,
  ancestor: string,
  descendant: string,
  memo = new Map<string, boolean>()
): boolean {
  if (ancestor === descendant) {
    return true;
  }

  const key = `${ancestor}\0${descendant}`;
  const cached = memo.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === ancestor) {
      memo.set(key, true);
      return true;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    for (const parent of parentMap.get(current) ?? []) {
      stack.push(parent);
    }
  }

  memo.set(key, false);
  return false;
}

export function testSyncCursorBranchUpdateSafe(input: {
  Queue: ReplayEntry[];
  Index: number;
  LastPortsSha: string | null;
  LastPortsMingwSha: string | null;
  ParentMapPorts: CommitParentMap;
  ParentMapMingw: CommitParentMap;
  AncestorMemo?: Map<string, boolean>;
}): boolean {
  const memo = input.AncestorMemo ?? new Map<string, boolean>();
  const remaining = input.Queue.slice(input.Index + 1);
  for (const entry of remaining) {
    const parentMap = entry.SourceId === 'ports' ? input.ParentMapPorts : input.ParentMapMingw;
    const cursorSha = entry.SourceId === 'ports' ? input.LastPortsSha : input.LastPortsMingwSha;
    if (!cursorSha) {
      continue;
    }
    if (!testCommitIsAncestor(parentMap, cursorSha, entry.Sha, memo)) {
      return false;
    }
  }
  return true;
}

export function filterReplayQueueByAge(
  queue: ReplayEntry[],
  config: SyncConfig,
  log: (message: string) => void,
  nowUnix = Math.floor(Date.now() / 1000)
): ReplayEntry[] {
  const minutes = config.Replay.MinReplayAgeMinutes ?? 5;
  const cutoff = getReplayAgeCutoffUnix(config, nowUnix);
  const eligible = queue.filter((entry) => entry.CommitterDateUnix <= cutoff);
  const held = queue.length - eligible.length;
  if (held > 0) {
    log(`Holding ${held} commit(s) with committer date within the last ${minutes} minute(s) to avoid timeline reorder.`);
  }
  return eligible;
}
