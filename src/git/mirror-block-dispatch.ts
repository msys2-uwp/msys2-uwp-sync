import {
  MIRROR_MERGE_BRANCH,
  MIRROR_SYNC_BRANCH,
  WORKFLOW_DISPATCH_MIRROR_MERGE,
  WORKFLOW_DISPATCH_MIRROR_SYNC
} from '../types/constants.ts';

export type GhDispatchAttemptResult = {
  ok: boolean;
  skipped?: boolean;
  notFound?: boolean;
  forbidden?: boolean;
  detail?: string;
};

export type MirrorBlockDispatchSpec = {
  Block: string;
  ToolingBranch: string;
  WorkflowFile: string;
  WorkflowInputs: readonly (readonly [string, string])[];
};

export const MIRROR_SYNC_BLOCK: MirrorBlockDispatchSpec = {
  Block: 'mirror-sync',
  ToolingBranch: MIRROR_SYNC_BRANCH,
  WorkflowFile: 'mirror-sync.yml',
  WorkflowInputs: [['event_type', WORKFLOW_DISPATCH_MIRROR_SYNC]]
};

export const MIRROR_MERGE_BLOCK: MirrorBlockDispatchSpec = {
  Block: 'mirror-merge',
  ToolingBranch: MIRROR_MERGE_BRANCH,
  WorkflowFile: 'mirror-merge.yml',
  WorkflowInputs: [['event_type', WORKFLOW_DISPATCH_MIRROR_MERGE]]
};

export function parseGhDispatchFailure(detail: string): Omit<GhDispatchAttemptResult, 'ok'> {
  const detailLower = detail.toLowerCase();
  return {
    notFound: detailLower.includes('404') || detailLower.includes('not found'),
    forbidden:
      detailLower.includes('403') ||
      detailLower.includes('resource not accessible') ||
      detailLower.includes('must have admin rights'),
    detail: detail || undefined
  };
}
