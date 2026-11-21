import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Each entry runs once, in order. PRAGMA user_version tracks how many have run.
// Never edit an entry that has shipped. Add a new one instead.
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    repo_path TEXT NOT NULL,
    base_branch TEXT NOT NULL DEFAULT 'main',
    bitbucket_workspace TEXT,
    bitbucket_repo TEXT,
    test_command TEXT,
    lint_command TEXT,
    typecheck_command TEXT,
    browser_testing INTEGER NOT NULL DEFAULT 0,
    dev_command TEXT,
    dev_url TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    column_key TEXT NOT NULL DEFAULT 'inbox',
    position REAL NOT NULL,
    needs_input INTEGER NOT NULL DEFAULT 0,
    branch TEXT,
    worktree_path TEXT,
    review_round INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX tasks_board ON tasks(project_id, column_key, position);
  `,
  `
  ALTER TABLE tasks ADD COLUMN agent_state TEXT NOT NULL DEFAULT 'idle';

  CREATE TABLE runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    stage TEXT NOT NULL,
    session_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'idle',
    cost_usd REAL NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX runs_task ON runs(task_id, stage);

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    run_id INTEGER REFERENCES runs(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    data TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX messages_task ON messages(task_id, id);

  CREATE TABLE artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
    type TEXT NOT NULL,
    version INTEGER NOT NULL,
    author TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX artifacts_task ON artifacts(task_id, type, version);

  CREATE TABLE attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    media_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  `
  -- Set once the CLI reports the session started, so Dot knows to resume it instead of creating it.
  ALTER TABLE runs ADD COLUMN session_started INTEGER NOT NULL DEFAULT 0;
  UPDATE runs SET session_started = 1
    WHERE EXISTS (SELECT 1 FROM messages m WHERE m.run_id = runs.id AND m.role IN ('agent', 'tool'));
  `,
  `
  -- The task's Bitbucket pull request, once the merge step opens it.
  ALTER TABLE tasks ADD COLUMN pr_id INTEGER;
  ALTER TABLE tasks ADD COLUMN pr_url TEXT;
  `,
  `
  -- A project can use its own Claude login. Each run remembers the config folder its session lives in.
  ALTER TABLE projects ADD COLUMN claude_config_dir TEXT;
  ALTER TABLE runs ADD COLUMN claude_config_dir TEXT;
  `,
  `
  -- Projects can live on Bitbucket or GitHub. NULL fields fall back to the origin remote.
  ALTER TABLE projects RENAME COLUMN bitbucket_workspace TO repo_owner;
  ALTER TABLE projects RENAME COLUMN bitbucket_repo TO repo_name;
  ALTER TABLE projects ADD COLUMN repo_host TEXT;
  `,
  `
  -- Card numbers count up per project. tasks.id stays the global key. The counter never
  -- goes back, so deleting the newest card does not hand its number to the next one.
  ALTER TABLE tasks ADD COLUMN number INTEGER NOT NULL DEFAULT 0;
  UPDATE tasks SET number = (
    SELECT COUNT(*) FROM tasks t WHERE t.project_id = tasks.project_id AND t.id <= tasks.id
  );
  ALTER TABLE projects ADD COLUMN next_task_number INTEGER NOT NULL DEFAULT 1;
  UPDATE projects SET next_task_number = (
    SELECT COALESCE(MAX(number), 0) + 1 FROM tasks WHERE tasks.project_id = projects.id
  );
  CREATE UNIQUE INDEX tasks_project_number ON tasks(project_id, number);
  `,
  `
  -- A project can pick a named Claude token (DOT_CLAUDE_TOKEN_<NAME> in the server's environment).
  -- Each run remembers the one its session started with, so a resume never switches account.
  ALTER TABLE projects ADD COLUMN claude_token TEXT;
  ALTER TABLE runs ADD COLUMN claude_token TEXT;
  `,
  `
  -- Images attached to a task when it was created ('task') reach the researcher. Chat images stay 'chat'.
  ALTER TABLE attachments ADD COLUMN origin TEXT NOT NULL DEFAULT 'chat';

  -- A task cannot start until every task it is blocked by is done.
  CREATE TABLE task_dependencies (
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    blocked_by_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, blocked_by_id)
  );
  CREATE INDEX task_dependencies_blocker ON task_dependencies(blocked_by_id);

  CREATE TABLE task_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  `,
  `
  -- A log of moves, tasks that need the user, and failures. Written by the store, read by the Activity tab.
  CREATE TABLE task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX task_events_task ON task_events(task_id, id);
  `,
  `
  -- A project can cap what one task's agents spend. A task pauses once it has spent the budget since
  -- its last pause (budget_checkpoint_usd), so resuming it grants another budget's worth.
  ALTER TABLE projects ADD COLUMN task_budget_usd REAL;
  ALTER TABLE tasks ADD COLUMN budget_checkpoint_usd REAL NOT NULL DEFAULT 0;
  `,
  `
  -- Each stage can run on its own model. NULL uses the server default.
  ALTER TABLE projects ADD COLUMN research_model TEXT;
  ALTER TABLE projects ADD COLUMN execute_model TEXT;
  ALTER TABLE projects ADD COLUMN review_model TEXT;
  `,
  `
  -- A blocked task with auto_start set starts its research by itself once its blockers are done.
  ALTER TABLE tasks ADD COLUMN auto_start INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Full text search over what people write about a task: its brief, the chat, and the plans, reports and
  -- reviews. Triggers keep it current. Artifacts index their text values only, so JSON keys never match.
  CREATE VIRTUAL TABLE search USING fts5(
    kind UNINDEXED,
    task_id UNINDEXED,
    ref UNINDEXED,
    body,
    tokenize = 'unicode61 remove_diacritics 2',
    prefix = '2 3'
  );

  INSERT INTO search (kind, task_id, ref, body)
    SELECT 'task', id, id, title || char(10) || description FROM tasks;
  INSERT INTO search (kind, task_id, ref, body)
    SELECT 'message', task_id, id, text FROM messages WHERE kind IN ('text', 'question', 'error') AND text <> '';
  INSERT INTO search (kind, task_id, ref, body)
    SELECT 'plan', task_id, id, (SELECT group_concat(value, char(10)) FROM json_tree(payload) WHERE type = 'text')
    FROM artifacts WHERE type = 'plan';
  INSERT INTO search (kind, task_id, ref, body)
    SELECT 'report', task_id, id, (SELECT group_concat(value, char(10)) FROM json_tree(payload) WHERE type = 'text')
    FROM artifacts WHERE type = 'execution_report';
  INSERT INTO search (kind, task_id, ref, body)
    SELECT 'review', task_id, id, (SELECT group_concat(value, char(10)) FROM json_tree(payload) WHERE type = 'text')
    FROM artifacts WHERE type = 'review';

  CREATE TRIGGER search_task_insert AFTER INSERT ON tasks BEGIN
    INSERT INTO search (kind, task_id, ref, body) VALUES ('task', new.id, new.id, new.title || char(10) || new.description);
  END;
  CREATE TRIGGER search_task_update AFTER UPDATE OF title, description ON tasks BEGIN
    DELETE FROM search WHERE kind = 'task' AND ref = old.id;
    INSERT INTO search (kind, task_id, ref, body) VALUES ('task', new.id, new.id, new.title || char(10) || new.description);
  END;
  CREATE TRIGGER search_task_delete AFTER DELETE ON tasks BEGIN
    DELETE FROM search WHERE task_id = old.id;
  END;
  CREATE TRIGGER search_message_insert AFTER INSERT ON messages
    WHEN new.kind IN ('text', 'question', 'error') AND new.text <> ''
  BEGIN
    INSERT INTO search (kind, task_id, ref, body) VALUES ('message', new.task_id, new.id, new.text);
  END;
  CREATE TRIGGER search_artifact_insert AFTER INSERT ON artifacts
    WHEN new.type IN ('plan', 'execution_report', 'review')
  BEGIN
    INSERT INTO search (kind, task_id, ref, body)
    VALUES (
      CASE new.type WHEN 'execution_report' THEN 'report' ELSE new.type END,
      new.task_id,
      new.id,
      (SELECT group_concat(value, char(10)) FROM json_tree(new.payload) WHERE type = 'text')
    );
  END;
  `,
  `
  -- What the project's agents are told to follow. The reviewer suggests rules after a review. A suggestion
  -- becomes active when the user accepts it, and dismissed ones stay so they are not suggested again.
  CREATE TABLE project_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    status TEXT NOT NULL,
    source_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX project_rules_project ON project_rules(project_id, status);
  `,
  `
  -- The search index again, with fixed rowids: task id * 4 plus 0 for a task, 1 for a message, 2 for an artifact.
  -- Updates and deletes then find their row by rowid. Filtering on the UNINDEXED columns scanned the whole table.
  DROP TRIGGER search_task_insert;
  DROP TRIGGER search_task_update;
  DROP TRIGGER search_task_delete;
  DROP TRIGGER search_message_insert;
  DROP TRIGGER search_artifact_insert;
  DROP TABLE search;
  CREATE VIRTUAL TABLE search USING fts5(
    kind UNINDEXED,
    task_id UNINDEXED,
    body,
    tokenize = 'unicode61 remove_diacritics 2',
    prefix = '2 3'
  );

  INSERT INTO search (rowid, kind, task_id, body)
    SELECT id * 4, 'task', id, title || char(10) || description FROM tasks;
  INSERT INTO search (rowid, kind, task_id, body)
    SELECT id * 4 + 1, 'message', task_id, text FROM messages WHERE kind IN ('text', 'question', 'error') AND text <> '';
  INSERT INTO search (rowid, kind, task_id, body)
    SELECT id * 4 + 2,
      CASE type WHEN 'execution_report' THEN 'report' ELSE type END,
      task_id,
      (SELECT group_concat(value, char(10)) FROM json_tree(payload) WHERE type = 'text')
    FROM artifacts WHERE type IN ('plan', 'execution_report', 'review');

  CREATE TRIGGER search_task_insert AFTER INSERT ON tasks BEGIN
    INSERT INTO search (rowid, kind, task_id, body) VALUES (new.id * 4, 'task', new.id, new.title || char(10) || new.description);
  END;
  CREATE TRIGGER search_task_update AFTER UPDATE OF title, description ON tasks BEGIN
    DELETE FROM search WHERE rowid = old.id * 4;
    INSERT INTO search (rowid, kind, task_id, body) VALUES (new.id * 4, 'task', new.id, new.title || char(10) || new.description);
  END;
  CREATE TRIGGER search_task_delete AFTER DELETE ON tasks BEGIN
    DELETE FROM search WHERE rowid = old.id * 4;
  END;
  CREATE TRIGGER search_message_insert AFTER INSERT ON messages
    WHEN new.kind IN ('text', 'question', 'error') AND new.text <> ''
  BEGIN
    INSERT INTO search (rowid, kind, task_id, body) VALUES (new.id * 4 + 1, 'message', new.task_id, new.text);
  END;
  CREATE TRIGGER search_message_delete AFTER DELETE ON messages BEGIN
    DELETE FROM search WHERE rowid = old.id * 4 + 1;
  END;
  CREATE TRIGGER search_artifact_insert AFTER INSERT ON artifacts
    WHEN new.type IN ('plan', 'execution_report', 'review')
  BEGIN
    INSERT INTO search (rowid, kind, task_id, body)
    VALUES (
      new.id * 4 + 2,
      CASE new.type WHEN 'execution_report' THEN 'report' ELSE new.type END,
      new.task_id,
      (SELECT group_concat(value, char(10)) FROM json_tree(new.payload) WHERE type = 'text')
    );
  END;
  CREATE TRIGGER search_artifact_delete AFTER DELETE ON artifacts BEGIN
    DELETE FROM search WHERE rowid = old.id * 4 + 2;
  END;
  `,
  `
  -- What the task is for. It picks the columns, stages and gates the task goes through. Existing tasks are code changes.
  ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'code';
  `,
  `
  -- Report tasks save their output as 'document' artifacts. Search them like plans and reviews.
  DROP TRIGGER search_artifact_insert;
  CREATE TRIGGER search_artifact_insert AFTER INSERT ON artifacts
    WHEN new.type IN ('plan', 'execution_report', 'review', 'document')
  BEGIN
    INSERT INTO search (rowid, kind, task_id, body)
    VALUES (
      new.id * 4 + 2,
      CASE new.type WHEN 'execution_report' THEN 'report' ELSE new.type END,
      new.task_id,
      (SELECT group_concat(value, char(10)) FROM json_tree(new.payload) WHERE type = 'text')
    );
  END;
  `,
  `
  -- A project is a repository or a workspace. A workspace has no repository, so repo_path holds the scratch folder Dot made for it.
  ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'repo';
  `,
  `
  -- A schedule makes a task on a rhythm and starts its research. last_task_id is the task of the last firing,
  -- so the next firing can wait until that task is done.
  CREATE TABLE schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'code',
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    frequency TEXT NOT NULL,
    hour INTEGER NOT NULL DEFAULT 9,
    minute INTEGER NOT NULL DEFAULT 0,
    weekday INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    next_run_at TEXT,
    last_run_at TEXT,
    last_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
    last_note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX schedules_project ON schedules(project_id);
  CREATE INDEX schedules_due ON schedules(next_run_at) WHERE enabled = 1;
  `,
];

export type Db = DatabaseSync;

export function openDb(file: string): Db {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let version = row.user_version; version < MIGRATIONS.length; version++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
  }
  return db;
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
