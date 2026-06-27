import { runGitText } from '../../../src/git/index.ts';
import { buildFirstParentSpine } from '../../../src/mirror-merge/fork-safe.ts';
import type { ReplayEntry } from '../../../src/mirror-merge/replay-entry.ts';
import type { CommitParentMap } from '../../../src/mirror-merge/queue.ts';

export function getReplaySortRank(input: {
  AuthorDateUnix: number;
  CommitterDateUnix: number;
  SourceId: string;
  Sha: string;
}): string {
  return `${input.CommitterDateUnix.toString().padStart(12, '0')}|${input.AuthorDateUnix.toString().padStart(12, '0')}|${input.SourceId}|${input.Sha}`;
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

export function testSyncCursorBranchUpdateSafe(input: {
  Queue: ReplayEntry[];
  Index: number;
  ParentMapPorts: CommitParentMap;
  ParentMapMingw: CommitParentMap;
  TipShaPorts: string;
  TipShaMingw: string;
}): boolean {
  const entry = input.Queue[input.Index]!;
  const parentMap = entry.SourceId === 'ports' ? input.ParentMapPorts : input.ParentMapMingw;
  const tipSha = entry.SourceId === 'ports' ? input.TipShaPorts : input.TipShaMingw;
  return buildFirstParentSpine(parentMap, tipSha).has(entry.Sha);
}
