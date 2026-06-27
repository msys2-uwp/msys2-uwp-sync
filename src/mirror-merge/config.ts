import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MIRROR_MERGE_CONFIG_PATH } from '../types/constants.ts';

export type { Logger } from '../git/log.ts';

export interface SourceConfigEntry {
  Repo: string;
  Branch: string;
  DestSubdir: string;
  SortKey: string;
  CursorBranch: string;
  UpstreamRepo: string;
  CommitMessage: string;
}

export interface SyncConfig {
  ReplaySpecVersion: number;
  Owner: string;
  Destination: {
    Repo: string;
    Url?: string;
    BaseCommit: string;
    ReplayTip: string;
  };
  Sources: SourceConfigEntry[];
  Replay: {
    MinReplayAgeMinutes?: number;
    SkipEmptyTreeDiff: boolean;
    LineEnding: string;
  };
}

export function getSyncRepoRoot(startPath = dirname(fileURLToPath(import.meta.url))): string {
  let current = startPath;
  while (true) {
    try {
      readFileSync(join(current, MIRROR_MERGE_CONFIG_PATH), 'utf8');
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        throw new Error(`Could not locate sync repo root (${MIRROR_MERGE_CONFIG_PATH} not found).`);
      }
      current = parent;
    }
  }
}

export function loadSyncConfig(repoRoot = getSyncRepoRoot(), configPath?: string): SyncConfig {
  const path = configPath ?? join(repoRoot, MIRROR_MERGE_CONFIG_PATH);
  return JSON.parse(readFileSync(path, 'utf8')) as SyncConfig;
}

export function getDestinationCloneUrl(config: SyncConfig): string {
  return config.Destination.Url ?? `https://github.com/${config.Owner}/${config.Destination.Repo}.git`;
}

export function getMirrorCloneUrlForSource(config: SyncConfig, source: SourceConfigEntry): string {
  return `https://github.com/${config.Owner}/${source.Repo}.git`;
}

export function getSourceConfigEntry(config: SyncConfig, sourceId: string): SourceConfigEntry {
  const normalized = sourceId.trim().toLowerCase();
  for (const entry of config.Sources) {
    if (
      entry.SortKey === sourceId ||
      entry.SortKey === normalized ||
      entry.Repo === sourceId ||
      entry.Repo.toLowerCase() === normalized ||
      entry.UpstreamRepo.toLowerCase() === normalized ||
      `${config.Owner}/${entry.Repo}`.toLowerCase() === normalized
    ) {
      return entry;
    }
  }
  throw new Error(`Unknown source: ${sourceId}`);
}
