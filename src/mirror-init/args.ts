export function readFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

export function wantsHelp(args: string[]): boolean {
  return args.includes('--help') || args.includes('-h');
}

export function printMirrorInitCliHelp(): void {
  console.log(`Usage: yarn mirror-init [options]

Options:
  --push                    Push mirror branches, dispatch mirror-sync per mirror, then mirror-poll
  --repo <name>             Single mirror from config/mirror-poll.json Repos
  --skip-fetch              Skip git fetch origin during ensure-init
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
