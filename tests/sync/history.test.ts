import { describe, expect, test } from 'vitest';

import { convertFromUpstreamCommitLogMetadataText, parseGitCommitObject } from '../../src/lib/history.ts';

const fieldSep = String.fromCharCode(0x1f);
const recordSep = String.fromCharCode(0x1e);

function newLogRecord(input: {
  Sha: string;
  AuthorName: string;
  AuthorEmail: string;
  AuthorDate: number;
  CommitterName: string;
  CommitterEmail: string;
  CommitterDate: number;
  Message: string;
}): string {
  return [
    input.Sha,
    input.AuthorName,
    input.AuthorEmail,
    input.AuthorDate,
    input.CommitterName,
    input.CommitterEmail,
    input.CommitterDate,
    input.Message
  ].join(fieldSep) + recordSep;
}

describe('convertFromUpstreamCommitLogMetadataText', () => {
  test('parses normal records, empty emails, and merge bodies', () => {
    const normalRecord = newLogRecord({
      Sha: 'a'.repeat(40),
      AuthorName: 'Example User',
      AuthorEmail: 'user@example.com',
      AuthorDate: 1700000000,
      CommitterName: 'Example User',
      CommitterEmail: 'user@example.com',
      CommitterDate: 1700000001,
      Message: 'subject line\n\nbody line\n'
    });
    const emptyEmailRecord = newLogRecord({
      Sha: 'b'.repeat(40),
      AuthorName: 'Mehrdad',
      AuthorEmail: '',
      AuthorDate: 1520670164,
      CommitterName: 'Mehrdad',
      CommitterEmail: '',
      CommitterDate: 1520833463,
      Message: '/etc/post-install and /etc/profile.d script optimizations\n'
    });
    const mergeRecord = newLogRecord({
      Sha: 'c'.repeat(40),
      AuthorName: 'Bot',
      AuthorEmail: 'bot@example.com',
      AuthorDate: 1599130701,
      CommitterName: 'GitHub',
      CommitterEmail: 'noreply@github.com',
      CommitterDate: 1599130701,
      Message: 'Merge pull request #2 from 3rav/3rav-patch-1\n\n3rav patch 1\n'
    });

    const normal = convertFromUpstreamCommitLogMetadataText(normalRecord);
    expect(normal).toHaveLength(1);
    expect(normal[0]?.CommitterName).toBe('Example User');
    expect(normal[0]?.Subject).toBe('subject line');
    expect(normal[0]?.Body.trim()).toBe('body line');

    const merge = convertFromUpstreamCommitLogMetadataText(mergeRecord);
    expect(merge[0]?.Subject).toBe('Merge pull request #2 from 3rav/3rav-patch-1');
    expect(merge[0]?.Body).toBe('3rav patch 1');

    expect(convertFromUpstreamCommitLogMetadataText(normalRecord + emptyEmailRecord)).toHaveLength(2);
    expect(convertFromUpstreamCommitLogMetadataText('')).toHaveLength(0);
  });
});

describe('parseGitCommitObject', () => {
  test('parses author, committer, subject, and body', () => {
    const raw = [
      'tree 1111111111111111111111111111111111111111',
      'parent 2222222222222222222222222222222222222222',
      'author Example User <user@example.com> 1700000000 +0000',
      'committer Example User <user@example.com> 1700000001 +0000',
      '',
      'subject line',
      '',
      'body line'
    ].join('\n');

    const parsed = parseGitCommitObject(raw);
    expect(parsed.AuthorName).toBe('Example User');
    expect(parsed.AuthorEmail).toBe('user@example.com');
    expect(parsed.AuthorDate).toBe(1700000000);
    expect(parsed.CommitterDate).toBe(1700000001);
    expect(parsed.Subject).toBe('subject line');
    expect(parsed.Body.trim()).toBe('body line');
  });

  test('allows empty email and subject-only messages', () => {
    const emptyEmail = parseGitCommitObject([
      'tree 1111111111111111111111111111111111111111',
      'author Mehrdad <> 1520670164 -0800',
      'committer Mehrdad <> 1520833463 -0700',
      '',
      '/etc/post-install and /etc/profile.d script optimizations'
    ].join('\n'));
    expect(emptyEmail.AuthorName).toBe('Mehrdad');
    expect(emptyEmail.AuthorEmail).toBe('');
    expect(emptyEmail.CommitterEmail).toBe('');

    const subjectOnly = parseGitCommitObject([
      'tree 1111111111111111111111111111111111111111',
      'author Bot <bot@example.com> 1700000000 +0000',
      'committer Bot <bot@example.com> 1700000000 +0000',
      '',
      'only subject'
    ].join('\n'));
    expect(subjectOnly.Body).toBe('');
  });

  test('throws when author cannot be parsed', () => {
    expect(() => parseGitCommitObject('tree abc\ncommitter x <x@x.com> 1 +0000\n\nmsg')).toThrow();
  });
});
