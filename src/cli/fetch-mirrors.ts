import { getSyncRepoRoot, loadSyncConfig } from '../lib/config.ts';
import { getMirrorTipSha } from '../lib/history.ts';
import { createSyncLogger, getWorkDirectory, setSyncUtf8Environment } from '../lib/log.ts';
import { initializeMirrorRepository } from '../lib/repos.ts';
import { readFlag } from './args.ts';

async function main(): Promise<void> {
  setSyncUtf8Environment();
  const args = process.argv.slice(2);
  const repoRoot = getSyncRepoRoot();
  const config = loadSyncConfig(repoRoot);
  const logger = createSyncLogger(repoRoot);

  try {
    const work = getWorkDirectory(repoRoot);
    const skipFetch = readFlag(args, '--skip-fetch');
    logger.write('Fetching mirrors');

    for (const sourceKey of ['Ports', 'PortsMingw'] as const) {
      const mirrorPath = initializeMirrorRepository({
        WorkDirectory: work,
        SourceKey: sourceKey,
        Config: config,
        SkipFetch: skipFetch,
        Logger: logger
      });
      const branch = config.Sources[sourceKey].Branch;
      const tip = getMirrorTipSha(mirrorPath, branch);
      logger.write(`${sourceKey} mirror: ${mirrorPath} (tip ${branch} = ${tip.slice(0, 8)})`);
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
