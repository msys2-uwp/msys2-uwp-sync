import { spawnSync } from 'node:child_process';
import { describe, expect, test, vi } from 'vitest';

import { ghCommandAvailable, ghRepoCreate, ghRepoExists } from '../../src/mirror-init/gh.ts';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn()
}));

describe('gh-cli', () => {
  test('ghRepoExists returns true when gh repo view succeeds', () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '',
      stderr: '',
      pid: 1,
      output: ['', '', ''],
      signal: null,
      error: undefined
    });
    expect(ghRepoExists('msys2-apiss', 'aports')).toBe(true);
    expect(spawnSync).toHaveBeenCalledWith('gh', ['repo', 'view', 'msys2-apiss/aports'], expect.any(Object));
  });

  test('ghRepoCreate creates repo when missing', () => {
    const logs: string[] = [];
    const logger = {
      write(message: string) {
        logs.push(message);
      },
      close() {}
    };
    vi.mocked(spawnSync)
      .mockReturnValueOnce({
        status: 1,
        stdout: '',
        stderr: 'Not Found',
        pid: 1,
        output: ['', '', 'Not Found'],
        signal: null,
        error: undefined
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: 'gh version 2.0.0',
        stderr: '',
        pid: 1,
        output: ['', 'gh version 2.0.0', ''],
        signal: null,
        error: undefined
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: '',
        stderr: '',
        pid: 1,
        output: ['', '', ''],
        signal: null,
        error: undefined
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: '',
        stderr: '',
        pid: 1,
        output: ['', '', ''],
        signal: null,
        error: undefined
      });
    ghRepoCreate({
      Owner: 'msys2-apiss',
      RepoName: 'aports',
      Description: 'Alpine Linux aports repository',
      Url: 'https://gitlab.alpinelinux.org/alpine/aports',
      Logger: logger
    });
    expect(spawnSync).toHaveBeenLastCalledWith(
      'gh',
      [
        'repo',
        'create',
        'msys2-apiss/aports',
        '--public',
        '--description',
        'Alpine Linux aports repository',
        '--homepage',
        'https://gitlab.alpinelinux.org/alpine/aports'
      ],
      expect.any(Object)
    );
    expect(logs.some((line) => line.includes('Creating GitHub repo'))).toBe(true);
  });

  test('ghCommandAvailable returns false when gh is missing', () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: '',
      stderr: '',
      pid: 1,
      output: ['', '', ''],
      signal: null,
      error: undefined
    });
    expect(ghCommandAvailable()).toBe(false);
  });
});
