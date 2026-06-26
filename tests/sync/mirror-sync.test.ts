import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';

import {
  configureMirrorSyncPushTransport,
  getMirrorSyncNotify,
  mirrorBranchNeedsUpdate,
  runMirrorSync,
  shouldDispatchMirrorMerge,
  validateMirrorSyncConfig,
  writeGitHubOutput,
  type Logger
} from '../../src/mirror-sync/index.ts';
import type { MirrorSyncConfig } from '../../src/types/mirror-sync-config.ts';

const noopLogger: Logger = {
  write() {},
  close() {}
};

function runGit(repoPath: string | null, args: string[]): string {
  const result = spawnSync('git', repoPath ? ['-C', repoPath, ...args] : args, {
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout).trim());
  }
  return result.stdout;
}

function initRepo(repoPath: string): void {
  runGit(null, ['init', '-b', 'master', repoPath]);
  runGit(repoPath, ['config', 'user.name', 'Test User']);
  runGit(repoPath, ['config', 'user.email', 'test@example.com']);
}

function mirrorConfig(upstreamUrl: string, overrides: Partial<MirrorSyncConfig> = {}): MirrorSyncConfig {
  return {
    UpstreamUrl: upstreamUrl,
    Branches: [{ Upstream: 'master', Mirror: 'master' }],
    SyncTags: false,
    ...overrides
  };
}

describe('mirrorBranchNeedsUpdate', () => {
  test('requires update when origin is missing or differs', () => {
    expect(mirrorBranchNeedsUpdate(null, 'abc')).toBe(true);
    expect(mirrorBranchNeedsUpdate('abc', 'def')).toBe(true);
    expect(mirrorBranchNeedsUpdate('abc', 'abc')).toBe(false);
  });
});

describe('validateMirrorSyncConfig', () => {
  test('requires an upstream url and branch mappings', () => {
    expect(() => validateMirrorSyncConfig(mirrorConfig('https://example.com/upstream.git'))).not.toThrow();
    expect(() => validateMirrorSyncConfig({ ...mirrorConfig(''), UpstreamUrl: '' })).toThrow('UpstreamUrl');
    expect(() => validateMirrorSyncConfig({ ...mirrorConfig('https://example.com/upstream.git'), Branches: [] }))
      .toThrow('Branches');
  });
});

describe('getMirrorSyncNotify', () => {
  test('returns configured package mirror notification target', () => {
    expect(getMirrorSyncNotify(mirrorConfig('https://example.com/upstream.git', {
      Notify: {
        Enabled: true,
        Repository: 'msys2-apiss/msys2-apiss-sync',
        EventType: 'workflow_dispatch_mirror_merge'
      }
    }))).toEqual({
      Enabled: true,
      Repository: 'msys2-apiss/msys2-apiss-sync',
      EventType: 'workflow_dispatch_mirror_merge'
    });
  });

  test('defaults EventType when notify is enabled without EventType', () => {
    expect(getMirrorSyncNotify(mirrorConfig('https://example.com/upstream.git', {
      Notify: {
        Enabled: true,
        Repository: 'msys2-apiss/msys2-apiss-sync'
      }
    }))).toEqual({
      Enabled: true,
      Repository: 'msys2-apiss/msys2-apiss-sync',
      EventType: 'workflow_dispatch_mirror_merge'
    });
  });
});

describe('shouldDispatchMirrorMerge', () => {
  test('is true only when mirror advanced and notify is enabled', () => {
    expect(shouldDispatchMirrorMerge({
      Advanced: true,
      Notify: { Enabled: true, Repository: 'msys2-apiss/msys2-apiss-sync' }
    })).toBe(true);
    expect(shouldDispatchMirrorMerge({
      Advanced: true,
      Notify: { Enabled: false }
    })).toBe(false);
    expect(shouldDispatchMirrorMerge({
      Advanced: false,
      Notify: { Enabled: true, Repository: 'msys2-apiss/msys2-apiss-sync' }
    })).toBe(false);
  });
});

