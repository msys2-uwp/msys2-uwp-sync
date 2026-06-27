import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';

import { applyMirrorSyncTemplate, bootstrapMirrorFromUpstreamRoot, MIRROR_SYNC_BRANCH, pushMirrorContentBranch, repairSyncBranchLayout } from '../../src/mirror-init/repos.ts';
import { checkoutDestinationReplayBranch } from '../../src/mirror-merge/repos.ts';
import {
  checkoutNewDestinationBranchFromBase,
  resolveUpstreamCursorSha,
  setDestinationBranchSha
} from './helpers/mirror-merge-repos.ts';
import { loadSyncConfig } from '../../src/mirror-merge/config.ts';
import type { Logger } from '../../src/git/log.ts';
import { formatReplayCommitMessage } from '../../src/mirror-merge/replay.ts';
import { mirrorOriginUrlHasContent } from './helpers/mirror-origin.ts';

const replayCommitMessageTemplate = loadSyncConfig().Sources[0]!.CommitMessage;

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
  spawnSync('git', ['init', repoPath], {
    encoding: 'utf8',
    windowsHide: true
  });
  runGit(repoPath, ['config', 'user.name', 'Test User']);
  runGit(repoPath, ['config', 'user.email', 'test@example.com']);
}

describe('setDestinationBranchSha', () => {
  test('updates checked-out branch without branch -f', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-repos-'));
    try {
      const repoPath = join(root, 'repo');
      initTestRepo(repoPath);

      writeFileSync(join(repoPath, 'first.txt'), 'first\n', 'utf8');
      runGit(repoPath, ['add', 'first.txt']);
      runGit(repoPath, ['commit', '-m', 'first']);
      const first = runGit(repoPath, ['rev-parse', 'HEAD']).trim();

      runGit(repoPath, ['checkout', '-B', 'upstream']);
      setDestinationBranchSha(repoPath, 'upstream', first);

      expect(runGit(repoPath, ['rev-parse', 'HEAD']).trim()).toBe(first);
      expect(runGit(repoPath, ['rev-parse', 'upstream']).trim()).toBe(first);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('updates unchecked branch with branch -f', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-repos-'));
    try {
      const repoPath = join(root, 'repo');
      initTestRepo(repoPath);

      writeFileSync(join(repoPath, 'first.txt'), 'first\n', 'utf8');
      runGit(repoPath, ['add', 'first.txt']);
      runGit(repoPath, ['commit', '-m', 'first']);
      const first = runGit(repoPath, ['rev-parse', 'HEAD']).trim();

      writeFileSync(join(repoPath, 'second.txt'), 'second\n', 'utf8');
      runGit(repoPath, ['add', 'second.txt']);
      runGit(repoPath, ['commit', '-m', 'second']);
      const second = runGit(repoPath, ['rev-parse', 'HEAD']).trim();

      runGit(repoPath, ['checkout', '-B', 'upstream', first]);
      setDestinationBranchSha(repoPath, 'upstream-ports', second);

      expect(runGit(repoPath, ['rev-parse', 'HEAD']).trim()).toBe(first);
      expect(runGit(repoPath, ['rev-parse', 'upstream-ports']).trim()).toBe(second);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('checkoutNewDestinationBranchFromBase', () => {
  const logger: Logger = {
    write() {},
    close() {}
  };

  test('creates a new branch from base without moving base', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-repos-new-branch-'));
    try {
      const repoPath = join(root, 'repo');
      initTestRepo(repoPath);

      writeFileSync(join(repoPath, 'first.txt'), 'first\n', 'utf8');
      runGit(repoPath, ['add', 'first.txt']);
      runGit(repoPath, ['commit', '-m', 'first']);
      const first = runGit(repoPath, ['rev-parse', 'HEAD']).trim();

      writeFileSync(join(repoPath, 'second.txt'), 'second\n', 'utf8');
      runGit(repoPath, ['add', 'second.txt']);
      runGit(repoPath, ['commit', '-m', 'second']);
      const second = runGit(repoPath, ['rev-parse', 'HEAD']).trim();

      runGit(repoPath, ['branch', '-f', 'upstream', second]);
      runGit(repoPath, ['checkout', '-B', 'upstream', second]);

      checkoutNewDestinationBranchFromBase(repoPath, 'apply-test', 'upstream', logger);

      expect(runGit(repoPath, ['symbolic-ref', '--short', 'HEAD']).trim()).toBe('apply-test');
      expect(runGit(repoPath, ['rev-parse', 'HEAD']).trim()).toBe(second);
      expect(runGit(repoPath, ['rev-parse', 'upstream']).trim()).toBe(second);
      expect(first).not.toBe(second);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects reusing the base branch name', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-repos-new-branch-reject-'));
    try {
      const repoPath = join(root, 'repo');
      initTestRepo(repoPath);
      runGit(repoPath, ['commit', '--allow-empty', '-m', 'base']);
      runGit(repoPath, ['checkout', '-B', 'upstream']);

      expect(() => checkoutNewDestinationBranchFromBase(repoPath, 'upstream', 'upstream', logger))
        .toThrow('--branch must not be upstream');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('checkoutDestinationReplayBranch', () => {
  test('removes untracked files that block checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-repos-checkout-'));
    try {
      const repoPath = join(root, 'repo');
      initTestRepo(repoPath);

      writeFileSync(join(repoPath, 'tracked.txt'), 'tracked\n', 'utf8');
      runGit(repoPath, ['add', 'tracked.txt']);
      runGit(repoPath, ['commit', '-m', 'tracked']);
      const tip = runGit(repoPath, ['rev-parse', 'HEAD']).trim();

      mkdirSync(join(repoPath, 'ports-mingw/nested'), { recursive: true });
      writeFileSync(join(repoPath, 'ports-mingw/block.txt'), 'untracked\n', 'utf8');
      writeFileSync(join(repoPath, 'ports-mingw/nested/other.txt'), 'other\n', 'utf8');

      checkoutDestinationReplayBranch(repoPath, 'upstream', tip);

      expect(runGit(repoPath, ['rev-parse', 'HEAD']).trim()).toBe(tip);
      expect(runGit(repoPath, ['symbolic-ref', '--short', 'HEAD']).trim()).toBe('upstream');
      expect(() => runGit(repoPath, ['status', '--porcelain'])).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('resolveUpstreamCursorSha', () => {
  test('reads upstream sha from destination replay commit', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-repos-cursor-'));
    try {
      const destPath = join(root, 'destination');
      initTestRepo(destPath);

      const upstreamSha = 'f'.repeat(40);

      mkdirSync(join(destPath, 'ports'), { recursive: true });
      writeFileSync(join(destPath, 'ports/foo.txt'), 'foo\n', 'utf8');
      runGit(destPath, ['add', 'ports/foo.txt']);
      runGit(destPath, [
        'commit',
        '-m',
        formatReplayCommitMessage({
          Template: replayCommitMessageTemplate,
          SortKey: 'ports',
          Metadata: { Subject: 'sync foo', Body: '' },
          UpstreamRepo: 'msys2/MSYS2-packages',
          UpstreamSha: upstreamSha
        })
      ]);
      const destSha = runGit(destPath, ['rev-parse', 'HEAD']).trim();

      expect(resolveUpstreamCursorSha(destPath, destSha, 'msys2/MSYS2-packages')).toBe(upstreamSha);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('returns null when commit message has no source footer', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-repos-cursor-empty-'));
    try {
      const destPath = join(root, 'destination');
      initTestRepo(destPath);
      runGit(destPath, ['commit', '--allow-empty', '-m', 'base']);
      const destSha = runGit(destPath, ['rev-parse', 'HEAD']).trim();

      expect(resolveUpstreamCursorSha(destPath, destSha, 'msys2/MSYS2-packages')).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('repairSyncBranchLayout', () => {
  const noopLogger: Logger = {
    write() {},
    close() {}
  };

  test('squashes sync to one commit on master root', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-repair-sync-'));
    try {
      const repoPath = join(root, 'mirror');
      initTestRepo(repoPath);

      writeFileSync(join(repoPath, 'pkg.txt'), 'pkg\n', 'utf8');
      runGit(repoPath, ['add', 'pkg.txt']);
      runGit(repoPath, ['commit', '-m', 'root']);
      const masterRoot = runGit(repoPath, ['rev-parse', 'HEAD']).trim();

      writeFileSync(join(repoPath, 'pkg2.txt'), 'pkg2\n', 'utf8');
      runGit(repoPath, ['add', 'pkg2.txt']);
      runGit(repoPath, ['commit', '-m', 'second']);
      const masterTip = runGit(repoPath, ['rev-parse', 'HEAD']).trim();

      runGit(repoPath, ['update-ref', 'refs/remotes/origin/master', masterTip]);

      runGit(repoPath, ['checkout', '--orphan', MIRROR_SYNC_BRANCH]);
      mkdirSync(join(repoPath, '.github', 'workflows'), { recursive: true });
      writeFileSync(join(repoPath, '.github', 'workflows', 'mirror-sync.yml'), 'name: test\n', 'utf8');
      runGit(repoPath, ['add', '.github']);
      runGit(repoPath, ['commit', '-m', 'workflow stack 1']);
      runGit(repoPath, ['commit', '--allow-empty', '-m', 'workflow stack 2']);

      const repaired = repairSyncBranchLayout(repoPath, 'master', noopLogger);
      expect(repaired).toBe(true);

      const syncOnly = runGit(repoPath, ['rev-list', '--count', MIRROR_SYNC_BRANCH, '^origin/master']).trim();
      expect(syncOnly).toBe('1');
      expect(runGit(repoPath, ['rev-parse', `${MIRROR_SYNC_BRANCH}^`]).trim()).toBe(masterRoot);
      expect(runGit(repoPath, ['log', '-1', '--format=%s', MIRROR_SYNC_BRANCH]).trim()).toBe(
        'Mirror sync workflow from msys2-apiss-sync'
      );
      expect(runGit(repoPath, ['log', '-1', '--format=%b', MIRROR_SYNC_BRANCH]).trim()).toBe(
        'https://github.com/msys2-apiss/msys2-apiss-sync/tree/main/config/mirror-sync\n' +
          'https://github.com/msys2-apiss/msys2-apiss-sync/blob/main/config/mirror-template/mirror-sync.yml'
      );
      expect(
        runGit(repoPath, ['rev-parse', `${MIRROR_SYNC_BRANCH}:.github/workflows/mirror-sync.yml`]).trim()
      ).toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('applyMirrorSyncTemplate', () => {
  const noopLogger: Logger = {
    write() {},
    close() {}
  };

  test('copies config/mirror-sync JSON into sync commit', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-apply-mirror-'));
    try {
      const syncRepoRoot = join(root, 'sync-repo');
      const mirrorPath = join(root, 'mirror');
      mkdirSync(join(syncRepoRoot, 'config', 'mirror-sync'), { recursive: true });
      mkdirSync(join(syncRepoRoot, 'config', 'mirror-template'), { recursive: true });
      writeFileSync(
        join(syncRepoRoot, 'config', 'mirror-sync', 'mirror.json'),
        '{"UpstreamUrl":"https://example.com/up.git","Branches":[{"Upstream":"master","Mirror":"master"}]}\n',
        'utf8'
      );
      writeFileSync(join(syncRepoRoot, 'config', 'mirror-template', 'mirror-sync.yml'), 'name: test\n', 'utf8');

      initTestRepo(mirrorPath);
      writeFileSync(join(mirrorPath, 'pkg.txt'), 'pkg\n', 'utf8');
      runGit(mirrorPath, ['add', 'pkg.txt']);
      runGit(mirrorPath, ['commit', '-m', 'root']);
      const masterRoot = runGit(mirrorPath, ['rev-parse', 'HEAD']).trim();
      runGit(mirrorPath, ['update-ref', 'refs/remotes/origin/master', masterRoot]);

      runGit(mirrorPath, ['checkout', '-b', MIRROR_SYNC_BRANCH, masterRoot]);
      mkdirSync(join(mirrorPath, '.github', 'workflows'), { recursive: true });
      writeFileSync(join(mirrorPath, '.github', 'workflows', 'old.yml'), 'old\n', 'utf8');
      runGit(mirrorPath, ['add', '.github']);
      runGit(mirrorPath, ['commit', '-m', 'old workflow']);

      applyMirrorSyncTemplate({
        MirrorPath: mirrorPath,
        RepoName: 'mirror',
        ContentBranch: 'master',
        Logger: noopLogger,
        RepoRoot: syncRepoRoot
      });

      expect(runGit(mirrorPath, ['rev-parse', `${MIRROR_SYNC_BRANCH}:.github/mirror-sync.json`]).trim()).toBeTruthy();
      expect(
        runGit(mirrorPath, ['rev-parse', `${MIRROR_SYNC_BRANCH}:.github/workflows/mirror-sync.yml`]).trim()
      ).toBeTruthy();
      expect(runGit(mirrorPath, ['rev-parse', `${MIRROR_SYNC_BRANCH}^`]).trim()).toBe(masterRoot);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('skips when templates and layout already match', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-apply-skip-'));
    try {
      const syncRepoRoot = join(root, 'sync-repo');
      const mirrorPath = join(root, 'mirror');
      mkdirSync(join(syncRepoRoot, 'config', 'mirror-sync'), { recursive: true });
      mkdirSync(join(syncRepoRoot, 'config', 'mirror-template'), { recursive: true });
      writeFileSync(
        join(syncRepoRoot, 'config', 'mirror-sync', 'mirror.json'),
        '{"UpstreamUrl":"https://example.com/up.git","Branches":[{"Upstream":"master","Mirror":"master"}]}\n',
        'utf8'
      );
      writeFileSync(join(syncRepoRoot, 'config', 'mirror-template', 'mirror-sync.yml'), 'name: test\n', 'utf8');

      initTestRepo(mirrorPath);
      writeFileSync(join(mirrorPath, 'pkg.txt'), 'pkg\n', 'utf8');
      runGit(mirrorPath, ['add', 'pkg.txt']);
      runGit(mirrorPath, ['commit', '-m', 'root']);
      const masterRoot = runGit(mirrorPath, ['rev-parse', 'HEAD']).trim();
      runGit(mirrorPath, ['update-ref', 'refs/remotes/origin/master', masterRoot]);

      runGit(mirrorPath, ['checkout', '-b', MIRROR_SYNC_BRANCH, masterRoot]);
      mkdirSync(join(mirrorPath, '.github', 'workflows'), { recursive: true });
      writeFileSync(join(mirrorPath, '.github', 'workflows', 'old.yml'), 'old\n', 'utf8');
      runGit(mirrorPath, ['add', '.github']);
      runGit(mirrorPath, ['commit', '-m', 'old workflow']);

      applyMirrorSyncTemplate({
        MirrorPath: mirrorPath,
        RepoName: 'mirror',
        ContentBranch: 'master',
        Logger: noopLogger,
        RepoRoot: syncRepoRoot
      });
      const syncSha = runGit(mirrorPath, ['rev-parse', MIRROR_SYNC_BRANCH]).trim();

      const skipped = applyMirrorSyncTemplate({
        MirrorPath: mirrorPath,
        RepoName: 'mirror',
        ContentBranch: 'master',
        Logger: noopLogger,
        RepoRoot: syncRepoRoot
      });
      expect(skipped).toBe(false);
      expect(runGit(mirrorPath, ['rev-parse', MIRROR_SYNC_BRANCH]).trim()).toBe(syncSha);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('bootstrapMirrorFromUpstreamRoot', () => {
  const noopLogger: Logger = {
    write() {},
    close() {}
  };

  test('checks out root commit of upstream content branch only', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-bootstrap-root-'));
    try {
      const upstreamPath = join(root, 'upstream.git');
      const mirrorPath = join(root, 'mirror');
      spawnSync('git', ['init', '--bare', upstreamPath], { encoding: 'utf8', windowsHide: true });

      const workPath = join(root, 'work');
      initTestRepo(workPath);
      writeFileSync(join(workPath, 'root.txt'), 'root\n', 'utf8');
      runGit(workPath, ['add', 'root.txt']);
      runGit(workPath, ['commit', '-m', 'root']);
      const rootSha = runGit(workPath, ['rev-parse', 'HEAD']).trim();
      writeFileSync(join(workPath, 'tip.txt'), 'tip\n', 'utf8');
      runGit(workPath, ['add', 'tip.txt']);
      runGit(workPath, ['commit', '-m', 'tip']);
      runGit(workPath, ['push', '-u', upstreamPath, 'master']);

      bootstrapMirrorFromUpstreamRoot({
        UpstreamUrl: upstreamPath,
        OriginUrl: 'https://example.com/empty.git',
        MirrorPath: mirrorPath,
        ContentBranch: 'master',
        RepoName: 'test-mirror',
        Logger: noopLogger
      });

      expect(runGit(mirrorPath, ['rev-parse', 'master']).trim()).toBe(rootSha);
      expect(runGit(mirrorPath, ['rev-parse', MIRROR_SYNC_BRANCH]).trim()).toBe(rootSha);
      expect(runGit(mirrorPath, ['rev-parse', 'refs/remotes/origin/master']).trim()).toBe(rootSha);
      expect(runGit(mirrorPath, ['rev-list', '--count', 'master']).trim()).toBe('1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('mirrorOriginUrlHasContent', () => {
  test('returns false for empty bare origin', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-origin-empty-'));
    try {
      const bare = join(root, 'origin.git');
      spawnSync('git', ['init', '--bare', bare], { encoding: 'utf8', windowsHide: true });
      expect(mirrorOriginUrlHasContent(bare, 'master')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('returns true when content branch exists on origin', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-origin-branch-'));
    try {
      const bare = join(root, 'origin.git');
      const work = join(root, 'work');
      spawnSync('git', ['init', '--bare', bare], { encoding: 'utf8', windowsHide: true });
      initTestRepo(work);
      writeFileSync(join(work, 'f.txt'), 'x\n', 'utf8');
      runGit(work, ['add', 'f.txt']);
      runGit(work, ['commit', '-m', 'init']);
      runGit(work, ['push', '-u', bare, 'master']);
      expect(mirrorOriginUrlHasContent(bare, 'master')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('pushMirrorContentBranch', () => {
  test('skips push when remote content branch is ahead of local', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-push-content-'));
    const logs: string[] = [];
    const logger: Logger = {
      write(message: string) {
        logs.push(message);
      },
      close() {}
    };
    try {
      const originBare = join(root, 'origin.git');
      const mirrorPath = join(root, 'mirror');
      spawnSync('git', ['init', '--bare', originBare], { encoding: 'utf8', windowsHide: true });

      initTestRepo(mirrorPath);
      writeFileSync(join(mirrorPath, 'old.txt'), 'old\n', 'utf8');
      runGit(mirrorPath, ['add', 'old.txt']);
      runGit(mirrorPath, ['commit', '-m', 'old']);
      const oldSha = runGit(mirrorPath, ['rev-parse', 'HEAD']).trim();

      const originWork = join(root, 'origin-work');
      initTestRepo(originWork);
      writeFileSync(join(originWork, 'old.txt'), 'old\n', 'utf8');
      runGit(originWork, ['add', 'old.txt']);
      runGit(originWork, ['commit', '-m', 'old']);
      writeFileSync(join(originWork, 'new.txt'), 'new\n', 'utf8');
      runGit(originWork, ['add', 'new.txt']);
      runGit(originWork, ['commit', '-m', 'new']);
      const newSha = runGit(originWork, ['rev-parse', 'HEAD']).trim();
      runGit(originWork, ['remote', 'add', 'origin', originBare]);
      runGit(originWork, ['push', '-u', 'origin', 'master']);

      runGit(mirrorPath, ['remote', 'add', 'origin', originBare]);
      runGit(mirrorPath, ['fetch', 'origin']);
      runGit(mirrorPath, ['checkout', '-B', 'master', oldSha]);

      const pushed = pushMirrorContentBranch(mirrorPath, 'master', 'test-mirror', logger);
      expect(pushed).toBe(false);
      expect(
        logs.some(
          (line) => line.includes('skip content push') || line.includes('already on origin')
        )
      ).toBe(true);
      expect(runGit(originBare, ['rev-parse', 'refs/heads/master']).trim()).toBe(newSha);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
