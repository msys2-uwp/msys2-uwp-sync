import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { runGit, runGitText, githubSshPushUrl } from '../git/index.ts';
import type { Logger } from '../git/log.ts';
import type { MirrorSyncBranchPair, MirrorSyncConfig } from '../types/mirror-sync-config.ts';

export type { Logger } from '../git/log.ts';

export const MIRROR_MERGE_DISPATCH_EVENT = 'workflow_dispatch_mirror_merge';

export interface MirrorSyncBranchResult {
  Upstream: string;
  Mirror: string;
  BeforeSha: string | null;
  AfterSha: string;
  Advanced: boolean;
}

export interface MirrorSyncResult {
  Advanced: boolean;
  PrimarySha: string | null;
  PrimaryRef: string | null;
  /** True when mirror advanced and Notify.Enabled: dispatch Block 4 CI. */
  DispatchMirrorMerge: boolean;
  Notify: {
    Enabled: boolean;
    Repository?: string;
    EventType?: string;
  };
  Branches: MirrorSyncBranchResult[];
}

export interface MirrorSyncOptions {
  RepoPath: string;
  Config: MirrorSyncConfig;
  Logger: Logger;
}

export function loadMirrorSyncConfig(path: string): MirrorSyncConfig {
  if (!existsSync(path)) {
    throw new Error(`Missing ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as MirrorSyncConfig;
}

export function validateMirrorSyncConfig(config: MirrorSyncConfig): void {
  if (!config.UpstreamUrl) {
    throw new Error('UpstreamUrl is required');
  }
  if (!config.Branches?.length) {
    throw new Error('Branches must contain at least one entry');
  }
  for (const branch of config.Branches) {
    if (!branch.Upstream || !branch.Mirror) {
      throw new Error('Each Branches entry must include Upstream and Mirror');
    }
  }
}

export function mirrorBranchNeedsUpdate(beforeSha: string | null, afterSha: string): boolean {
  return beforeSha !== afterSha;
}

export function getMirrorSyncNotify(config: MirrorSyncConfig): MirrorSyncResult['Notify'] {
  if (!config.Notify?.Enabled) {
    return { Enabled: false };
  }
  return {
    Enabled: true,
    Repository: config.Notify.Repository,
    EventType: config.Notify.EventType ?? MIRROR_MERGE_DISPATCH_EVENT
  };
}

export function shouldDispatchMirrorMerge(result: Pick<MirrorSyncResult, 'Advanced' | 'Notify'>): boolean {
  return result.Advanced && result.Notify.Enabled;
}

function getRefSha(repoPath: string, ref: string): string | null {
  try {
    return runGitText(repoPath, ['rev-parse', ref]).trim() || null;
  } catch {
    return null;
  }
}

function ensureUpstreamRemote(repoPath: string, upstreamUrl: string): void {
  try {
    runGit(repoPath, ['remote', 'add', 'upstream', upstreamUrl], {}, 1);
  } catch {
    runGit(repoPath, ['remote', 'set-url', 'upstream', upstreamUrl], {}, 1);
  }
}

/** When PushViaSsh: use git@github.com push URL (auth via ssh-agent / MIRROR_PUSH_SSH_KEY in CI). */
export function configureMirrorSyncPushTransport(
  repoPath: string,
  config: MirrorSyncConfig,
  logger: Logger
): void {
  if (config.PushViaSsh) {
    if (!process.env.SSH_AUTH_SOCK) {
      logger.write(
        'PushViaSsh: SSH_AUTH_SOCK is unset; load MIRROR_PUSH_SSH_KEY into ssh-agent before push',
        'Warn'
      );
    }
    let originUrl: string;
    try {
      originUrl = runGitText(repoPath, ['remote', 'get-url', 'origin']).trim();
    } catch {
      return;
    }
    const sshUrl = githubSshPushUrl(originUrl);
    if (!sshUrl) {
      logger.write('PushViaSsh: origin is not a GitHub HTTPS URL; skipping SSH push URL setup', 'Warn');
      return;
    }
    let pushUrl = originUrl;
    try {
      pushUrl = runGitText(repoPath, ['remote', 'get-url', '--push', 'origin']).trim();
    } catch {
      // no separate push URL yet
    }
    if (pushUrl !== sshUrl) {
      runGit(repoPath, ['remote', 'set-url', '--push', 'origin', sshUrl], {}, 5, logger);
    }
    logger.write(`Push transport: SSH (${sshUrl})`);
    return;
  }
  runGit(null, ['config', '--global', 'http.version', 'HTTP/1.1'], {}, 1, logger);
  runGit(null, ['config', '--global', 'http.postBuffer', '524288000'], {}, 1, logger);
  logger.write('Push transport: HTTPS');
}

function syncMirrorBranch(input: {
  RepoPath: string;
  Branch: MirrorSyncBranchPair;
  Logger: Logger;
}): MirrorSyncBranchResult {
  const { RepoPath, Branch, Logger } = input;
  Logger.write(`Syncing ${Branch.Upstream} -> ${Branch.Mirror}`);

  runGit(RepoPath, ['fetch', 'upstream', Branch.Upstream], {}, 5, Logger);
  try {
    runGit(RepoPath, ['fetch', 'origin', Branch.Mirror], {}, 5, Logger);
  } catch {
    // First push for an empty mirror may not have origin/<branch> yet.
  }

  const beforeSha = getRefSha(RepoPath, `origin/${Branch.Mirror}`);
  const afterSha = runGitText(RepoPath, ['rev-parse', `upstream/${Branch.Upstream}`]).trim();
  if (!mirrorBranchNeedsUpdate(beforeSha, afterSha)) {
    Logger.write(`No upstream changes for ${Branch.Mirror}.`);
    return {
      Upstream: Branch.Upstream,
      Mirror: Branch.Mirror,
      BeforeSha: beforeSha,
      AfterSha: afterSha,
      Advanced: false
    };
  }

  Logger.write(`Advanced ${Branch.Mirror} from ${beforeSha ?? '<none>'} to ${afterSha}`);
  runGit(RepoPath, ['push', 'origin', `upstream/${Branch.Upstream}:refs/heads/${Branch.Mirror}`], {}, 5, Logger);
  return {
    Upstream: Branch.Upstream,
    Mirror: Branch.Mirror,
    BeforeSha: beforeSha,
    AfterSha: afterSha,
    Advanced: true
  };
}

export function runMirrorSync(input: MirrorSyncOptions): MirrorSyncResult {
  validateMirrorSyncConfig(input.Config);
  ensureUpstreamRemote(input.RepoPath, input.Config.UpstreamUrl);
  configureMirrorSyncPushTransport(input.RepoPath, input.Config, input.Logger);

  const branches = input.Config.Branches.map((branch) =>
    syncMirrorBranch({
      RepoPath: input.RepoPath,
      Branch: branch,
      Logger: input.Logger
    })
  );
  const advancedBranches = branches.filter((branch) => branch.Advanced);

  if (input.Config.SyncTags ?? true) {
    input.Logger.write('Syncing tags from upstream');
    runGit(input.RepoPath, ['fetch', 'upstream', '--tags'], {}, 5, input.Logger);
    try {
      runGit(input.RepoPath, ['push', 'origin', '--tags'], {}, 5, input.Logger);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.Logger.write(`Tag push failed: ${message}`, 'Warn');
    }
  }

  const primary = advancedBranches[0] ?? null;
  const notify = getMirrorSyncNotify(input.Config);
  const advanced = advancedBranches.length > 0;
  return {
    Advanced: advanced,
    PrimarySha: primary?.AfterSha ?? null,
    PrimaryRef: primary ? `refs/heads/${primary.Mirror}` : null,
    Notify: notify,
    Branches: branches,
    DispatchMirrorMerge: advanced && notify.Enabled
  };
}

export function writeGitHubOutput(path: string, result: MirrorSyncResult): void {
  const lines = [`advanced=${result.Advanced ? 'true' : 'false'}`];
  if (result.Advanced && result.PrimarySha && result.PrimaryRef) {
    lines.push(`sha=${result.PrimarySha}`);
    lines.push(`ref=${result.PrimaryRef}`);
  }
  lines.push(`notify=${result.Notify.Enabled ? 'true' : 'false'}`);
  lines.push(`dispatch_mirror_merge=${result.DispatchMirrorMerge ? 'true' : 'false'}`);
  if (result.Notify.Enabled) {
    lines.push(`notify_repository=${result.Notify.Repository ?? ''}`);
    lines.push(`notify_event_type=${result.Notify.EventType ?? ''}`);
  }
  appendFileSync(path, `${lines.join('\n')}\n`, 'utf8');
}

function readStringOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

function createMirrorSyncLogger(): Logger {
  return {
    write(message, level = 'Info') {
      const prefix =
        level === 'Warn' ? '[mirror-sync][warn]' : level === 'Error' ? '[mirror-sync][error]' : '[mirror-sync]';
      console.log(`${prefix} ${message}`);
    },
    close() {}
  };
}

export function runMirrorSyncCli(): void {
  process.env.LANG = 'C.UTF-8';
  process.env.LC_ALL = 'C.UTF-8';

  const args = process.argv.slice(2);
  const repoPath = resolve(readStringOption(args, '--repo-path') ?? process.cwd());
  const configPath = resolve(readStringOption(args, '--config') ?? `${repoPath}/.github/mirror-sync.json`);
  const logger = createMirrorSyncLogger();

  try {
    const result = runMirrorSync({
      RepoPath: repoPath,
      Config: loadMirrorSyncConfig(configPath),
      Logger: logger
    });
    if (process.env.GITHUB_OUTPUT) {
      writeGitHubOutput(process.env.GITHUB_OUTPUT, result);
    }
    logger.write(`done. advanced=${result.Advanced} dispatch_mirror_merge=${result.DispatchMirrorMerge}`);
  } catch (error) {
    logger.write(error instanceof Error ? error.message : String(error), 'Error');
    process.exitCode = 1;
  } finally {
    logger.close();
  }
}
