// A scripted stand-in for the claude CLI, for the pipeline tests. Dot launches it through DOT_CLAUDE_BIN
// with the same arguments it gives the real CLI, and talks to it in stream-json.
//
// scenario.json sits beside this file. Each launch takes the first entry of "launches", whose "turns" list
// says what to do for each user message the launch receives. A turn is a list of steps:
//   { say: "text" }                                  an assistant message
//   { tool: "submit_plan", args: { ... } }           a call to Dot's MCP endpoint
//   { commit: { file, content, message } }           a commit in the working directory
// What each launch saw goes to calls.jsonl, so tests can check the prompts and the working directory.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scenarioFile = join(here, "scenario.json");
const callsFile = join(here, "calls.jsonl");

const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const mcpUrl = JSON.parse(flag("--mcp-config")).mcpServers.dot.url;
const sessionId = flag("--session-id") ?? flag("--resume");

const scenario = JSON.parse(readFileSync(scenarioFile, "utf8"));
const launch = scenario.launches.shift() ?? { turns: [] };
writeFileSync(scenarioFile, JSON.stringify(scenario));

const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const log = (entry) => appendFileSync(callsFile, `${JSON.stringify(entry)}\n`);

async function callTool(name, toolArgs) {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: toolArgs } }),
  });
  const body = await res.json();
  return body.result ?? body.error;
}

out({ type: "system", subtype: "init", session_id: sessionId });

let turn = 0;
const lines = createInterface({ input: process.stdin });
let chain = Promise.resolve();
lines.on("line", (line) => {
  chain = chain.then(async () => {
    const message = JSON.parse(line);
    const text = message.message.content.map((b) => b.text ?? "").join("\n");
    const steps = launch.turns[turn] ?? [];
    log({ launch: launch.name ?? null, turn, cwd: process.cwd(), prompt: text, resume: args.includes("--resume") });
    turn += 1;

    for (const step of steps) {
      if (step.say) {
        out({ type: "assistant", message: { content: [{ type: "text", text: step.say }] } });
      } else if (step.commit) {
        const { file, content, message: subject } = step.commit;
        writeFileSync(join(process.cwd(), file), content);
        const git = (...a) => execFileSync("git", ["-c", "user.name=Fake", "-c", "user.email=fake@example.com", ...a], { cwd: process.cwd() });
        git("add", "-A");
        git("commit", "-q", "-m", subject);
      } else if (step.tool) {
        const result = await callTool(step.tool, step.args ?? {});
        log({ tool: step.tool, isError: Boolean(result?.isError), reply: result?.content?.[0]?.text ?? result?.message ?? null });
      }
    }
    out({ type: "result", subtype: "success", is_error: false, total_cost_usd: launch.cost ?? 0.01, result: "" });
  });
});
