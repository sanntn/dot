// Deny rules added to every agent, on top of each stage's own. They keep an agent away from Dot
// itself: its HTTP API, its settings file and its data.
//
// The Bash rules are text matches on the command line, so a script or an interpreter gets past them. They stop
// the direct route, which is what a prompt injection tries first. The Read rules cover the file tools, which
// the researcher and reviewer use in the project's own repository (the executor's tools are already confined
// to its worktree). What holds is the OS user split in isolation.ts, in the Docker image, or the OS sandbox
// from `sandboxSettings` where the platform has one. Otherwise the agent runs as you, and these rules are all there is.

// A path as the shell may spell it: native, forward slashes, and Git Bash style (/d/x) on Windows.
function spellings(path: string): string[] {
  const forward = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const all = new Set([path.replace(/[\\/]+$/, ""), forward, forward.replace(/\//g, "\\")]);
  const drive = /^([A-Za-z]):\//.exec(forward);
  if (drive) all.add(`/${drive[1]!.toLowerCase()}/${forward.slice(3)}`);
  return [...all];
}

// A path as Read rules want it. `//x` is an absolute path on POSIX systems. On Windows the CLI accepts the
// Git Bash form (`//d/x`) and the drive form (`D:/x`). Both are tried against the real CLI.
function readSpellings(path: string): string[] {
  const forward = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const drive = /^([A-Za-z]):\//.exec(forward);
  if (drive) return [`//${drive[1]!.toLowerCase()}/${forward.slice(3)}`, forward];
  return forward.startsWith("/") ? [`/${forward}`] : [forward];
}

export type GuardOptions = {
  port: number;
  root: string;
  dataDir: string;
  dbFile: string;
  // Files that hold secrets, read at startup from DOT_<NAME>_FILE (see secrets.ts).
  secretFiles?: string[];
};

// What an agent must not read or change: Dot's settings, database, session secret, attachments, its transport
// repositories, its backups and any secret files. Not the whole data folder, since the agents' worktrees live inside it.
export function privatePaths(options: GuardOptions): string[] {
  const { root, dataDir, dbFile } = options;
  return [
    `${root}/.env`,
    dbFile,
    `${dbFile}-wal`,
    `${dbFile}-shm`,
    `${dataDir}/session.json`,
    `${dataDir}/attachments`,
    `${dataDir}/transport`,
    `${dataDir}/backups`,
    ...(options.secretFiles ?? []),
  ];
}

export function guardRules(options: GuardOptions): string[] {
  const { port } = options;
  const rules = new Set<string>();

  // Dot's own API. A command that names its port is a call to it.
  for (const host of ["127.0.0.1", "localhost", "[::1]", "0.0.0.0", "::1"]) rules.add(`Bash(*${host}:${port}*)`);
  rules.add(`Bash(*://*:${port}/api*)`);

  // Where a running process keeps its environment and arguments, and what the shell can dump of it.
  for (const file of ["environ", "cmdline", "mem", "maps", "fd"]) rules.add(`Bash(*/proc/*/${file}*)`);
  rules.add("Bash(*/proc/self/environ*)");
  rules.add("Bash(printenv*)");
  rules.add("Bash(env)");
  rules.add("Bash(set)");
  rules.add("Bash(export)");
  rules.add("Bash(export -p)");

  for (const path of privatePaths(options)) {
    for (const spelling of spellings(path)) rules.add(`Bash(*${spelling}*)`);
    // A Read deny also stops Edit and Write on the path. A folder needs /** to cover what is inside it.
    for (const spelling of readSpellings(path)) {
      rules.add(`Read(${spelling})`);
      rules.add(`Read(${spelling}/**)`);
    }
  }
  return [...rules];
}

// Settings for Claude Code's own sandbox. It enforces the private paths on every command an agent runs, scripts
// included, which the text rules above cannot. It exists on macOS, Linux and WSL2, not on native Windows. With
// failIfUnavailable on, an agent that can't be sandboxed does not start, instead of running without it.
// Only the private paths are denied. The network and the rest of the disk stay open, so installs and tests still work.
export function sandboxSettings(options: GuardOptions): { enabled: true; failIfUnavailable: true; allowUnsandboxedCommands: false; filesystem: { denyRead: string[] } } {
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    filesystem: { denyRead: privatePaths(options).map((p) => p.replace(/\\/g, "/")) },
  };
}
