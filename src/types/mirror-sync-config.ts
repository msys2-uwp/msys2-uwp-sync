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
/** repository_dispatch event-type for Block 4 (mirror-merge); not Block 3 trigger. */
    EventType?: string;
  };
}
