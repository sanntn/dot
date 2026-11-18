import assert from "node:assert/strict";
import { test } from "node:test";
import { commentsToNotes, parseHunks, type LineComment } from "./diffComments.ts";

const patch = [
  "diff --git a/a.ts b/a.ts",
  "index 111..222 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -10,3 +10,4 @@ function f() {",
  " keep",
  "-old",
  "+new",
  "+extra",
  " end",
  "\\ No newline at end of file",
  "@@ -40,1 +41,1 @@",
  "-x",
  "+y",
  "",
].join("\n");

test("numbers each hunk line on the side it belongs to", () => {
  const lines = parseHunks(patch).map((l) => [l.kind, l.oldNo, l.newNo]);
  assert.deepEqual(lines, [
    ["hunk", null, null],
    ["context", 10, 10],
    ["del", 11, null],
    ["add", null, 11],
    ["add", null, 12],
    ["context", 12, 13],
    ["meta", null, null],
    ["hunk", null, null],
    ["del", 40, null],
    ["add", null, 41],
  ]);
});

test("a patch without hunks has no lines", () => {
  assert.deepEqual(parseHunks("diff --git a/b b/b\nBinary files differ\n"), []);
});

test("comments become notes that name the file and line", () => {
  const comments: LineComment[] = [
    { id: 1, path: "a.ts", kind: "add", oldNo: null, newNo: 12, code: "  const x = `a`;", text: "Rename x.\nIt hides the import." },
    { id: 2, path: "a.ts", kind: "del", oldNo: 11, newNo: null, code: "old", text: "Keep this." },
  ];
  assert.equal(
    commentsToNotes(comments),
    [
      "Comments on the diff:",
      "",
      "- a.ts:12",
      "  Code: `const x = 'a';`",
      "  Rename x.",
      "  It hides the import.",
      "- a.ts, removed line 11",
      "  Code: `old`",
      "  Keep this.",
    ].join("\n"),
  );
});

test("a comment is outdated when its line changed or its file left the diff", async () => {
  const { outdatedComments } = await import("./diffComments.ts");
  const files = [{ path: "a.ts", patch }];
  const same: LineComment = { id: 1, path: "a.ts", kind: "add", oldNo: null, newNo: 11, code: "new", text: "ok" };
  const edited: LineComment = { ...same, id: 2, code: "something else" };
  const moved: LineComment = { ...same, id: 3, newNo: 30 };
  const gone: LineComment = { ...same, id: 4, path: "b.ts" };
  assert.deepEqual(outdatedComments([same, edited, moved, gone], files).map((c) => c.id), [2, 3, 4]);
});
