import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { isSecretName, loadSecretFiles, secretsInEnvFile } from "../src/secrets.ts";

const dir = mkdtempSync(join(tmpdir(), "dot-secrets-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string, text: string) => {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};

test("a token file sets the setting, without its trailing newline", () => {
  const env: NodeJS.ProcessEnv = { DOT_GITHUB_TOKEN_FILE: file("gh", "ghp_abc\n"), DOT_CLAUDE_TOKEN_WORK_FILE: file("work", "sk-work\r\n") };
  const files = loadSecretFiles(env);
  assert.equal(env.DOT_GITHUB_TOKEN, "ghp_abc");
  assert.equal(env.DOT_CLAUDE_TOKEN_WORK, "sk-work");
  assert.equal(files.length, 2);
});

test("a value set directly wins, but the file is still reported so agents stay away from it", () => {
  const path = file("direct", "from-file");
  const env: NodeJS.ProcessEnv = { DOT_PASSWORD: "direct", DOT_PASSWORD_FILE: path };
  assert.deepEqual(loadSecretFiles(env), [path]);
  assert.equal(env.DOT_PASSWORD, "direct");
});

test("only secret settings can come from a file", () => {
  const env: NodeJS.ProcessEnv = { DOT_PORT_FILE: file("port", "1234"), DOT_MODEL_FILE: file("model", "x") };
  assert.deepEqual(loadSecretFiles(env), []);
  assert.equal(env.DOT_PORT, undefined);
  assert.ok(isSecretName("DOT_SESSION_SECRET"));
  assert.ok(!isSecretName("DOT_PORT"));
});

test("a missing or empty file stops the start with a clear message", () => {
  assert.throws(() => loadSecretFiles({ DOT_GITHUB_TOKEN_FILE: join(dir, "nope") }), /DOT_GITHUB_TOKEN_FILE points to .*nope.*can't be read/);
  assert.throws(() => loadSecretFiles({ DOT_GITHUB_TOKEN_FILE: file("empty", "\n") }), /is empty/);
});

test("finds the secrets written in a .env file and ignores the rest", () => {
  const text = [
    "# comment",
    "DOT_PORT=4317",
    "DOT_GITHUB_TOKEN=ghp_x",
    'export DOT_BITBUCKET_TOKEN="abc"',
    "DOT_PASSWORD=",
    'DOT_SESSION_SECRET=""',
    "DOT_CLAUDE_TOKEN_WORK = sk-1",
  ].join("\n");
  assert.deepEqual(secretsInEnvFile(text).sort(), ["DOT_BITBUCKET_TOKEN", "DOT_CLAUDE_TOKEN_WORK", "DOT_GITHUB_TOKEN"]);
});
