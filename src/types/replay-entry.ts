export type SourceKey = 'Ports' | 'PortsMingw';

export interface ReplayEntry {
  Sha: string;
  SourceId: string;
  SortKey: string;
  DestSubdir: string;
  UpstreamRepo: string;
  CommitterDateUnix: number;
  AuthorDateUnix: number;
  AuthorName: string;
  AuthorEmail: string;
  CommitterName: string;
  CommitterEmail: string;
  Subject: string;
  Body: string;
}

export interface UpstreamLogEntry {
  Sha: string;
  AuthorDateUnix: number;
  CommitterDateUnix: number;
  AuthorName: string;
  AuthorEmail: string;
  CommitterName: string;
  CommitterEmail: string;
  Subject: string;
  Body: string;
}

export interface ParsedCommitObject {
  AuthorName: string;
  AuthorEmail: string;
  AuthorDate: number;
  CommitterName: string;
  CommitterEmail: string;
  CommitterDate: number;
  Subject: string;
  Body: string;
}
