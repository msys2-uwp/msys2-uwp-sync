import { existsSync, readFileSync } from 'node:fs';

import type { ReplayEntry } from '../../../src/mirror-merge/replay-entry.ts';
import { precomputeForkSafeFlagsForQueue } from '../../../src/mirror-merge/fork-safe.ts';
import {
  deserializeCommitParentMap,
  type SerializedMirrorParentGraph
} from '../../../src/mirror-merge/replay-graph.ts';
import type { CommitParentMap } from '../../../src/mirror-merge/queue.ts';

function loadSerializedMirrorParentGraph(cachePath: string): SerializedMirrorParentGraph | null {
  if (!existsSync(cachePath)) {
    return null;
  }
  return JSON.parse(readFileSync(cachePath, 'utf8')) as SerializedMirrorParentGraph;
}

export type { CommitParentMap };

export interface ForkSafeResult {
  Branch: string;
  TipSha: string;
  Shas: string[];
  Flags: boolean[];
}

export function buildReverseTopologicalQueueShas(
  parentMap: CommitParentMap,
  tipSha: string
): string[] {
  const shas = new Set(parentMap.keys());
  if (!shas.has(tipSha)) {
    throw new Error(`tip ${tipSha} not in parent map`);
  }

  const children = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const sha of shas) {
    inDegree.set(sha, 0);
    children.set(sha, []);
  }

  for (const [sha, parents] of parentMap) {
    let degree = 0;
    for (const parent of parents) {
      if (!shas.has(parent)) {
        continue;
      }
      degree++;
      children.get(parent)!.push(sha);
    }
    inDegree.set(sha, degree);
  }

  const ready: string[] = [];
  for (const [sha, degree] of inDegree) {
    if (degree === 0) {
      ready.push(sha);
    }
  }
  ready.sort();

  const ordered: string[] = [];
  while (ready.length > 0) {
    const sha = ready.shift()!;
    ordered.push(sha);
    for (const child of children.get(sha)!) {
      const next = inDegree.get(child)! - 1;
      inDegree.set(child, next);
      if (next === 0) {
        ready.push(child);
        ready.sort();
      }
    }
  }

  if (ordered.length !== shas.size) {
    throw new Error(`topological sort incomplete: ${ordered.length}/${shas.size}`);
  }
  if (ordered[ordered.length - 1] !== tipSha) {
    throw new Error(`topological order does not end at tip ${tipSha}`);
  }

  return ordered;
}

export function shasToMinimalQueueEntries(shas: readonly string[]): ReplayEntry[] {
  return shas.map((sha) => ({
    Sha: sha,
    SourceId: 'ports',
    SortKey: 'ports',
    DestSubdir: 'ports',
    UpstreamRepo: 'msys2/MSYS2-packages',
    CommitterDateUnix: 0,
    AuthorDateUnix: 0,
    AuthorName: '',
    AuthorEmail: '',
    CommitterName: '',
    CommitterEmail: '',
    Subject: '',
    Body: ''
  }));
}

export function precomputeForkSafeFlagsFromParentMap(
  parentMap: CommitParentMap,
  tipSha: string,
  input?: {
    QueueShas?: readonly string[];
    OnProgress?: (processed: number, total: number) => void;
    ProgressInterval?: number;
  }
): ForkSafeResult {
  const shas = input?.QueueShas ? [...input.QueueShas] : buildReverseTopologicalQueueShas(parentMap, tipSha);
  const queueEntries = shasToMinimalQueueEntries(shas);
  const flags = precomputeForkSafeFlagsForQueue(
    queueEntries,
    parentMap,
    tipSha,
    input?.OnProgress,
    input?.ProgressInterval
  );
  return {
    Branch: '',
    TipSha: tipSha,
    Shas: shas,
    Flags: flags
  };
}

export function precomputeForkSafeFlagsFromSerialized(
  serialized: SerializedMirrorParentGraph,
  input?: {
    OnProgress?: (processed: number, total: number) => void;
    ProgressInterval?: number;
  }
): ForkSafeResult {
  const parentMap = deserializeCommitParentMap(serialized);
  const result = precomputeForkSafeFlagsFromParentMap(parentMap, serialized.TipSha, input);
  return {
    Branch: serialized.Branch,
    TipSha: serialized.TipSha,
    Shas: result.Shas,
    Flags: result.Flags
  };
}

export function precomputeForkSafeFlagsFromCachePath(
  cachePath: string,
  input?: {
    OnProgress?: (processed: number, total: number) => void;
    ProgressInterval?: number;
  }
): ForkSafeResult | null {
  const serialized = loadSerializedMirrorParentGraph(cachePath);
  if (!serialized) {
    return null;
  }
  return precomputeForkSafeFlagsFromSerialized(serialized, input);
}
