/** Block 3 tooling branch on each msys2-apiss/* mirror repo. */
export const MIRROR_SYNC_BRANCH = 'msys2-apiss-mirror-sync';

/** Block 4 tooling branch on destination repo msys2-apiss/msys2-apiss. */
export const MIRROR_MERGE_BRANCH = 'msys2-apiss-mirror-merge';

/** Block 2 -> Block 3 workflow_dispatch input on mirror-sync.yml. */
export const WORKFLOW_DISPATCH_MIRROR_SYNC = 'workflow_dispatch_mirror_sync';

/** Block 3 -> Block 4 workflow_dispatch input on mirror-merge.yml. */
export const WORKFLOW_DISPATCH_MIRROR_MERGE = 'workflow_dispatch_mirror_merge';

export const GITHUB_API = 'https://api.github.com';

/** Block 3 TypeScript bundle installed on mirror branch by mirror-init. */
export const MIRROR_SYNC_TOOLINGS_DIR = '.github/toolings';

/** Block 4 replay config in the tooling repo and bundled toolings. */
export const MIRROR_MERGE_CONFIG_PATH = 'config/mirror-merge.json';

/** Block 2 poll config in the tooling repo. */
export const MIRROR_POLL_CONFIG_PATH = 'config/mirror-poll.json';
