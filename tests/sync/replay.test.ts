import { describe, expect, test } from 'vitest';

import { formatGitReplayDateEnv, formatReplayCommitMessage } from '../../src/lib/replay.ts';

describe('formatReplayCommitMessage', () => {
  test('formats message with body', () => {
    expect(formatReplayCommitMessage({
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

describe('formatGitReplayDateEnv', () => {
  test('uses git epoch-date syntax', () => {
    expect(formatGitReplayDateEnv(1700000000)).toBe('@1700000000');
    expect(formatGitReplayDateEnv(1700000001)).toBe('@1700000001');
    expect(formatGitReplayDateEnv(1700000000)).not.toBe(formatGitReplayDateEnv(1700000001));
  });
});
