export function readFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

export function wantsHelp(args: string[]): boolean {
  return args.includes('--help') || args.includes('-h');
}

export function printMirrorPollCliHelp(): void {
  console.log(`Usage: yarn mirror-poll [options]

Options:
  --repo <name>             Single mirror from config/mirror-poll.json Repos
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
