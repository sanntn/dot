import { spawnSync } from "node:child_process";
import { chownSync, existsSync, lstatSync, mkdirSync } from "node:fs";

// Agent isolation for a deployed Dot (the Docker image).
//
// Agents have an open shell, so anything the agent's OS user can read, a prompt-injected agent can
// read and send out. In the image the server runs as root and every agent process, and every git
// command that touches agent-writable files, runs as the unprivileged user DOT_AGENT_UID with no
// capabilities and no way to gain any. Dot's database, session secret, attachments and the tokens in
// the server's environment belong to root and are closed to that user.
//
// DOT_AGENT_UID turns this on (the Dockerfile sets it). DOT_AGENT_ISOLATION=off turns it off again.
// Locally nothing is set, agents run as you, and the deny rules are the only fence.

const uid = process.env.DOT_AGENT_UID?.trim() || "";
const gid = process.env.DOT_AGENT_GID?.trim() || uid;

export const isolated = uid !== "" && process.env.DOT_AGENT_ISOLATION?.trim() !== "off";

// The command and arguments that run `command` as the agent user.
export function asAgent(command: string, args: string[]): [string, string[]] {
  if (!isolated) return [command, args];
  return [
    "setpriv",
    [
      `--reuid=${uid}`,
      `--regid=${gid}`,
      "--init-groups",
      // No capabilities, and no setuid binary can give them back.
      "--bounding-set=-all",
      "--inh-caps=-all",
      "--no-new-privs",
      "--",
      command,
      ...args,
    ],
  ];
}

// Makes a path the agent user's own. A no-op outside the image.
export function handOver(path: string, recursive = false): void {
  if (!isolated) return;
  chownSync(path, Number(uid), Number(gid));
  if (recursive && lstatSync(path).isDirectory()) {
    const result = spawnSync("chown", ["-R", `${uid}:${gid}`, path], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`Could not hand ${path} to the agent user: ${result.stderr}`);
  }
}

// A folder the agents work in. Created by the server, then given to the agent user.
export function agentDir(path: string): void {
  mkdirSync(path, { recursive: true });
  handOver(path);
}

// Runs a few checks as the agent user and throws when it can reach something it must not. The server
// calls it at startup and refuses to start on a failure, so a broken image never runs agents quietly
// as the wrong user.
export function verifyIsolation(privatePaths: string[]): void {
  if (!isolated) return;
  const script = [
    'echo "uid=$(id -u)"',
    'echo "caps=$(grep CapEff /proc/self/status | cut -f2)"',
    'pid="$1"; shift',
    '[ -r "/proc/$pid/environ" ] && echo "readable /proc/$pid/environ"',
    'for f in "$@"; do [ -r "$f" ] && echo "readable $f"; done',
    "exit 0",
  ].join("\n");
  const existing = privatePaths.filter((p) => existsSync(p));
  const [command, args] = asAgent("sh", ["-c", script, "sh", String(process.pid), ...existing]);
  const result = spawnSync(command, args, { encoding: "utf8", env: { PATH: process.env.PATH ?? "" }, timeout: 15_000 });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const problems: string[] = [];
  if (result.status !== 0) problems.push(`the agent user could not be started (${result.error?.message ?? out.trim()})`);
  else {
    if (!out.includes(`uid=${uid}`)) problems.push(`agents did not run as uid ${uid}`);
    if (!out.includes("caps=0000000000000000")) problems.push("the agent user still has capabilities");
    for (const line of out.split("\n").filter((l) => l.startsWith("readable "))) problems.push(`the agent user can ${line}`);
  }
  if (problems.length > 0) {
    throw new Error(
      `Agent isolation check failed: ${problems.join("; ")}. ` +
        "Fix the container (it needs the SETUID, SETGID and SETPCAP capabilities and setpriv), or set DOT_AGENT_ISOLATION=off to run agents as the server's user.",
    );
  }
}
