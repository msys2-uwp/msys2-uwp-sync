import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';

import { getSyncRepoRoot, loadSyncConfig } from '../../src/mirror-merge/config.ts';
import {
  advanceSyncCursorDestShasIfSafe,
  getDestinationBranchSha,
  resolveSyncRetrieveCursorsFromBranches
} from '../../src/mirror-merge/repos.ts';
import {
  buildCommitParentMapForShas,
  testSyncCursorBranchUpdateSafe
} from './helpers/queue-algorithm.ts';
import { buildFirstParentSpine } from '../../src/mirror-merge/fork-safe.ts';
import {
  precomputeReplayCursorBranchSafeFlags,
  precomputeSourceCursorBranchSafeFlags
} from '../../src/mirror-merge/queue.ts';
import { formatReplayCommitMessage } from '../../src/mirror-merge/replay.ts';
import { setDestinationBranchSha } from './helpers/mirror-merge-repos.ts';
import type { ReplayEntry } from '../../src/mirror-merge/replay-entry.ts';

const config = loadSyncConfig(getSyncRepoRoot());
const replayCommitMessageTemplate = config.Sources[0]!.CommitMessage;

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

function initRepo(repoPath: string): void {
  spawnSync('git', ['init', '-b', 'master', repoPath], {
    encoding: 'utf8',
    windowsHide: true
  });
  runGit(repoPath, ['config', 'user.name', 'Test User']);
  runGit(repoPath, ['config', 'user.email', 'test@example.com']);
}

function writeRepoFile(repoPath: string, relativePath: string, text: string): void {
  const fullPath = join(repoPath, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, text, 'utf8');
}

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

