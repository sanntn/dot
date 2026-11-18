// Deny rules added to every agent, on top of each stage's own. They keep an agent away from Dot
// itself: its HTTP API, its settings file and its data.
//
// These are text matches on the command line, so a script or an interpreter gets past them. They stop
// the direct route, which is what a prompt injection tries first. What holds is the OS user split
// in isolation.ts, in the Docker image. Locally the agent runs as you, and these rules are all there is.

// A path as the shell may spell it: native, forward slashes, and Git Bash style (/d/x) on Windows.
function spellings(path: string): string[] {
  const forward = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const all = new Set([path.replace(/[\\/]+$/, ""), forward, forward.replace(/\//g, "\\")]);
  const drive = /^([A-Za-z]):\//.exec(forward);
  if (drive) all.add(`/${drive[1]!.toLowerCase()}/${forward.slice(3)}`);
  return [...all];
}

export function guardRules(options: { port: number; root: string; dataDir: string; dbFile: string }): string[] {
  const { port, root, dataDir, dbFile } = options;
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

  // Dot's settings file, its database and session secret, its attachments and its transport repositories.
  // Not the whole data folder: the agents' worktrees live inside it.
  const privatePaths = [`${root}/.env`, dbFile, `${dataDir}/session.json`, `${dataDir}/attachments`, `${dataDir}/transport`, `${dataDir}/backups`];
  for (const path of privatePaths.flatMap(spellings)) {
    rules.add(`Bash(*${path}*)`);
  }
  return [...rules];
}
