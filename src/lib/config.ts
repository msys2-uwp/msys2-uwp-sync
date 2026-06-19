import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SourceKey } from '../types/replay-entry.ts';

export interface SourceConfigEntry {
  Owner: string;
  Repo: string;
  Branch: string;
  DestSubdir: string;
  SortKey: string;
}

export interface SyncConfig {
  ReplaySpecVersion: number;
  Destination: {
    Owner: string;
    Repo: string;
    Url?: string;
    BaseCommit: string;
    Branches: {
      Replay: string;
      CursorPorts: string;
      CursorPortsMingw: string;
    };
  };
  Sources: Record<SourceKey, SourceConfigEntry>;
  Mirrors: {
    Owner: string;
    Ports: string;
    PortsMingw: string;
    SyncIntervalMinutes: number;
    DispatchEventType: string;
  };
  Replay: {
    MinReplayAgeMinutes?: number;
    SkipEmptyTreeDiff: boolean;
    LineEnding: string;
    CommitMessagePrefix: boolean;
  };
  PollIntervalMinutes: number;
  DailyReconciliationCron: string;
}

export function getSyncRepoRoot(startPath = dirname(fileURLToPath(import.meta.url))): string {
  let current = startPath;
  while (true) {
    try {
      readFileSync(join(current, 'config', 'sync.json'), 'utf8');
      return current;
    } catch (error) {
      const parent = dirname(current);
      if (parent === current) {
        throw new Error('Could not locate sync repo root (config/sync.json not found).');
      }
      current = parent;
    }
  }
}

export function loadSyncConfig(repoRoot = getSyncRepoRoot(), configPath?: string): SyncConfig {
  const path = configPath ?? join(repoRoot, 'config', 'sync.json');
  return JSON.parse(readFileSync(path, 'utf8')) as SyncConfig;
}

export function getSourceRepoSlug(sourceEntry: SourceConfigEntry): string {
  return `${sourceEntry.Owner}/${sourceEntry.Repo}`;
}

export function getSourceCloneUrl(sourceEntry: SourceConfigEntry): string {
  return `https://github.com/${getSourceRepoSlug(sourceEntry)}.git`;
}

export function getDestinationCloneUrl(config: SyncConfig): string {
  return config.Destination.Url ?? `https://github.com/${config.Destination.Owner}/${config.Destination.Repo}.git`;
}

export function getMirrorCloneUrl(config: SyncConfig, mirrorKey: SourceKey): string {
  return `https://github.com/${config.Mirrors.Owner}/${config.Mirrors[mirrorKey]}.git`;
}

export function getSourceConfigEntry(config: SyncConfig, sourceKey: SourceKey): SourceConfigEntry {
  return config.Sources[sourceKey];
}
