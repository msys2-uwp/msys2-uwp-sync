import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { MirrorSyncConfig } from '../types/mirror-sync-config.ts';

export interface SyncConfig {
  Owner: string;
  Destination: {
    Repo: string;
    Url?: string;
  };
  Mirrors: {
    Repos: string[];
  };
}

export const MIRROR_SYNC_BRANCH = 'msys2-apiss-mirror-sync';
export const MIRROR_MERGE_BRANCH = 'msys2-apiss-mirror-merge';

export function getSyncRepoRoot(startPath = dirname(fileURLToPath(import.meta.url))): string {
  let current = startPath;
  while (true) {
    try {
      readFileSync(join(current, 'config', 'sync.json'), 'utf8');
      return current;
    } catch {
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

export function getMirrorPollRepoNames(config: SyncConfig): string[] {
  return config.Mirrors.Repos;
}

export function getMirrorCloneUrl(config: SyncConfig, repoName: string): string {
  return `https://github.com/${config.Owner}/${repoName}.git`;
}

export function getDestinationCloneUrl(config: SyncConfig): string {
  return config.Destination.Url ?? `https://github.com/${config.Owner}/${config.Destination.Repo}.git`;
}

export function getMirrorSyncConfigPath(repoRoot: string, repoName: string): string {
  return join(repoRoot, 'config', 'mirror-sync', `${repoName}.json`);
}

export function loadMirrorSyncConfigFile(repoRoot: string, repoName: string): MirrorSyncConfig | null {
  const configPath = getMirrorSyncConfigPath(repoRoot, repoName);
  if (!existsSync(configPath)) {
    return null;
  }
  return JSON.parse(readFileSync(configPath, 'utf8')) as MirrorSyncConfig;
}

export function getMirrorContentBranch(repoRoot: string, repoName: string): string {
  const mirrorConfig = loadMirrorSyncConfigFile(repoRoot, repoName);
  const branch = mirrorConfig?.Branches?.[0]?.Mirror;
  if (!branch) {
    throw new Error(`config/mirror-sync/${repoName}.json: missing Branches[0].Mirror`);
  }
  return branch;
}

export function getMirrorSyncWorkflowTemplatePath(repoRoot: string): string {
  return join(repoRoot, 'config', 'mirror-template', 'mirror-sync.yml');
}

export function getMirrorMergeWorkflowTemplatePath(repoRoot: string): string {
  return join(repoRoot, 'config', 'mirror-template', 'mirror-merge.yml');
}

export function getWorkDirectory(repoRoot: string): string {
  return join(repoRoot, '.work');
}
