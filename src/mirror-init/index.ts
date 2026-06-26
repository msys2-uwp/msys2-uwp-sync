import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { printMirrorInitCliHelp, readFlag, readStringOption, wantsHelp } from './args.ts';
import {
  getMirrorContentBranch,
  getMirrorPollRepoNames,
  getSyncRepoRoot,
  getWorkDirectory,
  loadMirrorSyncConfigFile,
  loadSyncConfig,
  MIRROR_SYNC_BRANCH
} from './config.ts';
import { installMirrorMergeWorkflow } from './destination.ts';
import { ghRepoCreate, requireGhAuthenticated } from './gh.ts';
import {
  initializeNamedMirrorRepository,
  mirrorOriginHasContent,
  pushMirrorContentBranch,
  pushMirrorSyncBranch
} from './repos.ts';
import { runGitText } from '../git/index.ts';
import type { Logger } from '../git/log.ts';

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

function getBranchTip(mirrorPath: string, branch: string): string {
  return runGitText(mirrorPath, ['rev-parse', branch]).trim();
}

function runMirrorPollSubprocess(repoRoot: string, logger: Logger): void {
  const pollCli = join(repoRoot, 'src', 'mirror-poll', 'cli.ts');
  logger.write('Running mirror-poll after push');
  const result = spawnSync(process.execPath, [pollCli], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  if (result.stdout) {
    for (const line of result.stdout.split(/\r?\n/)) {
      if (line) {
        logger.write(line);
      }
    }
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(detail || 'mirror-poll failed');
  }
}

async function pushMirrorRepo(input: {
  RepoRoot: string;
  RepoName: string;
  MirrorPath: string;
  ContentBranch: string;
  Config: ReturnType<typeof loadSyncConfig>;
  Logger: Logger;
}): Promise<void> {
  const mirrorConfig = loadMirrorSyncConfigFile(input.RepoRoot, input.RepoName);
  const isNewMirror = !mirrorOriginHasContent(input.Config.Owner, input.RepoName, input.ContentBranch);
  if (isNewMirror) {
    input.Logger.write(`${input.RepoName}: new mirror; ensuring GitHub repo exists`);
    ghRepoCreate({
      Owner: input.Config.Owner,
      RepoName: input.RepoName,
      Description: mirrorConfig?.Description,
      Url: mirrorConfig?.Url,
      Logger: input.Logger
    });
  }
  pushMirrorContentBranch(input.MirrorPath, input.ContentBranch, input.RepoName, input.Logger);
  pushMirrorSyncBranch(input.MirrorPath, input.RepoName, input.Logger);
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
      await pushMirrorRepo({
        RepoRoot: repoRoot,
        RepoName: repoName,
        MirrorPath: mirrorPath,
        ContentBranch: contentBranch,
        Config: config,
        Logger: logger
      });
    }
    const syncTip = getBranchTip(mirrorPath, MIRROR_SYNC_BRANCH);
    const tip = getBranchTip(mirrorPath, contentBranch);
    logger.write(`${repoName}: ${mirrorPath} (msys2-apiss-mirror-sync=${syncTip.slice(0, 8)}, ${contentBranch}=${tip.slice(0, 8)})`);
  }

  installMirrorMergeWorkflow({
    RepoRoot: repoRoot,
    WorkDirectory: work,
    Config: config,
    Push: Boolean(input.Push),
    Logger: logger
  });

  if (input.Push) {
    runMirrorPollSubprocess(repoRoot, logger);
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
