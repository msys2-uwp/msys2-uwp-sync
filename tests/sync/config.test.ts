import { describe, expect, test } from 'vitest';

import { getMirrorPollRepoNames, getSyncRepoRoot, loadSyncConfig } from '../../src/lib/config.ts';
import { getMirrorSyncConfigPath } from '../../src/lib/repos.ts';

describe('getMirrorPollRepoNames', () => {
  test('includes package mirrors and mirror-only repos from sync.json', () => {
    const config = loadSyncConfig();
    expect(getMirrorPollRepoNames(config)).toEqual([
      'MSYS2-packages',
      'MINGW-packages',
      'mingw-w64',
      'glibc',
      'binutils-gdb',
      'elfutils',
      'gcc',
      'enscript'
    ]);
  });

  test('mirror-sync JSON templates exist for each polled mirror', () => {
    const repoRoot = getSyncRepoRoot();
    const config = loadSyncConfig(repoRoot);
    for (const repoName of getMirrorPollRepoNames(config)) {
      expect(getMirrorSyncConfigPath(repoRoot, repoName)).toMatch(/config[/\\]mirror-sync[/\\]/);
    }
  });
});
