import { join } from 'node:path';

import type { SourceKey } from '../types/replay-entry.ts';
import { getSyncRepoRoot, loadSyncConfig } from '../lib/config.ts';
import { getMirrorTipSha, getSourceReplayHistory } from '../lib/history.ts';
import { createSyncLogger, getWorkDirectory, setSyncUtf8Environment, writeJsonFile } from '../lib/log.ts';
import { initializeMirrorRepository } from '../lib/repos.ts';
import { readFlag, readIntOption, readStringOption } from './args.ts';

async function main(): Promise<void> {
  setSyncUtf8Environment();
  const args = process.argv.slice(2);
  const repoRoot = getSyncRepoRoot();
  const config = loadSyncConfig(repoRoot);
  const logger = createSyncLogger(repoRoot);

  try {
    const work = getWorkDirectory(repoRoot);
    const outDir = join(work, 'cache', 'replay-log');
    const sourceOption = readStringOption(args, '--source-key') ?? 'Both';
    if (!['Ports', 'PortsMingw', 'Both'].includes(sourceOption)) {
      throw new Error(`Invalid --source-key: ${sourceOption}`);
    }
    const sourceKeys: SourceKey[] = sourceOption === 'Both' ? ['Ports', 'PortsMingw'] : [sourceOption as SourceKey];
    const afterSha = readStringOption(args, '--after-sha') ?? null;
    const skipFetch = readFlag(args, '--skip-fetch');
    const saveFullJson = readFlag(args, '--save-full-json');
    const sampleCount = readIntOption(args, '--sample-count', 3);

    logger.write(`Retrieving history (sources=${sourceOption} after=${afterSha ? afterSha.slice(0, 8) : 'full'})`);

    for (const key of sourceKeys) {
      const mirrorPath = initializeMirrorRepository({
        WorkDirectory: work,
        SourceKey: key,
        Config: config,
        SkipFetch: skipFetch,
        Logger: logger
      });
      const branch = config.Sources[key].Branch;
      const tip = getMirrorTipSha(mirrorPath, branch);
      const history = getSourceReplayHistory(key, config, mirrorPath, afterSha, tip);
      const sortKey = config.Sources[key].SortKey;
      const outFile = join(outDir, `history-${sortKey}.json`);
      const fullFile = saveFullJson ? join(outDir, `history-${sortKey}-full.json`) : null;

      if (saveFullJson) {
        writeJsonFile(fullFile!, history.map(({ Sha, SourceId, CommitterDateUnix, AuthorDateUnix, AuthorName, AuthorEmail, CommitterName, CommitterEmail, Subject, Body }) => ({
          Sha,
          SourceId,
          CommitterDateUnix,
          AuthorDateUnix,
          AuthorName,
          AuthorEmail,
          CommitterName,
          CommitterEmail,
          Subject,
          Body
        })));
      }

      writeJsonFile(outFile, {
        SourceKey: key,
        SortKey: sortKey,
        MirrorPath: mirrorPath,
        AfterSha: afterSha,
        UntilSha: tip,
        Count: history.length,
        OldestSha: history.length > 0 ? history[0]!.Sha : null,
        NewestSha: history.length > 0 ? history[history.length - 1]!.Sha : null,
        FullHistoryFile: fullFile,
        Sample: history.slice(0, sampleCount).map((entry) => ({
          Sha: entry.Sha,
          CommitterDateUnix: entry.CommitterDateUnix,
          Subject: entry.Subject
        }))
      });

      logger.write(`${sortKey}: ${history.length} commit(s) (${tip.slice(0, 8)} tip) -> ${outFile}`);
      if (fullFile) {
        logger.write(`  full history -> ${fullFile}`);
      }
      if (history.length > 0) {
        logger.write(`  oldest: ${history[0]!.Sha.slice(0, 8)} ${history[0]!.Subject}`);
        logger.write(`  newest: ${history[history.length - 1]!.Sha.slice(0, 8)} ${history[history.length - 1]!.Subject}`);
      }
    }

    logger.write('Done.');
  } catch (error) {
    logger.write(error instanceof Error ? error.message : String(error), 'Error');
    process.exitCode = 1;
  } finally {
    logger.close();
  }
}

void main();
