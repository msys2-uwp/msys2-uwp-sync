import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import type { SyncConfig } from './config.ts';
import { writeJsonFile } from './log.ts';

export interface ReplayCheckpoint {
  ReplaySpecVersion: number;
  DryRun: boolean;
  LastPortsSha: string | null;
  LastPortsMingwSha: string | null;
  ReplayTipSha: string | null;
  ProcessedCount: number;
  UpdatedAt: string;
}

export function getReplayCheckpointPath(workDirectory: string): string {
  return join(workDirectory, 'cache', 'replay-log', 'replay-checkpoint.json');
}

export function getReplayCheckpoint(workDirectory: string): ReplayCheckpoint | null {
  const path = getReplayCheckpointPath(workDirectory);
  if (!existsSync(path)) {
    return null;
  }
  const raw = readFileSync(path, 'utf8');
  if (!raw.trim()) {
    return null;
  }
  return JSON.parse(raw) as ReplayCheckpoint;
}

export function saveReplayCheckpoint(input: {
  WorkDirectory: string;
  Config: SyncConfig;
  DryRun: boolean;
  LastPortsSha: string | null;
  LastPortsMingwSha: string | null;
  ReplayTipSha: string | null;
  ProcessedCount: number;
}): void {
  const payload: ReplayCheckpoint = {
    ReplaySpecVersion: input.Config.ReplaySpecVersion,
    DryRun: input.DryRun,
    LastPortsSha: input.LastPortsSha,
    LastPortsMingwSha: input.LastPortsMingwSha,
    ReplayTipSha: input.ReplayTipSha,
    ProcessedCount: input.ProcessedCount,
    UpdatedAt: new Date().toISOString()
  };
  writeJsonFile(getReplayCheckpointPath(input.WorkDirectory), payload);
}

export function clearReplayCheckpoint(workDirectory: string): void {
  const path = getReplayCheckpointPath(workDirectory);
  if (existsSync(path)) {
    rmSync(path, { force: true });
  }
}
