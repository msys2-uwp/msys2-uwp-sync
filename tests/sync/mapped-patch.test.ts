import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';

import { loadSyncConfig } from '../../src/mirror-merge/config.ts';
import {
  formatMappedUnifiedDiff,
  listMappedPatchPaths,
  resolveMirrorSourceFromCli,
  rewriteUnifiedDiffPaths
} from './helpers/mapped-patch.ts';
import { getFirstParent } from './helpers/replay-git.ts';

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

describe('rewriteUnifiedDiffPaths', () => {
  test('prefixes diff headers with dest subdir', () => {
    const input = [
      'diff --git a/foo/PKGBUILD b/foo/PKGBUILD',
      '--- a/foo/PKGBUILD',
      '+++ b/foo/PKGBUILD',
      '@@ -1 +1 @@',
      '-old',
      '+new'
    ].join('\n');

    expect(rewriteUnifiedDiffPaths(input, 'ports')).toBe([
      'diff --git a/ports/foo/PKGBUILD b/ports/foo/PKGBUILD',
      '--- a/ports/foo/PKGBUILD',
      '+++ b/ports/foo/PKGBUILD',
      '@@ -1 +1 @@',
      '-old',
      '+new'
    ].join('\n'));
  });

  test('rewrites rename lines', () => {
    const input = [
      'diff --git a/old/name b/new/name',
      'rename from old/name',
      'rename to new/name'
    ].join('\n');

    expect(rewriteUnifiedDiffPaths(input, 'ports-mingw')).toBe([
      'diff --git a/ports-mingw/old/name b/ports-mingw/new/name',
      'rename from ports-mingw/old/name',
      'rename to ports-mingw/new/name'
    ].join('\n'));
  });
});

describe('resolveMirrorSourceFromCli', () => {
  test('accepts sort keys and repo names', () => {
    const config = loadSyncConfig();
    expect(resolveMirrorSourceFromCli('ports', config).DestSubdir).toBe('ports');
    expect(resolveMirrorSourceFromCli('ports-mingw', config).DestSubdir).toBe('ports-mingw');
    expect(resolveMirrorSourceFromCli('MSYS2-packages', config).SourceId).toBe('ports');
    expect(resolveMirrorSourceFromCli('MINGW-packages', config).SourceId).toBe('ports-mingw');
  });
});

describe('formatMappedUnifiedDiff', () => {
  test('produces apply-ready paths under dest subdir', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-mapped-patch-'));
    try {
      const mirrorPath = join(root, 'mirror');
      initTestRepo(mirrorPath);

      writeRepoFile(mirrorPath, 'pkg/PKGBUILD', 'pkgver=1\n');
      runGit(mirrorPath, ['add', 'pkg/PKGBUILD']);
      runGit(mirrorPath, ['commit', '-m', 'add pkgbuild']);
      writeRepoFile(mirrorPath, 'pkg/PKGBUILD', 'pkgver=2\n');
      runGit(mirrorPath, ['add', 'pkg/PKGBUILD']);
      runGit(mirrorPath, ['commit', '-m', 'bump version']);
      const commit = runGit(mirrorPath, ['rev-parse', 'HEAD']).trim();
      const parent = getFirstParent(mirrorPath, commit);

      const patch = formatMappedUnifiedDiff(mirrorPath, parent, commit, 'ports');
      expect(patch).toContain('diff --git a/ports/pkg/PKGBUILD b/ports/pkg/PKGBUILD');
      expect(patch).toContain('--- a/ports/pkg/PKGBUILD');
      expect(patch).toContain('+++ b/ports/pkg/PKGBUILD');
      expect(listMappedPatchPaths(mirrorPath, parent, commit, 'ports')).toEqual(['ports/pkg/PKGBUILD']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
