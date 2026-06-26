export function readFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

export function wantsHelp(args: string[]): boolean {
  return args.includes('--help') || args.includes('-h');
}

export function printMirrorMergeCliHelp(): void {
  console.log(`Usage: yarn sync [options]

Options:
  --clean                   Reset destination sync branches before replay
  --dry-run                 Replay locally without pushing
  --skip-fetch              Skip mirror and destination fetch
  --max-commits <n>         Limit replay to n queue entries (0 = no limit)
  --destination-path <path> Destination clone path
  --log-file <path>         Write log to file
  --log-append              Append to log file
  --log-to-console          Also print log lines to stdout
  -h, --help                Show this help
`);
}

export function readStringOption(args: string[], name: string): string | undefined {
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

export function readIntOption(args: string[], name: string, fallback = 0): number {
  const value = readStringOption(args, name);
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer for ${name}: ${value}`);
  }
  return parsed;
}
