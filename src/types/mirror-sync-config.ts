export interface MirrorSyncBranchPair {
  Upstream: string;
  Mirror: string;
}

export interface MirrorSyncConfig {
  UpstreamUrl: string;
  Branches: MirrorSyncBranchPair[];
  /** Upstream project home page (not the git clone URL). */
  Url?: string;
  /** GitHub repo description used by gh repo create on first push. */
  Description?: string;
  /** When true, push to GitHub via SSH; requires MIRROR_PUSH_SSH_KEY (e.g. gcc). Default false (HTTPS). */
  PushViaSsh?: boolean;
  SyncTags?: boolean;
  Notify?: {
    Enabled?: boolean;
    Repository?: string;
    /** workflow_dispatch input for mirror-merge.yml (defaults to WORKFLOW_DISPATCH_MIRROR_MERGE). */
    EventType?: string;
  };
}
