import { describe, expect, test } from 'vitest';

import { getReplaySortRank, mergeReplayCommitQueues } from '../../src/lib/queue.ts';
import type { ReplayEntry } from '../../src/types/replay-entry.ts';

function newTestQueueItem(input: {
  SourceId: string;
  Sha: string;
  AuthorDateUnix: number;
  CommitterDateUnix?: number;
}): ReplayEntry & { SortRank: string } {
  const committerDateUnix = input.CommitterDateUnix ?? input.AuthorDateUnix;
  return {
    SourceId: input.SourceId,
    SortKey: input.SourceId,
    DestSubdir: input.SourceId,
    UpstreamRepo: `example/${input.SourceId}`,
    Sha: input.Sha,
    AuthorDateUnix: input.AuthorDateUnix,
    CommitterDateUnix: committerDateUnix,
    AuthorName: 'Author',
    AuthorEmail: 'author@example.com',
    CommitterName: 'Committer',
    CommitterEmail: 'committer@example.com',
    Subject: 'subject',
    Body: '',
    SortRank: getReplaySortRank({
      AuthorDateUnix: input.AuthorDateUnix,
      CommitterDateUnix: committerDateUnix,
      SourceId: input.SourceId,
      Sha: input.Sha
    })
  };
}

describe('mergeReplayCommitQueues', () => {
  test('preserves git order within each source while merging source heads', () => {
    const ports = [
      newTestQueueItem({ SourceId: 'ports', Sha: 'a'.repeat(40), AuthorDateUnix: 200 }),
      newTestQueueItem({ SourceId: 'ports', Sha: 'b'.repeat(40), AuthorDateUnix: 100 })
    ];
    const mingw = [
      newTestQueueItem({ SourceId: 'ports-mingw', Sha: 'c'.repeat(40), AuthorDateUnix: 150 })
    ];

    const merged = mergeReplayCommitQueues(ports, mingw);
    expect(merged).toHaveLength(3);
    expect(merged[0]?.Sha).toBe('c'.repeat(40));
    expect(merged[1]?.Sha).toBe('a'.repeat(40));
    expect(merged[2]?.Sha).toBe('b'.repeat(40));

    const globalSorted = [...ports, ...mingw].sort((left, right) => left.SortRank.localeCompare(right.SortRank));
    expect(merged[0]?.Sha).not.toBe(globalSorted[0]?.Sha);
  });

  test('uses committer date before author date', () => {
    const merged = mergeReplayCommitQueues([
      newTestQueueItem({
        SourceId: 'ports',
        Sha: 'd'.repeat(40),
        AuthorDateUnix: 300,
        CommitterDateUnix: 50
      })
    ], [
      newTestQueueItem({
        SourceId: 'ports-mingw',
        Sha: 'e'.repeat(40),
        AuthorDateUnix: 100,
        CommitterDateUnix: 200
      })
    ]);

    expect(merged[0]?.Sha).toBe('d'.repeat(40));
  });
});
