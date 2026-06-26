import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { MIRROR_SYNC_TOOLINGS_DIR } from '../types/constants.ts';
import type { Logger } from '../git/log.ts';

const TOOLINGS_PACKAGE_JSON = `{
  "name": "msys2-apiss-sync-toolings",
  "private": true,
  "type": "module",
  "packageManager": "yarn@4.17.0",
  "engines": {
    "node": ">=26.0.0"
  },
  "scripts": {
    "mirror-sync": "node src/mirror-sync/cli.ts"
  }
}
`;

const TOOLINGS_SOURCE_FILES = [
  'src/mirror-sync',
  'src/git',
  'src/types/constants.ts',
  'src/types/mirror-sync-config.ts'
] as const;

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function textFilesEqual(pathA: string, pathB: string): boolean {
  return normalizeText(readFileSync(pathA, 'utf8')) === normalizeText(readFileSync(pathB, 'utf8'));
}

function toolingsTreeEqual(source: string, installed: string): boolean {
  if (!existsSync(source) || !existsSync(installed)) {
    return false;
  }
  const sourceStat = statSync(source);
  const installedStat = statSync(installed);
  if (sourceStat.isFile() && installedStat.isFile()) {
    return textFilesEqual(source, installed);
  }
  if (!sourceStat.isDirectory() || !installedStat.isDirectory()) {
    return false;
  }
  const names = readdirSync(source).sort();
  if (names.length !== readdirSync(installed).length) {
    return false;
  }
  for (const name of names) {
    if (!toolingsTreeEqual(join(source, name), join(installed, name))) {
      return false;
    }
  }
  return true;
}

function toolingsPath(mirrorPath: string): string {
  return join(mirrorPath, MIRROR_SYNC_TOOLINGS_DIR);
}

function toolingsSourcePaths(repoRoot: string): string[] {
  return TOOLINGS_SOURCE_FILES.map((rel) => join(repoRoot, rel));
}

export function mirrorSyncToolingsMatch(mirrorPath: string, repoRoot: string): boolean {
  const root = toolingsPath(mirrorPath);
  const packagePath = join(root, 'package.json');
  const cliPath = join(root, 'src', 'mirror-sync', 'cli.ts');
  if (!existsSync(packagePath) || !existsSync(cliPath)) {
    return false;
  }
  if (normalizeText(readFileSync(packagePath, 'utf8')) !== normalizeText(TOOLINGS_PACKAGE_JSON)) {
    return false;
  }
  for (const rel of TOOLINGS_SOURCE_FILES) {
    const source = join(repoRoot, rel);
    const installed = join(root, rel);
    if (!existsSync(source) || !existsSync(installed)) {
      return false;
    }
    if (!toolingsTreeEqual(source, installed)) {
      return false;
    }
  }
  return true;
}

export function applyMirrorSyncToolings(mirrorPath: string, repoRoot: string, logger: Logger): void {
  for (const source of toolingsSourcePaths(repoRoot)) {
    if (!existsSync(source)) {
      throw new Error(`Missing Block 3 toolings source: ${source}`);
    }
  }

  const root = toolingsPath(mirrorPath);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'src', 'types'), { recursive: true });
  writeFileSync(join(root, 'package.json'), TOOLINGS_PACKAGE_JSON, 'utf8');

  cpSync(join(repoRoot, 'src', 'mirror-sync'), join(root, 'src', 'mirror-sync'), { recursive: true });
  cpSync(join(repoRoot, 'src', 'git'), join(root, 'src', 'git'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'types', 'constants.ts'),
    readFileSync(join(repoRoot, 'src', 'types', 'constants.ts'), 'utf8'),
    'utf8'
  );
  writeFileSync(
    join(root, 'src', 'types', 'mirror-sync-config.ts'),
    readFileSync(join(repoRoot, 'src', 'types', 'mirror-sync-config.ts'), 'utf8'),
    'utf8'
  );

  logger.write(`Applied ${MIRROR_SYNC_TOOLINGS_DIR} Block 3 bundle to ${mirrorPath}`);
}

export function getMirrorSyncToolingsCliPath(mirrorPath: string): string {
  return join(mirrorPath, MIRROR_SYNC_TOOLINGS_DIR, 'src', 'mirror-sync', 'cli.ts');
}
