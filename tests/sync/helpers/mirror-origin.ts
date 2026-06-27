import { execSync } from 'node:child_process';

import { MIRROR_SYNC_BRANCH } from '../../../src/mirror-init/config.ts';

function remoteHasGitBranch(url: string, branch: string): boolean {
  try {
    const out = execSync(`git ls-remote "${url}" "refs/heads/${branch}"`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

export function mirrorOriginUrlHasContent(originUrl: string, contentBranch: string): boolean {
  return (
    remoteHasGitBranch(originUrl, contentBranch) ||
    remoteHasGitBranch(originUrl, MIRROR_SYNC_BRANCH)
  );
}
