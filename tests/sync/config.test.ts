import { describe, expect, test } from 'vitest';

import {
  getMirrorPollRepoNames,
  getMirrorSyncConfigPath,
  getSyncRepoRoot,
  loadMirrorPollConfig,
  loadSyncConfig
} from '../../src/mirror-init/config.ts';

describe('getMirrorPollRepoNames', () => {
  test('includes package mirrors and mirror-only repos from mirror-poll.json', () => {
    const mirrorPollConfig = loadMirrorPollConfig();
    expect(getMirrorPollRepoNames(mirrorPollConfig)).toEqual([
      'MSYS2-packages',
      'MINGW-packages',
      'mingw-w64',
      'glibc',
      'binutils-gdb',
      'elfutils',
      'gcc',
      'enscript',
      'aports',
      'musl'
    ]);
  });

  test('mirror-sync JSON templates exist for each polled mirror', () => {
    const repoRoot = getSyncRepoRoot();
    const mirrorPollConfig = loadMirrorPollConfig(repoRoot);
    for (const repoName of getMirrorPollRepoNames(mirrorPollConfig)) {
      expect(getMirrorSyncConfigPath(repoRoot, repoName)).toMatch(/config[/\\]mirror-sync[/\\]/);
    }
  });

  test('mirror-merge.json no longer contains Mirrors', () => {
    const syncConfig = loadSyncConfig();
    expect(syncConfig).not.toHaveProperty('Mirrors');
  });
});
