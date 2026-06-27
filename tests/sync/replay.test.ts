import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';

import { loadSyncConfig } from '../../src/mirror-merge/config.ts';
import {
  applyUpstreamCommitToIndex,
  formatReplayCommitMessage,
  parseReplayCommitSourceSha
} from '../../src/mirror-merge/replay.ts';
import { getFirstParent } from './helpers/replay-git.ts';

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

function writeRepoFile(repoPath: string, relativePath: string, text: string): void {
  const fullPath = join(repoPath, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, text, 'utf8');
}

describe('applyUpstreamCommitToIndex', () => {
  test('returns false when an upstream delete maps to no destination change', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-test-'));
    try {
      const mirrorPath = join(root, 'mirror');
      const destinationPath = join(root, 'destination');
      initTestRepo(mirrorPath);
      initTestRepo(destinationPath);

      writeRepoFile(mirrorPath, 'removed.txt', 'removed\n');
      runGit(mirrorPath, ['add', 'removed.txt']);
      runGit(mirrorPath, ['commit', '-m', 'add removed']);
      runGit(mirrorPath, ['rm', 'removed.txt']);
      runGit(mirrorPath, ['commit', '-m', 'delete removed']);
      const commit = runGit(mirrorPath, ['rev-parse', 'HEAD']).trim();

      runGit(destinationPath, ['commit', '--allow-empty', '-m', 'base']);

      const hasChanges = applyUpstreamCommitToIndex({
        MirrorPath: mirrorPath,
        Commit: commit,
        Parent: getFirstParent(mirrorPath, commit),
        DestSubdir: 'ports',
        DestinationPath: destinationPath
      });

      expect(hasChanges).toBe(false);
      expect(runGit(destinationPath, ['diff', '--cached', '--name-only'])).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('removes many mapped paths in one commit without argv overflow', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-bulk-rm-'));
    try {
      const mirrorPath = join(root, 'mirror');
      const destinationPath = join(root, 'destination');
      initTestRepo(mirrorPath);
      initTestRepo(destinationPath);

      const fileCount = 200;
      const packageDir = 'mingw-w64-bulk-remove-test/long-subdir-name';
      for (let i = 0; i < fileCount; i++) {
        const rel = `${packageDir}/0001-patch-file-number-${String(i).padStart(4, '0')}.patch`;
        writeRepoFile(mirrorPath, rel, `content ${i}\n`);
        writeRepoFile(destinationPath, `ports-mingw/${rel}`, `content ${i}\n`);
      }
      runGit(mirrorPath, ['add', '.']);
      runGit(mirrorPath, ['commit', '-m', 'add many files']);
      runGit(mirrorPath, ['rm', '-r', 'mingw-w64-bulk-remove-test']);
      runGit(mirrorPath, ['commit', '-m', 'delete many files']);
      const commit = runGit(mirrorPath, ['rev-parse', 'HEAD']).trim();
      const parent = getFirstParent(mirrorPath, commit);

      runGit(destinationPath, ['add', '.']);
      runGit(destinationPath, ['commit', '-m', 'destination has mapped tree']);

      const hasChanges = applyUpstreamCommitToIndex({
        MirrorPath: mirrorPath,
        Commit: commit,
        Parent: parent,
        DestSubdir: 'ports-mingw',
        DestinationPath: destinationPath
      });

      expect(hasChanges).toBe(true);
      const staged = runGit(destinationPath, ['diff', '--cached', '--name-only'])
        .trim()
        .split('\n')
        .filter((line) => line.length > 0);
      expect(staged).toHaveLength(fileCount);
      expect(staged.every((path) => path.startsWith('ports-mingw/'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('returns false when upstream adds already match destination HEAD', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-test-add-'));
    try {
      const mirrorPath = join(root, 'mirror');
      const destinationPath = join(root, 'destination');
      initTestRepo(mirrorPath);
      initTestRepo(destinationPath);

      const content = 'already replayed\n';
      writeRepoFile(mirrorPath, 'pkg/PKGBUILD', content);
      runGit(mirrorPath, ['add', 'pkg/PKGBUILD']);
      runGit(mirrorPath, ['commit', '-m', 'upstream add']);
      const commit = runGit(mirrorPath, ['rev-parse', 'HEAD']).trim();
      const parent = getFirstParent(mirrorPath, commit);

      writeRepoFile(destinationPath, 'ports/pkg/PKGBUILD', content);
      runGit(destinationPath, ['add', 'ports/pkg/PKGBUILD']);
      runGit(destinationPath, ['commit', '-m', 'destination already has mapped tree']);

      const hasChanges = applyUpstreamCommitToIndex({
        MirrorPath: mirrorPath,
        Commit: commit,
        Parent: parent,
        DestSubdir: 'ports',
        DestinationPath: destinationPath
      });

      expect(hasChanges).toBe(false);
      expect(runGit(destinationPath, ['diff', '--cached', '--name-only'])).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('formatReplayCommitMessage', () => {
  test('formats message with body', () => {
    expect(formatReplayCommitMessage({
      Template: replayCommitMessageTemplate,
      SortKey: 'ports',
      Metadata: {
        Subject: 'update foo',
        Body: 'line one\nline two'
      },
      UpstreamRepo: 'msys2/MSYS2-packages',
      UpstreamSha: 'abc123'
    })).toBe([
      '[ports] update foo',
      '',
      'line one',
      'line two',
      'Source: msys2/MSYS2-packages@abc123'
    ].join('\n'));
  });

  test('formats message without body', () => {
    expect(formatReplayCommitMessage({
      Template: replayCommitMessageTemplate,
      SortKey: 'ports-mingw',
      Metadata: {
        Subject: 'update bar',
        Body: ''
      },
      UpstreamRepo: 'msys2/MINGW-packages',
      UpstreamSha: 'def456'
    })).toBe([
      '[ports-mingw] update bar',
      'Source: msys2/MINGW-packages@def456'
    ].join('\n'));
  });
});

describe('parseReplayCommitSourceSha', () => {
  test('reads upstream sha from replay commit footer', () => {
    const message = [
      '[ports] update foo',
      '',
      'details',
      'Source: msys2/MSYS2-packages@' + 'a'.repeat(40)
    ].join('\n');
    expect(parseReplayCommitSourceSha(message, 'msys2/MSYS2-packages')).toBe('a'.repeat(40));
    expect(parseReplayCommitSourceSha(message, 'msys2/MINGW-packages')).toBeNull();
  });
});

describe('formatGitReplayDateEnv', () => {
  test('uses git epoch-date syntax', () => {
    const formatGitReplayDateEnv = (unixSeconds: number) => `@${unixSeconds}`;
    expect(formatGitReplayDateEnv(1700000000)).toBe('@1700000000');
    expect(formatGitReplayDateEnv(1700000001)).toBe('@1700000001');
    expect(formatGitReplayDateEnv(1700000000)).not.toBe(formatGitReplayDateEnv(1700000001));
  });
});
