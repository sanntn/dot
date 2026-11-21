import type { Column, SearchHit } from "@dot/shared";
import type { Db } from "./db.ts";

// Marks around the matched words in a snippet. Control characters never appear in what people write.
export const MARK_START = "\u0001";
export const MARK_END = "\u0002";

// Turns what someone typed into an FTS5 query. Every word is quoted, so punctuation and words like OR
// or NEAR can't break the syntax, and the last word matches as a prefix so results appear while typing.
export function toMatchQuery(input: string): string | null {
  const words = input.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return null;
  return words.map((w, i) => `"${w}"${i === words.length - 1 ? "*" : ""}`).join(" ");
}

type Row = {
  task_id: number;
  kind: SearchHit["kind"];
  snippet: string;
  rank: number;
  project_id: number;
  number: number;
  title: string;
  column_key: Column;
  project_name: string;
};

// The best match per task, best first. A task whose title and chat both match shows once.
// `doneOnly` keeps the filter inside the query, so the row cap below counts only finished tasks.
export function searchTasks(db: Db, input: string, options: { projectId?: number; limit?: number; doneOnly?: boolean } = {}): SearchHit[] {
  const match = toMatchQuery(input);
  if (!match) return [];
  const limit = options.limit ?? 20;
  const rows = db
    .prepare(
      `SELECT s.task_id, s.kind, snippet(search, 2, ?, ?, '...', 14) AS snippet, bm25(search) AS rank,
              t.project_id, t.number, t.title, t.column_key, p.name AS project_name
       FROM search s
       JOIN tasks t ON t.id = s.task_id
       JOIN projects p ON p.id = t.project_id
       WHERE search MATCH ? ${options.projectId ? "AND t.project_id = ?" : ""} ${options.doneOnly ? "AND t.column_key = 'done'" : ""}
       ORDER BY rank
       LIMIT 200`,
    )
    .all(MARK_START, MARK_END, match, ...(options.projectId ? [options.projectId] : [])) as Row[];

  const seen = new Set<number>();
  const hits: SearchHit[] = [];
  for (const row of rows) {
    if (seen.has(row.task_id)) continue;
    seen.add(row.task_id);
    hits.push({
      taskId: row.task_id,
      projectId: row.project_id,
      projectName: row.project_name,
      number: row.number,
      title: row.title,
      column: row.column_key,
      kind: row.kind,
      snippet: row.snippet.replace(/\s+/g, " ").trim(),
    });
    if (hits.length >= limit) break;
  }
  return hits;
}