describe('configureMirrorSyncPushTransport', () => {
  test('sets GitHub SSH push URL when PushViaSsh is true', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-mirror-sync-ssh-'));
    try {
      const mirrorPath = join(root, 'mirror');
      initRepo(mirrorPath);
      runGit(mirrorPath, ['remote', 'add', 'origin', 'https://github.com/msys2-apiss/gcc.git']);

      configureMirrorSyncPushTransport(
        mirrorPath,
        mirrorConfig('https://example.com/upstream.git', { PushViaSsh: true }),
        noopLogger
      );

      expect(runGit(mirrorPath, ['remote', 'get-url', '--push', 'origin']).trim()).toBe(
        'git@github.com:msys2-apiss/gcc.git'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('runMirrorSync', () => {
  test('pushes an upstream branch into the mirror origin', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-mirror-sync-'));
    try {
      const upstreamPath = join(root, 'upstream');
      const mirrorPath = join(root, 'mirror');
      const originPath = join(root, 'origin.git');

      initRepo(upstreamPath);
      writeFileSync(join(upstreamPath, 'pkg.txt'), 'pkg\n', 'utf8');
      runGit(upstreamPath, ['add', 'pkg.txt']);
      runGit(upstreamPath, ['commit', '-m', 'upstream package']);
      const upstreamTip = runGit(upstreamPath, ['rev-parse', 'HEAD']).trim();

      runGit(null, ['init', '--bare', originPath]);
      initRepo(mirrorPath);
      runGit(mirrorPath, ['remote', 'add', 'origin', originPath]);

      const first = runMirrorSync({
        RepoPath: mirrorPath,
        Config: mirrorConfig(upstreamPath),
        Logger: noopLogger
      });
      expect(first.Advanced).toBe(true);
      expect(first.DispatchMirrorMerge).toBe(false);
      expect(first.PrimarySha).toBe(upstreamTip);
      expect(runGit(originPath, ['rev-parse', 'master']).trim()).toBe(upstreamTip);

      const second = runMirrorSync({
        RepoPath: mirrorPath,
        Config: mirrorConfig(upstreamPath),
        Logger: noopLogger
      });
      expect(second.Advanced).toBe(false);
      expect(second.DispatchMirrorMerge).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('sets DispatchMirrorMerge when advanced and notify enabled', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-mirror-sync-dispatch-'));
    try {
      const upstreamPath = join(root, 'upstream');
      const mirrorPath = join(root, 'mirror');
      const originPath = join(root, 'origin.git');

      initRepo(upstreamPath);
      writeFileSync(join(upstreamPath, 'pkg.txt'), 'pkg\n', 'utf8');
      runGit(upstreamPath, ['add', 'pkg.txt']);
      runGit(upstreamPath, ['commit', '-m', 'upstream package']);

      runGit(null, ['init', '--bare', originPath]);
      initRepo(mirrorPath);
      runGit(mirrorPath, ['remote', 'add', 'origin', originPath]);

      const result = runMirrorSync({
        RepoPath: mirrorPath,
        Config: mirrorConfig(upstreamPath, {
          Notify: {
            Enabled: true,
            Repository: 'msys2-apiss/msys2-apiss-sync'
          }
        }),
        Logger: noopLogger
      });
      expect(result.Advanced).toBe(true);
      expect(result.DispatchMirrorMerge).toBe(true);
      expect(result.Notify.EventType).toBe('workflow_dispatch_mirror_merge');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('writeGitHubOutput', () => {
  test('writes dispatch_mirror_merge output', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-mirror-sync-output-'));
    const outputPath = join(root, 'github-output.txt');
    try {
      writeGitHubOutput(outputPath, {
        Advanced: true,
        PrimarySha: 'abc123',
        PrimaryRef: 'refs/heads/master',
        DispatchMirrorMerge: true,
        Notify: {
          Enabled: true,
          Repository: 'msys2-apiss/msys2-apiss-sync',
          EventType: 'workflow_dispatch_mirror_merge'
        },
        Branches: []
      });
      const text = readFileSync(outputPath, 'utf8');
      expect(text).toContain('dispatch_mirror_merge=true');
      expect(text).toContain('notify_event_type=workflow_dispatch_mirror_merge');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
