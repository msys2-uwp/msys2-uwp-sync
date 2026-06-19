import type { ParsedCommitObject, ReplayEntry, SourceKey, UpstreamLogEntry } from '../types/replay-entry.ts';
import { getSourceConfigEntry, getSourceRepoSlug, type SyncConfig } from './config.ts';
import { convertToUnixLineEndings, splitCommitMessage } from './log.ts';
import { runGitText } from './git.ts';

export function getUpstreamCommitLogMetadataFormat(): string {
  return '%H%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%B%x1e';
}

export function convertFromUpstreamCommitLogMetadataText(text: string): UpstreamLogEntry[] {
  const normalized = convertToUnixLineEndings(text).trim();
  if (!normalized) {
    return [];
  }

  const recordSep = String.fromCharCode(0x1e);
  const fieldSep = String.fromCharCode(0x1f);
  const entries: UpstreamLogEntry[] = [];

  for (const rawRecord of normalized.split(recordSep)) {
    const record = rawRecord.trim();
    if (!record) {
      continue;
    }

    const parts = record.split(fieldSep);
    if (parts.length < 8) {
      const preview = record.slice(0, 120);
      throw new Error(`Invalid upstream commit log record (expected 8 fields, got ${parts.length}): ${preview}`);
    }

    const message = parts.slice(7).join(fieldSep).replace(/\n+$/g, '');
    const split = splitCommitMessage(message);
    entries.push({
      Sha: parts[0]!,
      AuthorDateUnix: Number(parts[3]),
      CommitterDateUnix: Number(parts[6]),
      AuthorName: parts[1]!,
      AuthorEmail: parts[2]!,
      CommitterName: parts[4]!,
      CommitterEmail: parts[5]!,
      Subject: split.Subject,
      Body: split.Body
    });
  }

  return entries;
}

export function exportUpstreamCommitLogRawText(
  mirrorPath: string,
  afterSha: string | null,
  untilSha: string,
  branch = 'master'
): string {
  const range = afterSha ? `${afterSha}..${untilSha}` : untilSha;
  const text = runGitText(mirrorPath, ['log', '--reverse', `--format=${getUpstreamCommitLogMetadataFormat()}`, range]);
  return convertToUnixLineEndings(text).trim();
}

export function getMirrorTipSha(mirrorPath: string, branch = 'master'): string {
  return runGitText(mirrorPath, ['rev-parse', branch]).trim();
}

export function newReplayCommitEntry(sourceId: SourceKey, logEntry: UpstreamLogEntry, config: SyncConfig): ReplayEntry {
  const sourceEntry = getSourceConfigEntry(config, sourceId);
  return {
    Sha: logEntry.Sha,
    SourceId: sourceEntry.SortKey,
    SortKey: sourceEntry.SortKey,
    DestSubdir: sourceEntry.DestSubdir,
    UpstreamRepo: getSourceRepoSlug(sourceEntry),
    CommitterDateUnix: logEntry.CommitterDateUnix,
    AuthorDateUnix: logEntry.AuthorDateUnix,
    AuthorName: logEntry.AuthorName,
    AuthorEmail: logEntry.AuthorEmail,
    CommitterName: logEntry.CommitterName,
    CommitterEmail: logEntry.CommitterEmail,
    Subject: logEntry.Subject,
    Body: logEntry.Body
  };
}

export function getSourceReplayHistory(
  sourceKey: SourceKey,
  config: SyncConfig,
  mirrorPath: string,
  afterSha: string | null,
  untilSha: string
): ReplayEntry[] {
  const sourceEntry = getSourceConfigEntry(config, sourceKey);
  const text = exportUpstreamCommitLogRawText(mirrorPath, afterSha, untilSha, sourceEntry.Branch);
  return convertFromUpstreamCommitLogMetadataText(text).map((entry) => newReplayCommitEntry(sourceKey, entry, config));
}

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
