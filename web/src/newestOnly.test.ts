import assert from "node:assert/strict";
import { test } from "node:test";
import { newestOnly } from "./newestOnly.ts";

// Runs a request the way useLive does and records what reached the screen.
function fixture() {
  const guard = newestOnly();
  const shown: string[] = [];
  const request = (answer: Promise<string>) => {
    const current = guard.next();
    return answer.then((value) => {
      if (current()) shown.push(value);
    });
  };
  return { guard, shown, request };
}

test("a slow older answer does not overwrite a newer one", async () => {
  const { shown, request } = fixture();
  let slow!: (v: string) => void;
  const first = request(new Promise((resolve) => (slow = resolve)));
  const second = request(Promise.resolve("new"));
  await second;
  slow("old");
  await first;
  assert.deepEqual(shown, ["new"]);
});

test("answers that arrive in order all show", async () => {
  const { shown, request } = fixture();
  await request(Promise.resolve("a"));
  await request(Promise.resolve("b"));
  assert.deepEqual(shown, ["a", "b"]);
});

test("invalidate drops an answer for a filter that has since changed", async () => {
  const { guard, shown, request } = fixture();
  let late!: (v: string) => void;
  const pending = request(new Promise((resolve) => (late = resolve)));
  guard.invalidate();
  late("for the old filter");
  await pending;
  assert.deepEqual(shown, []);
});
