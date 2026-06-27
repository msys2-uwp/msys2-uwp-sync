import { describe, expect, test } from 'vitest';

import { mirrorRepoNeedsSync, mirrorRepoPollStatus, parseGitHubRepoFromUrl } from '../../src/mirror-poll/index.ts';
import type { MirrorSyncConfig } from '../../src/types/mirror-sync-config.ts';

function mirrorConfig(overrides: Partial<MirrorSyncConfig> = {}): MirrorSyncConfig {
  return {
    UpstreamUrl: 'https://github.com/msys2/MSYS2-packages.git',
    Branches: [{ Upstream: 'master', Mirror: 'master' }],
    ...overrides
  };
}

describe('parseGitHubRepoFromUrl', () => {
  test('parses https and git@ GitHub URLs', () => {
    expect(parseGitHubRepoFromUrl('https://github.com/msys2/MSYS2-packages.git')).toEqual({
      Owner: 'msys2',
      Repo: 'MSYS2-packages'
    });
    expect(parseGitHubRepoFromUrl('git@github.com:msys2/MINGW-packages.git')).toEqual({
      Owner: 'msys2',
      Repo: 'MINGW-packages'
    });
  });

  test('returns null for non-GitHub upstream', () => {
    expect(parseGitHubRepoFromUrl('https://gcc.gnu.org/git/gcc.git')).toBeNull();
  });
});

describe('mirrorRepoNeedsSync', () => {
  test('returns false when mirror and upstream SHAs match', async () => {
    await expect(mirrorRepoNeedsSync({
      RepoName: 'mirror',
      MirrorOwner: 'msys2-apiss',
      MirrorConfig: mirrorConfig(),
      GetUpstreamSha: () => 'abc123',
      GetMirrorSha: () => 'abc123'
    })).resolves.toBe(false);
  });

  test('returns true when mirror SHA differs from upstream', async () => {
    await expect(mirrorRepoNeedsSync({
      RepoName: 'mirror',
      MirrorOwner: 'msys2-apiss',
      MirrorConfig: mirrorConfig(),
      GetUpstreamSha: () => 'def456',
      GetMirrorSha: () => 'abc123'
    })).resolves.toBe(true);
  });

  test('returns true when mirror branch is missing on GitHub', async () => {
    await expect(mirrorRepoNeedsSync({
      RepoName: 'mirror',
      MirrorOwner: 'msys2-apiss',
      MirrorConfig: mirrorConfig(),
      GetUpstreamSha: () => 'def456',
      GetMirrorSha: () => null
    })).resolves.toBe(true);
  });

  test('returns true when mirror-sync config is missing', async () => {
    await expect(mirrorRepoNeedsSync({
      RepoName: 'mirror',
      MirrorOwner: 'msys2-apiss',
      MirrorConfig: null
    })).resolves.toBe(false);
    await expect(mirrorRepoPollStatus({
      RepoName: 'mirror',
      MirrorOwner: 'msys2-apiss',
      MirrorConfig: null
    })).resolves.toBe('invalid');
  });

  test('returns invalid when upstream is not on GitHub', async () => {
    await expect(mirrorRepoNeedsSync({
      RepoName: 'gcc',
      MirrorOwner: 'msys2-apiss',
      MirrorConfig: mirrorConfig({
        UpstreamUrl: 'https://gcc.gnu.org/git/gcc.git'
      }),
      GetMirrorSha: () => 'abc123'
    })).resolves.toBe(false);
    await expect(mirrorRepoPollStatus({
      RepoName: 'gcc',
      MirrorOwner: 'msys2-apiss',
      MirrorConfig: mirrorConfig({
        UpstreamUrl: 'https://gcc.gnu.org/git/gcc.git'
      }),
      GetMirrorSha: () => 'abc123'
    })).resolves.toBe('invalid');
  });
});
