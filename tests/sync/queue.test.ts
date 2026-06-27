import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';

import { getFirstParent } from './helpers/replay-git.ts';
import {
  buildMirrorCommitParentMap,
  getFirstParentFromMap,
  mergeReplayCommitQueues
} from '../../src/mirror-merge/queue.ts';
import { getReplaySortRank } from './helpers/queue-algorithm.ts';
import type { ReplayEntry } from '../../src/mirror-merge/replay-entry.ts';

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

function runGit(repoPath: string, args: string[]): string {
  const result = spawnSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout).trim());
  }
  return result.stdout;
}

function initTestRepo(repoPath: string): void {
  spawnSync('git', ['init', '-b', 'master', repoPath], {
    encoding: 'utf8',
    windowsHide: true
  });
  runGit(repoPath, ['config', 'user.name', 'Test User']);
  runGit(repoPath, ['config', 'user.email', 'test@example.com']);
}

describe('getFirstParentFromMap', () => {
  test('matches git rev-list for commits on the branch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-parent-map-'));
    try {
      const mirrorPath = join(root, 'mirror');
      initTestRepo(mirrorPath);

      const firstPath = join(mirrorPath, 'first.txt');
      mkdirSync(dirname(firstPath), { recursive: true });
      writeFileSync(firstPath, 'first\n', 'utf8');
      runGit(mirrorPath, ['add', 'first.txt']);
      runGit(mirrorPath, ['commit', '-m', 'first']);
      const first = runGit(mirrorPath, ['rev-parse', 'HEAD']).trim();

      writeFileSync(join(mirrorPath, 'second.txt'), 'second\n', 'utf8');
      runGit(mirrorPath, ['add', 'second.txt']);
      runGit(mirrorPath, ['commit', '-m', 'second']);
      const second = runGit(mirrorPath, ['rev-parse', 'HEAD']).trim();

      const parentMap = await buildMirrorCommitParentMap(mirrorPath, 'master');

      expect(getFirstParentFromMap(parentMap, second)).toBe(getFirstParent(mirrorPath, second));
      expect(getFirstParentFromMap(parentMap, first)).toBe(getFirstParent(mirrorPath, first));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('uses origin branch when local content branch is not checked out', async () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-parent-map-origin-'));
    try {
      const mirrorPath = join(root, 'mirror');
      initTestRepo(mirrorPath);

      writeFileSync(join(mirrorPath, 'first.txt'), 'first\n', 'utf8');
      runGit(mirrorPath, ['add', 'first.txt']);
      runGit(mirrorPath, ['commit', '-m', 'first']);
      const first = runGit(mirrorPath, ['rev-parse', 'HEAD']).trim();

      writeFileSync(join(mirrorPath, 'second.txt'), 'second\n', 'utf8');
      runGit(mirrorPath, ['add', 'second.txt']);
      runGit(mirrorPath, ['commit', '-m', 'second']);
      const second = runGit(mirrorPath, ['rev-parse', 'HEAD']).trim();
      runGit(mirrorPath, ['update-ref', 'refs/remotes/origin/master', second]);

      runGit(mirrorPath, ['checkout', '--orphan', 'sync']);
      mkdirSync(join(mirrorPath, '.github', 'workflows'), { recursive: true });
      writeFileSync(join(mirrorPath, '.github', 'workflows', 'mirror-sync.yml'), 'name: test\n', 'utf8');
      runGit(mirrorPath, ['add', '.github']);
      runGit(mirrorPath, ['commit', '-m', 'sync workflow']);

      const parentMap = await buildMirrorCommitParentMap(mirrorPath, 'master');

      expect(getFirstParentFromMap(parentMap, second)).toBe(first);
      expect(parentMap.has(first)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

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
