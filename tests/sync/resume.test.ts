import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';

import { getSyncRepoRoot, loadSyncConfig } from '../../src/lib/config.ts';
import { getMirrorTipSha, getSourceReplayHistory } from '../../src/lib/history.ts';
import { mergeReplayCommitQueues } from '../../src/lib/queue.ts';
import { formatReplayCommitMessage } from '../../src/lib/replay.ts';
import {
  initializeDestinationAlternates,
  resolveSyncRetrieveCursorsFromBranches,
  setDestinationBranchSha
} from '../../src/lib/repos.ts';

const config = loadSyncConfig(getSyncRepoRoot());

function runGit(repoPath: string, args: string[], env: Record<string, string> = {}): string {
  const result = spawnSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...env }
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

function commitMirror(repoPath: string, relativePath: string, message: string, dateUnix: number): string {
  const fullPath = join(repoPath, relativePath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, `${relativePath}\n`, 'utf8');
  runGit(repoPath, ['add', relativePath]);
  const dateEnv = {
    GIT_AUTHOR_DATE: `@${dateUnix}`,
    GIT_COMMITTER_DATE: `@${dateUnix}`
  };
  runGit(repoPath, ['commit', '-m', message], dateEnv);
  return runGit(repoPath, ['rev-parse', 'HEAD']).trim();
}

function commitDestinationReplay(
  destPath: string,
  relativePath: string,
  input: {
    SortKey: 'ports' | 'ports-mingw';
    Subject: string;
    UpstreamRepo: string;
    UpstreamSha: string;
    DateUnix: number;
  }
): string {
  const fullPath = join(destPath, relativePath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, `${relativePath}\n`, 'utf8');
  runGit(destPath, ['add', relativePath]);
  const message = formatReplayCommitMessage({
    SortKey: input.SortKey,
    Metadata: { Subject: input.Subject, Body: '' },
    UpstreamRepo: input.UpstreamRepo,
    UpstreamSha: input.UpstreamSha
  });
  runGit(destPath, ['commit', '-m', message], {
    GIT_AUTHOR_DATE: `@${input.DateUnix}`,
    GIT_COMMITTER_DATE: `@${input.DateUnix}`
  });
  return runGit(destPath, ['rev-parse', 'HEAD']).trim();
}

