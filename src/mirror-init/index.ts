import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { printMirrorInitCliHelp, readFlag, readStringOption, wantsHelp } from './args.ts';
import {
  getMirrorContentBranch,
  getMirrorPollRepoNames,
  getSyncRepoRoot,
  getWorkDirectory,
  loadMirrorSyncConfigFile,
  loadSyncConfig
} from './config.ts';
import {
  initializeDestinationRepository,
  pushDestinationToolingBranch
} from './destination.ts';
import {
  initializeNamedMirrorRepository,
  mirrorOriginHasContent,
  pushMirrorSyncBranch
} from './mirror.ts';
import {
  ghDispatchMirrorBlock,
  ghRepoCreate,
  MIRROR_MERGE_BLOCK,
  MIRROR_SYNC_BLOCK,
  requireGhAuthenticated
} from '../git/gh.ts';
import { runGitText } from '../git/index.ts';
import type { Logger } from '../git/log.ts';
import { MIRROR_MERGE_BRANCH, MIRROR_SYNC_BRANCH } from '../types/constants.ts';

function createLogger(): Logger {
  return {
    write(message, level = 'Info') {
      const prefix =
        level === 'Warn' ? '[mirror-init][warn]' : level === 'Error' ? '[mirror-init][error]' : '[mirror-init]';
      console.log(`${prefix} ${message}`);
    },
    close() {}
  };
}

function pushDestinationRepo(input: {
  RepoPath: string;
  Config: ReturnType<typeof loadSyncConfig>;
  Logger: Logger;
}): void {
  const owner = input.Config.Owner;
  const repo = input.Config.Destination.Repo;
  const defaultBranch = input.Config.Destination.DefaultBranch ?? 'main';
  pushDestinationToolingBranch({ RepoPath: input.RepoPath, Config: input.Config, Logger: input.Logger });
  ghDispatchMirrorBlock(MIRROR_MERGE_BLOCK, owner, repo, defaultBranch, input.Logger);
}

function pushMirrorRepo(input: {
  RepoRoot: string;
  RepoName: string;
  MirrorPath: string;
  ContentBranch: string;
  Config: ReturnType<typeof loadSyncConfig>;
  Logger: Logger;
}): void {
  const owner = input.Config.Owner;
  const mirrorConfig = loadMirrorSyncConfigFile(input.RepoRoot, input.RepoName);
  if (!mirrorOriginHasContent(owner, input.RepoName, input.ContentBranch)) {
    input.Logger.write(`${input.RepoName}: new mirror; ensuring GitHub repo exists`);
    ghRepoCreate({
      Owner: owner,
      RepoName: input.RepoName,
      Description: mirrorConfig?.Description,
      Url: mirrorConfig?.Url,
      Logger: input.Logger
    });
  }
  pushMirrorSyncBranch(input.MirrorPath, input.RepoName, input.Logger);
  ghDispatchMirrorBlock(MIRROR_SYNC_BLOCK, owner, input.RepoName, input.ContentBranch, input.Logger);
}

function runMirrorPollAfterPush(repoRoot: string, logger: Logger): void {
  logger.write('Running yarn mirror-poll after push');
  const result = spawnSync(process.execPath, [join(repoRoot, 'src/mirror-poll/cli.ts')], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env
  });
  if (result.status !== 0) {
    throw new Error(`mirror-poll exited with code ${result.status ?? 'unknown'}`);
  }
}

export async function runMirrorInit(input: {
  Push?: boolean;
  SkipFetch?: boolean;
  RepoFilter?: string;
}): Promise<void> {
  process.env.LANG = 'C.UTF-8';
  process.env.LC_ALL = 'C.UTF-8';
  if (input.Push) {
    requireGhAuthenticated();
  }

  const repoRoot = getSyncRepoRoot();
  const config = loadSyncConfig(repoRoot);
  const work = getWorkDirectory(repoRoot);
  const logger = createLogger();
  logger.write('start');

  if (input.RepoFilter && !getMirrorPollRepoNames(config).includes(input.RepoFilter)) {
    throw new Error(`Unknown mirror repo: ${input.RepoFilter}`);
  }

  const destinationPath = initializeDestinationRepository({
    RepoRoot: repoRoot,
    WorkDirectory: work,
    Config: config,
    SkipFetch: Boolean(input.SkipFetch),
    Logger: logger
  });
  if (input.Push) {
    pushDestinationRepo({ RepoPath: destinationPath, Config: config, Logger: logger });
  }
  const mergeTip = runGitText(destinationPath, ['rev-parse', MIRROR_MERGE_BRANCH]).trim();
  logger.write(
    `${config.Owner}/${config.Destination.Repo}: ${destinationPath} (${MIRROR_MERGE_BRANCH}=${mergeTip.slice(0, 8)})`
  );

  for (const repoName of getMirrorPollRepoNames(config)) {
    if (input.RepoFilter && input.RepoFilter !== repoName) {
      continue;
    }
    const contentBranch = getMirrorContentBranch(repoRoot, repoName);
    const mirrorPath = initializeNamedMirrorRepository({
      WorkDirectory: work,
      RepoName: repoName,
      ContentBranch: contentBranch,
      Config: config,
      SkipFetch: Boolean(input.SkipFetch),
      Logger: logger
    });
    if (input.Push) {
      pushMirrorRepo({
        RepoRoot: repoRoot,
        RepoName: repoName,
        MirrorPath: mirrorPath,
        ContentBranch: contentBranch,
        Config: config,
        Logger: logger
      });
    }
    const syncTip = runGitText(mirrorPath, ['rev-parse', MIRROR_SYNC_BRANCH]).trim();
    const tip = runGitText(mirrorPath, ['rev-parse', contentBranch]).trim();
    logger.write(
      `${repoName}: ${mirrorPath} (msys2-apiss-mirror-sync=${syncTip.slice(0, 8)}, ${contentBranch}=${tip.slice(0, 8)})`
    );
  }

  if (input.Push) {
    runMirrorPollAfterPush(repoRoot, logger);
  }
  logger.write('done');
}

export async function runMirrorInitCli(): Promise<void> {
  const args = process.argv.slice(2);
  if (wantsHelp(args)) {
    printMirrorInitCliHelp();
    return;
  }
  const logger = createLogger();
  try {
    await runMirrorInit({
      Push: readFlag(args, '--push'),
      SkipFetch: readFlag(args, '--skip-fetch'),
      RepoFilter: readStringOption(args, '--repo')
    });
  } catch (error) {
    logger.write(error instanceof Error ? error.message : String(error), 'Error');
    process.exitCode = 1;
  } finally {
    logger.close();
  }
}
