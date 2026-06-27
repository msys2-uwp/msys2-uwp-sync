import { describe, expect, test } from 'vitest';

import {
  getMirrorPollRepoNames,
  getMirrorSyncConfigPath,
  getSyncRepoRoot,
  loadMirrorPollConfig
} from '../../src/mirror-init/config.ts';
import { loadSyncConfig } from '../../src/mirror-merge/config.ts';

describe('getMirrorPollRepoNames', () => {
  test('includes package mirrors and mirror-only repos from mirror-poll.json', () => {
    const mirrorPollConfig = loadMirrorPollConfig();
    expect(mirrorPollConfig.Owner).toBe('msys2-apiss');
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

  test('mirror-poll Destination matches mirror-merge Destination', () => {
    const mirrorPollConfig = loadMirrorPollConfig();
    const mergeConfig = loadSyncConfig();
    expect(mirrorPollConfig.Owner).toBe(mergeConfig.Owner);
    expect(mirrorPollConfig.Destination.Repo).toBe(mergeConfig.Destination.Repo);
  });

  test('mirror-merge.json no longer contains Mirrors', () => {
    const mergeConfig = loadSyncConfig();
    expect(mergeConfig).not.toHaveProperty('Mirrors');
  });
});
