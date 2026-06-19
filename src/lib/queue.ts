import type { ReplayEntry } from '../types/replay-entry.ts';
import type { SyncConfig } from './config.ts';

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
