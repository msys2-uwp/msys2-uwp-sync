import { mkdirSync, openSync, writeFileSync, writeSync, closeSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

export interface SyncLogger {
  write(message: string, level?: 'Info' | 'Warn' | 'Error'): void;
  close(): void;
}

export function convertToUnixLineEndings(text: string | null | undefined): string {
  return (text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function splitCommitMessage(message: string | null | undefined): { Subject: string; Body: string } {
  const normalized = convertToUnixLineEndings(message).replace(/\n+$/g, '');
  if (!normalized) {
    return { Subject: '', Body: '' };
  }

  const lines = normalized.split('\n');
  const subject = lines[0] ?? '';
  if (lines.length === 1) {
    return { Subject: subject, Body: '' };
  }

  const bodyStart = lines[1] === '' ? 2 : 1;
  const body = bodyStart < lines.length ? lines.slice(bodyStart).join('\n').replace(/\s+$/g, '') : '';
  return { Subject: subject, Body: body };
}

export function getWorkDirectory(repoRoot: string): string {
  const work = join(repoRoot, '.work');
  mkdirSync(work, { recursive: true });
  return work;
}

export function setSyncUtf8Environment(): void {
  process.env.LANG = 'C.UTF-8';
  process.env.LC_ALL = 'C.UTF-8';
}

export function createSyncLogger(repoRoot: string, options: {
  logFile?: string;
  append?: boolean;
  logToConsole?: boolean;
} = {}): SyncLogger {
  const quietConsole = Boolean(options.logFile) && !options.logToConsole;
  let fd: number | undefined;

  if (options.logFile) {
    const path = isAbsolute(options.logFile) ? options.logFile : join(repoRoot, options.logFile);
    mkdirSync(dirname(path), { recursive: true });
    fd = openSync(path, options.append ? 'a' : 'w');
  }

  return {
    write(message, level = 'Info') {
      const prefix = level === 'Warn' ? '[sync][warn]' : level === 'Error' ? '[sync][error]' : '[sync]';
      const line = `${prefix} ${message}`;
      if (!quietConsole || level !== 'Info') {
        console.log(line);
      }
      if (fd !== undefined) {
        writeSync(fd, `${line}\n`, undefined, 'utf8');
      }
    },
    close() {
      if (fd !== undefined) {
        closeSync(fd);
        fd = undefined;
      }
    }
  };
}

export function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