describe('resolveSyncRetrieveCursorsFromBranches', () => {
  test('reads upstream mirror cursors from upstream-ports and upstream-ports-mingw', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-uwp-sync-resume-cursors-'));
    try {
      const destPath = join(root, 'destination');
      initRepo(destPath);

      const portsUpstreamSha = 'a'.repeat(40);
      const mingwUpstreamSha = 'b'.repeat(40);

      const portsDestSha = commitDestinationReplay(destPath, 'ports/one.txt', {
        SortKey: 'ports',
        Subject: 'ports one',
        UpstreamRepo: 'msys2/MSYS2-packages',
        UpstreamSha: portsUpstreamSha,
        DateUnix: 1_700_000_100
      });
      const mingwDestSha = commitDestinationReplay(destPath, 'ports-mingw/one.txt', {
        SortKey: 'ports-mingw',
        Subject: 'mingw one',
        UpstreamRepo: 'msys2/MINGW-packages',
        UpstreamSha: mingwUpstreamSha,
        DateUnix: 1_700_000_200
      });

      runGit(destPath, ['checkout', '-B', 'upstream', mingwDestSha]);
      setDestinationBranchSha(destPath, 'upstream-ports', portsDestSha);
      setDestinationBranchSha(destPath, 'upstream-ports-mingw', mingwDestSha);

      expect(resolveSyncRetrieveCursorsFromBranches(destPath, config)).toEqual({
        PortsDestSha: portsDestSha,
        PortsMingwDestSha: mingwDestSha,
        PortsUpstreamSha: portsUpstreamSha,
        PortsMingwUpstreamSha: mingwUpstreamSha
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('returns null upstream cursors when cursor branches are missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-uwp-sync-resume-missing-'));
    try {
      const destPath = join(root, 'destination');
      initRepo(destPath);
      runGit(destPath, ['commit', '--allow-empty', '-m', 'base']);

      expect(resolveSyncRetrieveCursorsFromBranches(destPath, config)).toEqual({
        PortsDestSha: null,
        PortsMingwDestSha: null,
        PortsUpstreamSha: null,
        PortsMingwUpstreamSha: null
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('branch-based resume retrieve', () => {
  test('rebuilds remaining queue from upstream-ports and upstream-ports-mingw', async () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-uwp-sync-resume-queue-'));
    try {
      const mirrorPorts = join(root, 'mirror-ports');
      const mirrorMingw = join(root, 'mirror-mingw');
      const destPath = join(root, 'destination');
      initRepo(mirrorPorts);
      initRepo(mirrorMingw);
      initRepo(destPath);

      const portsOne = commitMirror(mirrorPorts, 'pkg/a', 'ports one', 1_700_000_100);
      const portsTwo = commitMirror(mirrorPorts, 'pkg/b', 'ports two', 1_700_000_300);
      const portsThree = commitMirror(mirrorPorts, 'pkg/c', 'ports three', 1_700_000_500);

      const mingwOne = commitMirror(mirrorMingw, 'pkg/x', 'mingw one', 1_700_000_150);
      const mingwTwo = commitMirror(mirrorMingw, 'pkg/y', 'mingw two', 1_700_000_400);

      initializeDestinationAlternates(destPath, [mirrorPorts, mirrorMingw]);
      runGit(destPath, ['commit', '--allow-empty', '-m', 'base']);

      const portsReplayOne = commitDestinationReplay(destPath, 'ports/a.txt', {
        SortKey: 'ports',
        Subject: 'ports one',
        UpstreamRepo: 'msys2/MSYS2-packages',
        UpstreamSha: portsOne,
        DateUnix: 1_700_000_100
      });
      const mingwReplayOne = commitDestinationReplay(destPath, 'ports-mingw/x.txt', {
        SortKey: 'ports-mingw',
        Subject: 'mingw one',
        UpstreamRepo: 'msys2/MINGW-packages',
        UpstreamSha: mingwOne,
        DateUnix: 1_700_000_150
      });
      const portsReplayTwo = commitDestinationReplay(destPath, 'ports/b.txt', {
        SortKey: 'ports',
        Subject: 'ports two',
        UpstreamRepo: 'msys2/MSYS2-packages',
        UpstreamSha: portsTwo,
        DateUnix: 1_700_000_300
      });

      runGit(destPath, ['checkout', '-B', 'upstream', portsReplayTwo]);
      setDestinationBranchSha(destPath, 'upstream-ports', portsReplayTwo);
      setDestinationBranchSha(destPath, 'upstream-ports-mingw', mingwReplayOne);

      const cursors = resolveSyncRetrieveCursorsFromBranches(destPath, config);
      expect(cursors.PortsUpstreamSha).toBe(portsTwo);
      expect(cursors.PortsMingwUpstreamSha).toBe(mingwOne);

      const tipPorts = getMirrorTipSha(mirrorPorts, 'master');
      const tipMingw = getMirrorTipSha(mirrorMingw, 'master');
      const [portsList, mingwList] = await Promise.all([
        getSourceReplayHistory('Ports', config, mirrorPorts, cursors.PortsUpstreamSha, tipPorts),
        getSourceReplayHistory('PortsMingw', config, mirrorMingw, cursors.PortsMingwUpstreamSha, tipMingw)
      ]);

      expect(portsList.map((entry) => entry.Sha)).toEqual([portsThree]);
      expect(mingwList.map((entry) => entry.Sha)).toEqual([mingwTwo]);

      const queue = mergeReplayCommitQueues(portsList, mingwList);
      expect(queue.map((entry) => entry.Sha)).toEqual([mingwTwo, portsThree]);
      expect(queue.map((entry) => entry.SourceId)).toEqual(['ports-mingw', 'ports']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('independent cursor branches resume each source from its own replay point', async () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-uwp-sync-resume-split-'));
    try {
      const mirrorPorts = join(root, 'mirror-ports');
      const mirrorMingw = join(root, 'mirror-mingw');
      const destPath = join(root, 'destination');
      initRepo(mirrorPorts);
      initRepo(mirrorMingw);
      initRepo(destPath);

      const portsDone = commitMirror(mirrorPorts, 'pkg/a', 'ports done', 1_700_000_100);
      const portsPending = commitMirror(mirrorPorts, 'pkg/b', 'ports pending', 1_700_000_400);

      const mingwDone = commitMirror(mirrorMingw, 'pkg/x', 'mingw done', 1_700_000_200);
      const mingwPending = commitMirror(mirrorMingw, 'pkg/y', 'mingw pending', 1_700_000_500);

      initializeDestinationAlternates(destPath, [mirrorPorts, mirrorMingw]);
      runGit(destPath, ['commit', '--allow-empty', '-m', 'base']);

      const portsDestSha = commitDestinationReplay(destPath, 'ports/a.txt', {
        SortKey: 'ports',
        Subject: 'ports done',
        UpstreamRepo: 'msys2/MSYS2-packages',
        UpstreamSha: portsDone,
        DateUnix: 1_700_000_100
      });
      const mingwDestSha = commitDestinationReplay(destPath, 'ports-mingw/x.txt', {
        SortKey: 'ports-mingw',
        Subject: 'mingw done',
        UpstreamRepo: 'msys2/MINGW-packages',
        UpstreamSha: mingwDone,
        DateUnix: 1_700_000_200
      });

      runGit(destPath, ['checkout', '-B', 'upstream', mingwDestSha]);
      setDestinationBranchSha(destPath, 'upstream-ports', portsDestSha);
      setDestinationBranchSha(destPath, 'upstream-ports-mingw', mingwDestSha);

      const cursors = resolveSyncRetrieveCursorsFromBranches(destPath, config);
      const [portsList, mingwList] = await Promise.all([
        getSourceReplayHistory('Ports', config, mirrorPorts, cursors.PortsUpstreamSha, getMirrorTipSha(mirrorPorts, 'master')),
        getSourceReplayHistory('PortsMingw', config, mirrorMingw, cursors.PortsMingwUpstreamSha, getMirrorTipSha(mirrorMingw, 'master'))
      ]);

      expect(portsList.map((entry) => entry.Sha)).toEqual([portsPending]);
      expect(mingwList.map((entry) => entry.Sha)).toEqual([mingwPending]);

      const queue = mergeReplayCommitQueues(portsList, mingwList);
      expect(queue.map((entry) => entry.Sha)).toEqual([portsPending, mingwPending]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