function commitDestinationReplay(
  destPath: string,
  relativePath: string,
  input: {
    SortKey: 'ports' | 'ports-mingw';
    Subject: string;
    UpstreamRepo: string;
    UpstreamSha: string;
  }
): string {
  const fullPath = join(destPath, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${relativePath}\n`, 'utf8');
  runGit(destPath, ['add', relativePath]);
  runGit(destPath, [
    'commit',
    '-m',
    formatReplayCommitMessage({
      Template: replayCommitMessageTemplate,
      SortKey: input.SortKey,
      Metadata: { Subject: input.Subject, Body: '' },
      UpstreamRepo: input.UpstreamRepo,
      UpstreamSha: input.UpstreamSha
    })
  ]);
  return runGit(destPath, ['rev-parse', 'HEAD']).trim();
}

function buildPortsForkMirror(mirrorPath: string): { Base: string; Left: string; Right: string } {
  initRepo(mirrorPath);

  writeRepoFile(mirrorPath, 'base.txt', 'base\n');
  runGit(mirrorPath, ['add', 'base.txt']);
  runGit(mirrorPath, ['commit', '-m', 'base']);
  const base = runGit(mirrorPath, ['rev-parse', 'HEAD']).trim();

  writeRepoFile(mirrorPath, 'left.txt', 'left\n');
  runGit(mirrorPath, ['add', 'left.txt']);
  runGit(mirrorPath, ['commit', '-m', 'left']);
  const left = runGit(mirrorPath, ['rev-parse', 'HEAD']).trim();

  runGit(mirrorPath, ['checkout', base]);
  writeRepoFile(mirrorPath, 'right.txt', 'right\n');
  runGit(mirrorPath, ['add', 'right.txt']);
  runGit(mirrorPath, ['commit', '-m', 'right']);
  const right = runGit(mirrorPath, ['rev-parse', 'HEAD']).trim();

  return { Base: base, Left: left, Right: right };
}

describe('testSyncCursorBranchUpdateSafe', () => {
  test('allows cursor advance at fork root before siblings diverge', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-cursor-fork-'));
    try {
      const mirrorPath = join(root, 'mirror');
      const { Base, Left, Right } = buildPortsForkMirror(mirrorPath);
      const parentMap = buildCommitParentMapForShas(mirrorPath, [Base, Left, Right]);
      const queue = [newPortsEntry(Base), newPortsEntry(Left), newPortsEntry(Right)];

      expect(testSyncCursorBranchUpdateSafe({
        Queue: queue,
        Index: 0,
        ParentMapPorts: parentMap,
        ParentMapMingw: parentMap,
        TipShaPorts: Right,
        TipShaMingw: Right
      })).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('blocks cursor advance while a fork sibling remains in the queue', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-cursor-fork-block-'));
    try {
      const mirrorPath = join(root, 'mirror');
      const { Base, Left, Right } = buildPortsForkMirror(mirrorPath);
      const parentMap = buildCommitParentMapForShas(mirrorPath, [Base, Left, Right]);
      const queue = [newPortsEntry(Base), newPortsEntry(Left), newPortsEntry(Right)];

      expect(testSyncCursorBranchUpdateSafe({
        Queue: queue,
        Index: 1,
        ParentMapPorts: parentMap,
        ParentMapMingw: parentMap,
        TipShaPorts: Right,
        TipShaMingw: Right
      })).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('allows cursor advance after the last fork sibling is processed', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-cursor-fork-done-'));
    try {
      const mirrorPath = join(root, 'mirror');
      const { Base, Left, Right } = buildPortsForkMirror(mirrorPath);
      const parentMap = buildCommitParentMapForShas(mirrorPath, [Base, Left, Right]);
      const queue = [newPortsEntry(Base), newPortsEntry(Left), newPortsEntry(Right)];

      expect(testSyncCursorBranchUpdateSafe({
        Queue: queue,
        Index: 2,
        ParentMapPorts: parentMap,
        ParentMapMingw: parentMap,
        TipShaPorts: Right,
        TipShaMingw: Right
      })).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('precomputeSourceCursorBranchSafeFlags', () => {
  test('marks first-parent mainline safe and parent2 side branches unsafe', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-cursor-spine-'));
    try {
      const mirrorPath = join(root, 'mirror');
      const { Base, Left, Right } = buildPortsForkMirror(mirrorPath);
      const parentMap = buildCommitParentMapForShas(mirrorPath, [Base, Left, Right]);
      const queue = [newPortsEntry(Base), newPortsEntry(Left), newPortsEntry(Right)];
      const spine = buildFirstParentSpine(parentMap, Right);
      const flags = precomputeSourceCursorBranchSafeFlags(queue, parentMap, Right);

      expect(spine.has(Base)).toBe(true);
      expect(spine.has(Right)).toBe(true);
      expect(spine.has(Left)).toBe(false);
      expect(flags).toEqual([true, false, true]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('precomputeReplayCursorBranchSafeFlags', () => {
  test('matches testSyncCursorBranchUpdateSafe for fork queue positions', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-cursor-precompute-'));
    try {
      const mirrorPath = join(root, 'mirror');
      const { Base, Left, Right } = buildPortsForkMirror(mirrorPath);
      const parentMap = buildCommitParentMapForShas(mirrorPath, [Base, Left, Right]);
      const queue = [newPortsEntry(Base), newPortsEntry(Left), newPortsEntry(Right)];
      const flags = precomputeReplayCursorBranchSafeFlags({
        Queue: queue,
        ParentMaps: { ports: parentMap, 'ports-mingw': parentMap }
      });

      for (let index = 0; index < queue.length; index++) {
        expect(flags[index]).toBe(testSyncCursorBranchUpdateSafe({
          Queue: queue,
          Index: index,
          ParentMapPorts: parentMap,
          ParentMapMingw: parentMap,
          TipShaPorts: Right,
          TipShaMingw: Right
        }));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('advanceSyncCursorDestShasIfSafe', () => {
  test('keeps upstream-ports on fork root when sibling remains', () => {
    expect(advanceSyncCursorDestShasIfSafe({
      SourceId: 'ports',
      ReplayTipSha: 'left-dest',
      CursorBranchSafe: false,
      LastDestShas: { ports: 'base-dest', 'ports-mingw': null }
    })).toEqual({
      ports: 'base-dest',
      'ports-mingw': null
    });
  });

  test('advances upstream-ports after fork-safe replay', () => {
    expect(advanceSyncCursorDestShasIfSafe({
      SourceId: 'ports',
      ReplayTipSha: 'right-dest',
      CursorBranchSafe: true,
      LastDestShas: { ports: 'base-dest', 'ports-mingw': null }
    })).toEqual({
      ports: 'right-dest',
      'ports-mingw': null
    });
  });
});

describe('fork-safe cursor branches after abort', () => {
  test('upstream-ports stays at fork root when replay aborted on a sibling line', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-cursor-abort-'));
    try {
      const mirrorPath = join(root, 'mirror-ports');
      const destPath = join(root, 'destination');
      const { Base, Left, Right } = buildPortsForkMirror(mirrorPath);
      initRepo(destPath);

      const baseDestSha = commitDestinationReplay(destPath, 'ports/base.txt', {
        SortKey: 'ports',
        Subject: 'base',
        UpstreamRepo: 'msys2/MSYS2-packages',
        UpstreamSha: Base
      });
      const leftDestSha = commitDestinationReplay(destPath, 'ports/left.txt', {
        SortKey: 'ports',
        Subject: 'left',
        UpstreamRepo: 'msys2/MSYS2-packages',
        UpstreamSha: Left
      });

      runGit(destPath, ['checkout', '-B', 'upstream', leftDestSha]);
      setDestinationBranchSha(destPath, 'upstream-ports', baseDestSha);
      runGit(destPath, ['update-ref', 'refs/remotes/origin/upstream-ports', baseDestSha]);

      const parentMap = buildCommitParentMapForShas(mirrorPath, [Base, Left, Right]);
      const queue = [newPortsEntry(Base), newPortsEntry(Left), newPortsEntry(Right)];

      const unsafeAtLeft = !testSyncCursorBranchUpdateSafe({
        Queue: queue,
        Index: 1,
        ParentMapPorts: parentMap,
        ParentMapMingw: parentMap,
        TipShaPorts: Right,
        TipShaMingw: Right
      });
      expect(unsafeAtLeft).toBe(true);

      const nextCursorDestShas = advanceSyncCursorDestShasIfSafe({
        SourceId: 'ports',
        ReplayTipSha: leftDestSha,
        CursorBranchSafe: false,
        LastDestShas: { ports: baseDestSha, 'ports-mingw': null }
      });
      setDestinationBranchSha(destPath, 'upstream-ports', nextCursorDestShas.ports!);

      expect(getDestinationBranchSha(destPath, 'upstream-ports')).toBe(baseDestSha);
      expect(resolveSyncRetrieveCursorsFromBranches(destPath, config).ports?.UpstreamSha).toBe(Base);
      expect(resolveSyncRetrieveCursorsFromBranches(destPath, config).ports?.UpstreamSha).not.toBe(Left);
      expect(resolveSyncRetrieveCursorsFromBranches(destPath, config).ports?.UpstreamSha).not.toBe(Right);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('getDestinationBranchSha reads origin/<branch> only', () => {
    const root = mkdtempSync(join(tmpdir(), 'sync-origin-ref-'));
    try {
      const destPath = join(root, 'msys2-apiss');
      initRepo(destPath);
      const originSha = commitDestinationReplay(destPath, 'ports/a.txt', {
        SortKey: 'ports',
        Subject: 'a',
        UpstreamRepo: 'msys2/MSYS2-packages',
        UpstreamSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      });
      const localSha = commitDestinationReplay(destPath, 'ports/b.txt', {
        SortKey: 'ports',
        Subject: 'b',
        UpstreamRepo: 'msys2/MSYS2-packages',
        UpstreamSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      });
      runGit(destPath, ['update-ref', 'refs/remotes/origin/upstream', originSha]);
      runGit(destPath, ['branch', '-f', 'upstream', localSha]);

      expect(getDestinationBranchSha(destPath, 'upstream')).toBe(originSha);
      expect(getDestinationBranchSha(destPath, 'upstream')).not.toBe(localSha);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
