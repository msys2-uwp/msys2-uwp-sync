import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';

import { MIRROR_MERGE_CONFIG_PATH, MIRROR_SYNC_TOOLINGS_DIR } from '../types/constants.ts';
import type { Logger } from '../git/log.ts';

export interface ToolingBundleSpec {
  BlockLabel: string;
  PackageScript: string;
  CliRelPath: string;
  SourcePaths: readonly string[];
}

export const MIRROR_SYNC_TOOLINGS_SPEC: ToolingBundleSpec = {
  BlockLabel: 'Block 3',
  PackageScript: 'mirror-sync',
  CliRelPath: 'src/mirror-sync/cli.ts',
  SourcePaths: [
    'src/mirror-sync',
    'src/git',
    'src/types',
  ]
};

export const MIRROR_MERGE_TOOLINGS_SPEC: ToolingBundleSpec = {
  BlockLabel: 'Block 4',
  PackageScript: 'mirror-merge',
  CliRelPath: 'src/mirror-merge/cli.ts',
  SourcePaths: [
    'src/mirror-merge',
    'src/git',
    'src/types',
    MIRROR_MERGE_CONFIG_PATH
  ]
};

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

function toolingsPath(repoPath: string): string {
  return join(repoPath, MIRROR_SYNC_TOOLINGS_DIR);
}

function toolingsPackageJson(spec: ToolingBundleSpec): string {
  return `{
  "name": "msys2-apiss-sync-toolings",
  "private": true,
  "type": "module",
  "packageManager": "yarn@4.17.0",
  "engines": {
    "node": ">=26.0.0"
  },
  "scripts": {
    "${spec.PackageScript}": "node ${spec.CliRelPath}"
  }
}
`;
}

function copyToolingSourcePath(repoRoot: string, root: string, rel: string): void {
  const source = join(repoRoot, rel);
  const dest = join(root, rel);
  mkdirSync(dirname(dest), { recursive: true });
  if (statSync(source).isDirectory()) {
    cpSync(source, dest, { recursive: true });
    return;
  }
  writeFileSync(dest, readFileSync(source, 'utf8'), 'utf8');
}

export function toolingsMatch(repoPath: string, repoRoot: string, spec: ToolingBundleSpec): boolean {
  const root = toolingsPath(repoPath);
  const packagePath = join(root, 'package.json');
  const cliPath = join(root, spec.CliRelPath);
  if (!existsSync(packagePath) || !existsSync(cliPath)) {
    return false;
  }
  if (normalizeText(readFileSync(packagePath, 'utf8')) !== normalizeText(toolingsPackageJson(spec))) {
    return false;
  }
  for (const rel of spec.SourcePaths) {
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

export function applyToolings(
  repoPath: string,
  repoRoot: string,
  spec: ToolingBundleSpec,
  logger: Logger
): void {
  for (const rel of spec.SourcePaths) {
    const source = join(repoRoot, rel);
    if (!existsSync(source)) {
      throw new Error(`Missing ${spec.BlockLabel} toolings source: ${source}`);
    }
  }

  const root = toolingsPath(repoPath);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), toolingsPackageJson(spec), 'utf8');
  for (const rel of spec.SourcePaths) {
    copyToolingSourcePath(repoRoot, root, rel);
  }

  logger.write(`Applied ${MIRROR_SYNC_TOOLINGS_DIR} ${spec.BlockLabel} bundle to ${repoPath}`);
}

export function getToolingsCliPath(repoPath: string, spec: ToolingBundleSpec): string {
  return join(toolingsPath(repoPath), spec.CliRelPath);
}
