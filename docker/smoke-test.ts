// Smoke test for agent isolation, run inside a running Dot container:
//
//   docker cp docker/smoke-test.ts <container>:/app/server/smoke-test.ts
//   docker exec -w /app/server <container> ../node_modules/.bin/tsx smoke-test.ts
//
// A local bare repository stands in for GitHub. It clones, fetches and pushes through the transport
// repository while an "agent" has planted config in the clone that would run a command if the server's
// git read it. Exits nonzero on any failure. Uses /tmp and /data/dot/repos/smoke, nothing else.
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { cloneRepo, configureTransport, fetchBase, git, pushBranch } from "./src/git.ts";
import { agentDir, isolated } from "./src/isolation.ts";

const sh = (cmd: string, args: string[], cwd?: string) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", env: { PATH: process.env.PATH!, HOME: "/root" } }).trim();
const id = ["-c", "user.name=seed", "-c", "user.email=seed@x"];
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

process.umask(0o077);
check("isolation is on", isolated);
agentDir("/data/dot/repos");
configureTransport("/data/dot/transport");

const origin = "/tmp/origin.git";
rmSync(origin, { recursive: true, force: true });
rmSync("/tmp/seed", { recursive: true, force: true });
for (const m of ["credential", "ssh", "pager", "hook", "alt"]) rmSync(`/tmp/PWNED-${m}`, { force: true });
sh("git", ["init", "-q", "--bare", "-b", "main", origin]);
sh("git", ["init", "-q", "-b", "main", "/tmp/seed"]);
sh("git", [...id, "commit", "-q", "--allow-empty", "-m", "seed"], "/tmp/seed");
sh("git", ["push", "-q", origin, "main"], "/tmp/seed");

const repo = "/data/dot/repos/smoke";
rmSync(repo, { recursive: true, force: true });
const branch = await cloneRepo(origin, repo);
check("clone returns default branch", branch === "main", branch);
check("clone is owned by the agent user", sh("stat", ["-c", "%u", repo]) === "1000");

// What an agent could plant in the repository's own config.
await git(repo, ["config", "credential.helper", "!touch /tmp/PWNED-credential"]);
await git(repo, ["config", "core.sshCommand", "touch /tmp/PWNED-ssh"]);
await git(repo, ["config", "core.pager", "touch /tmp/PWNED-pager"]);
await git(repo, ["config", "remote.origin.url", "https://evil.example/x.git"]);
await git(repo, ["config", "uploadpack.packObjectsHook", "touch /tmp/PWNED-hook"]);
await git(repo, ["config", "core.alternateRefsCommand", "touch /tmp/PWNED-alt"]);

const fetched = await fetchBase(repo, "main", origin);
check("fetchBase works through the transport repo", fetched.note === null && fetched.ref === "refs/dot/origin/main", fetched.note ?? fetched.ref);
check("agent repo got origin's base commit", (await git(repo, ["rev-parse", "refs/dot/origin/main"])).trim() === sh("git", ["rev-parse", "main"], origin));

await git(repo, ["checkout", "-q", "-b", "dot/1-x"]);
for (const message of ["agent work", "more work"]) {
  await git(repo, ["-c", "user.name=a", "-c", "user.email=a@x", "commit", "-q", "--allow-empty", "-m", message]);
}
const local = (await git(repo, ["rev-parse", "refs/heads/dot/1-x"])).trim();

const pushed = await pushBranch(repo, "dot/1-x", { origin, base: "main" });
check("pushBranch returns the pushed commit", pushed === local, pushed);
check("origin has the branch at that commit", sh("git", ["rev-parse", "refs/heads/dot/1-x"], origin) === local);
check("origin's history is intact", sh("git", ["rev-list", "--count", "refs/heads/dot/1-x"], origin) === "3");
check("bundle was removed", sh("ls", ["/data/dot/transport/bundles"]) === "");
for (const marker of ["credential", "ssh", "pager", "hook", "alt"]) {
  check(`planted ${marker} config did not run`, !existsSync(`/tmp/PWNED-${marker}`));
}
check(
  "pushing a branch that does not exist fails",
  await pushBranch(repo, "dot/missing", { origin, base: "main" }).then(() => false, () => true),
);
check(
  "push without a settings-derived origin is refused",
  await pushBranch(repo, "dot/1-x", { origin: null, base: "main" }).then(() => false, (e) => /host, owner and name/.test(String(e))),
);

process.exit(failed === 0 ? 0 : 1);
