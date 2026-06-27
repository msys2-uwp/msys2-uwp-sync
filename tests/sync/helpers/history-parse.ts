import { existsSync, readFileSync } from 'node:fs';

import { convertToUnixLineEndings } from '../../../src/mirror-merge/log.ts';
import type { ParsedCommitObject } from '../../../src/mirror-merge/replay-entry.ts';

export function parseGitCommitObject(rawInput: string): ParsedCommitObject {
  const raw = convertToUnixLineEndings(rawInput);
  let authorName: string | null = null;
  let authorEmail: string | null = null;
  let authorDate = 0;
  let committerName: string | null = null;
  let committerEmail: string | null = null;
  let committerDate = 0;

  for (const line of raw.split('\n')) {
    const author = /^author (.+?) <([^>]*)> (\d+) /.exec(line);
    if (author) {
      authorName = author[1]!.trim();
      authorEmail = author[2]!;
      authorDate = Number(author[3]);
      continue;
    }

    const committer = /^committer (.+?) <([^>]*)> (\d+) /.exec(line);
    if (committer) {
      committerName = committer[1]!.trim();
      committerEmail = committer[2]!;
      committerDate = Number(committer[3]);
    }
  }

  if (!authorName || authorEmail === null) {
    const preview = raw.split('\n').slice(0, 6).join('; ');
    throw new Error(`Could not parse author from git commit object. Header: ${preview}`);
  }

  if (!committerName || committerEmail === null) {
    committerName = authorName;
    committerEmail = authorEmail;
  }
  if (committerDate === 0) {
    committerDate = authorDate;
  }

  const blankIdx = raw.indexOf('\n\n');
  const message = blankIdx >= 0 ? raw.slice(blankIdx + 2).replace(/\n+$/g, '') : '';
  const [subject = '', body = ''] = message.split(/\n([\s\S]*)/, 2);

  return {
    AuthorName: authorName,
    AuthorEmail: authorEmail,
    AuthorDate: authorDate,
    CommitterName: committerName,
    CommitterEmail: committerEmail,
    CommitterDate: committerDate,
    Subject: subject,
    Body: body.replace(/\s+$/g, '')
  };
}
