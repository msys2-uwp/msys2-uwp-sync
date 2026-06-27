import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';

import {
  deserializeCommitParentMap,
  getMirrorParentGraphCachePath,
  loadMirrorParentGraph,
  saveMirrorParentGraph,
  serializeCommitParentMap
} from '../../src/mirror-merge/replay-graph.ts';
import {
  buildCommitParentMapForShas
} from './helpers/queue-algorithm.ts';
import { precomputeSourceCursorBranchSafeFlags } from '../../src/mirror-merge/queue.ts';
import type { ReplayEntry } from '../../src/mirror-merge/replay-entry.ts';

function newPortsEntry(sha: string): ReplayEntry {
  return {
    Sha: sha,
    SourceId: 'ports',
    SortKey: 'ports',
    DestSubdir: 'ports',
    UpstreamRepo: 'msys2/MSYS2-packages',
    CommitterDateUnix: 1,
    AuthorDateUnix: 1,
    AuthorName: 'Author',
    AuthorEmail: 'author@example.com',
    CommitterName: 'Committer',
    CommitterEmail: 'committer@example.com',
    Subject: 'subject',
    Body: ''
  };
}

describe('replay-graph cache', () => {
  test('serializes and loads parent map from disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-replay-graph-'));
    try {
      const parentMap = new Map<string, readonly string[]>([
        ['c3', ['c2']],
        ['c2', ['c1']],
        ['c1', []]
      ]);
      const cachePath = getMirrorParentGraphCachePath(root, 'ports', 'master', 'c3');
      saveMirrorParentGraph(cachePath, 'master', 'c3', parentMap);

      const loaded = loadMirrorParentGraph(cachePath);
      expect(loaded).not.toBeNull();
      expect(loaded!.get('c3')).toEqual(['c2']);
      expect(loaded!.get('c1')).toEqual([]);

      const serialized = serializeCommitParentMap('master', 'c3', parentMap);
      expect(deserializeCommitParentMap(serialized).get('c2')).toEqual(['c1']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('fork-safe flags from saved graph', () => {
  test('precompute matches mainline spine rule using saved graph', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-replay-graph-fork-'));
    try {
      const mirrorPath = join(root, 'mirror');

      spawnSync('git', ['init', '-b', 'master', mirrorPath], { encoding: 'utf8', windowsHide: true });
      const runGit = (args: string[]) => {
        const result = spawnSync('git', ['-C', mirrorPath, ...args], { encoding: 'utf8', windowsHide: true });
        if (result.status !== 0) {
          throw new Error((result.stderr || result.stdout).trim());
        }
        return result.stdout;
      };
      runGit(['config', 'user.name', 'Test User']);
      runGit(['config', 'user.email', 'test@example.com']);

      const writeRepoFile = (relativePath: string, text: string) => {
        const fullPath = join(mirrorPath, relativePath);
        writeFileSync(fullPath, text, 'utf8');
      };

      writeRepoFile('base.txt', 'base\n');
      runGit(['add', 'base.txt']);
      runGit(['commit', '-m', 'base']);
      const base = runGit(['rev-parse', 'HEAD']).trim();

      runGit(['checkout', '-b', 'left', base]);
      writeRepoFile('left.txt', 'left\n');
      runGit(['add', 'left.txt']);
      runGit(['commit', '-m', 'left']);
      const left = runGit(['rev-parse', 'HEAD']).trim();

      runGit(['checkout', 'master']);
      writeRepoFile('right.txt', 'right\n');
      runGit(['add', 'right.txt']);
      runGit(['commit', '-m', 'right']);
      const right = runGit(['rev-parse', 'HEAD']).trim();

      const parentMap = buildCommitParentMapForShas(mirrorPath, [base, left, right]);
      const cachePath = getMirrorParentGraphCachePath(root, 'ports', 'master', right);
      saveMirrorParentGraph(cachePath, 'master', right, parentMap);
      const loaded = loadMirrorParentGraph(cachePath)!;

      const queue = [newPortsEntry(base), newPortsEntry(left), newPortsEntry(right)];
      const flags = precomputeSourceCursorBranchSafeFlags(queue, loaded, right);

      expect(flags).toEqual([true, false, true]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
