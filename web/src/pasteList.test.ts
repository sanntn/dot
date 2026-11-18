import assert from "node:assert/strict";
import { test } from "node:test";
import { parseList } from "./pasteList.ts";

test("drops bullets, numbers and checkboxes", () => {
  const { titles } = parseList("- one\n* two\n3. three\n4) four\n- [x] five\n- [ ] six");
  assert.deepEqual(titles, ["one", "two", "three", "four", "five", "six"]);
});

test("skips blank lines and handles CRLF", () => {
  assert.deepEqual(parseList("a\r\n\r\n  \r\nb").titles, ["a", "b"]);
});
