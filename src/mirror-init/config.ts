import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { MirrorSyncConfig } from '../types/mirror-sync-config.ts';
import { MIRROR_POLL_CONFIG_PATH } from '../types/constants.ts';

export interface MirrorPollConfig {
  Owner: string;
  Destination: {
    Repo: string;
    DefaultBranch?: string;
  };
  Repos: string[];
}

export { MIRROR_MERGE_BRANCH, MIRROR_SYNC_BRANCH } from '../types/constants.ts';

export function getSyncRepoRoot(startPath = dirname(fileURLToPath(import.meta.url))): string {
  let current = startPath;
  while (true) {
    try {
      readFileSync(join(current, MIRROR_POLL_CONFIG_PATH), 'utf8');
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        throw new Error(`Could not locate sync repo root (${MIRROR_POLL_CONFIG_PATH} not found).`);
      }
      current = parent;
    }
  }
}

export function getMirrorPollConfigPath(repoRoot: string): string {
  return join(repoRoot, MIRROR_POLL_CONFIG_PATH);
}

export function loadMirrorPollConfig(repoRoot = getSyncRepoRoot(), configPath?: string): MirrorPollConfig {
  const path = configPath ?? getMirrorPollConfigPath(repoRoot);
  return JSON.parse(readFileSync(path, 'utf8')) as MirrorPollConfig;
}

export function getMirrorPollRepoNames(mirrorPollConfig: MirrorPollConfig): string[] {
  return mirrorPollConfig.Repos;
}

export function getMirrorCloneUrl(owner: string, repoName: string): string {
  return `https://github.com/${owner}/${repoName}.git`;
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
