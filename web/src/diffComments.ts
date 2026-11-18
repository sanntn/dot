// Line comments on a task's diff. A comment points at one line of a file's patch. Together they
// become the notes of a change request to the executor.

export type DiffLine = {
  text: string;
  kind: "hunk" | "add" | "del" | "context" | "meta";
  oldNo: number | null;
  newNo: number | null;
};

// Reads the hunk lines of a patch and numbers each one on the old and new side.
export function parseHunks(patch: string): DiffLine[] {
  const all = patch.split("\n");
  if (all.at(-1) === "") all.pop();
  const start = all.findIndex((l) => l.startsWith("@@"));
  if (start === -1) return [];

  const lines: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const text of all.slice(start)) {
    if (text.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(text);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
      lines.push({ text, kind: "hunk", oldNo: null, newNo: null });
    } else if (text.startsWith("+")) {
      lines.push({ text, kind: "add", oldNo: null, newNo: newNo++ });
    } else if (text.startsWith("-")) {
      lines.push({ text, kind: "del", oldNo: oldNo++, newNo: null });
    } else if (text.startsWith("\\")) {
      lines.push({ text, kind: "meta", oldNo: null, newNo: null });
    } else {
      lines.push({ text, kind: "context", oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return lines;
}

export type LineComment = {
  id: number;
  path: string;
  kind: "add" | "del" | "context";
  oldNo: number | null;
  newNo: number | null;
  // The line's text without its +, - or space marker.
  code: string;
  text: string;
};

// A comment sits on a line by its numbers, so the same line keeps its comments when the panel reloads.
export function lineKey(path: string, line: Pick<DiffLine, "oldNo" | "newNo">): string {
  return `${path}\u0000${line.oldNo ?? ""}\u0000${line.newNo ?? ""}`;
}

export function commentKey(c: LineComment): string {
  return lineKey(c.path, c);
}

export function commentLocation(c: LineComment): string {
  return c.kind === "del" ? `${c.path}, removed line ${c.oldNo}` : `${c.path}:${c.newNo}`;
}

// The notes for requestChanges. Each comment names its file and line and quotes the code.
export function commentsToNotes(comments: LineComment[]): string {
  const blocks = comments.map((c) => {
    const quote = c.code.trim() ? `\n  Code: \`${c.code.trim().replace(/`/g, "'")}\`` : "";
    return `- ${commentLocation(c)}${quote}\n  ${c.text.trim().replace(/\n/g, "\n  ")}`;
  });
  return `Comments on the diff:\n\n${blocks.join("\n")}`;
}

function signature(path: string, line: { kind: string; oldNo: number | null; newNo: number | null }, code: string): string {
  return `${lineKey(path, line)}\u0000${line.kind}\u0000${code}`;
}

// Comments whose line is no longer in the diff as it was: the file left the diff, or the executor changed
// the line or moved it. They still quote their code, so they can be sent, but they are shown apart.
export function outdatedComments(comments: LineComment[], files: { path: string; patch: string }[]): LineComment[] {
  const present = new Set<string>();
  for (const file of files) {
    for (const line of parseHunks(file.patch)) {
      if (line.kind !== "hunk" && line.kind !== "meta") present.add(signature(file.path, line, line.text.slice(1)));
    }
  }
  return comments.filter((c) => !present.has(signature(c.path, c, c.code)));
}
