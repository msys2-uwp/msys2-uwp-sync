import { runGitText } from '../../../src/git/index.ts';
import { getFirstParentFromMap, type CommitParentMap } from '../../../src/mirror-merge/queue.ts';

export function getFirstParent(mirrorPath: string, commit: string): string {
  const line = runGitText(mirrorPath, ['rev-list', '--parents', '-n', '1', commit]).trim();
  if (!line) {
    return getFirstParentFromMap(new Map(), commit);
  }
  const parts = line.split(/\s+/);
  const parentMap: CommitParentMap = new Map([[parts[0]!, parts.slice(1)]]);
  return getFirstParentFromMap(parentMap, commit);
}
