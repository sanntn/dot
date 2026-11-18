import assert from "node:assert/strict";
import { test } from "node:test";
import { branchSlug, refChanges, type RefSnapshot } from "../src/git.ts";

test("branchSlug lowercases, dashes and caps the title", () => {
  assert.equal(branchSlug(7, "Fix the Login   bug!"), "dot/7-fix-the-login-bug");
  assert.equal(branchSlug(7, "***"), "dot/7");
  const long = branchSlug(1, "a".repeat(100));
  assert.ok(long.length <= "dot/1-".length + 40);
});

const snap = (entries: Record<string, string>): RefSnapshot => new Map(Object.entries(entries));

test("refChanges ignores the task's own branch and Dot's namespace", () => {
  const before = snap({ "refs/heads/main": "a", "refs/heads/dot/1-x": "b", "refs/dot/origin/main": "c" });
  const after = snap({ "refs/heads/main": "a", "refs/heads/dot/1-x": "z", "refs/dot/origin/main": "d" });
  assert.deepEqual(refChanges(before, after, ["dot/1-x"]), []);
});

test("refChanges flags a moved, created and deleted ref outside the task", () => {
  const before = snap({ "refs/heads/main": "a", "refs/heads/old": "b" });
  const after = snap({ "refs/heads/main": "z", "refs/heads/new": "c" });
  assert.deepEqual(refChanges(before, after, []).sort(), ["created refs/heads/new", "deleted refs/heads/old", "moved refs/heads/main"]);
});

test("refChanges flags a checkout in the main checkout", () => {
  const before = snap({ "HEAD (main checkout)": "refs/heads/main" });
  const after = snap({ "HEAD (main checkout)": "refs/heads/other" });
  assert.deepEqual(refChanges(before, after, []), ["moved HEAD (main checkout)"]);
});

test("refChanges treats remote-tracking refs of expected branches as expected", () => {
  const after = snap({ "refs/remotes/origin/dot/1-x": "z" });
  assert.deepEqual(refChanges(new Map(), after, ["dot/1-x"]), []);
  assert.deepEqual(refChanges(new Map(), after, []), ["created refs/remotes/origin/dot/1-x"]);
});
