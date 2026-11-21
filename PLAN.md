# Dot: a kanban board run by Claude agents

Dot is a local web app. You create a task card, and a chain of Claude agents moves it across the board. One agent researches and plans. One executes. One reviews. A final step merges the work through a Bitbucket pull request. You approve twice, once after planning and once before merge.

## Decisions so far

- Agents run locally through the `claude` CLI in headless mode (`claude -p` with stream-json input and output), one Claude Code session per stage. It runs as you, on your Claude subscription. Dot strips `ANTHROPIC_*` and `CLAUDE*` variables from the agent's environment, so an API key can't switch billing to the API. A project can name its own Claude config folder, which Dot passes as `CLAUDE_CONFIG_DIR`, to run its agents on a different login. Each run records the folder its session started in and resumes there, so switching a project's account affects new sessions only.
- The board is a local web app on localhost.
- Merging goes through a Bitbucket Cloud pull request, squash merged, and only after Bitbucket Pipelines passes.
- Human gates sit after planning and before merge. Agents can also stop and ask you a question at any stage.
- Single user, no auth. One board holds several projects, one per repo.
- Browser testing in review is a per-project setting.

## The board

| Column | Who acts | Leaves when |
|---|---|---|
| Inbox | You | You press Start |
| Research | Researcher agent | It submits a plan |
| Plan review | You | You approve, edit, or send it back with notes |
| Execute | Executor agent | It submits an execution report |
| Review | Reviewer agent | It approves, or files blocking issues (card goes back to Execute) |
| Merge approval | You | You approve |
| Merge | Merge step | The PR is merged |
| Done | | |

"Needs input" is a flag on the card, not a column. Any agent can raise it with a question. The card stays in its column with a badge, and the stage resumes once you answer. This keeps the board readable, since you can see where a blocked task is, not only that it is blocked.

The Execute and Review loop has a cap, three rounds by default. If the reviewer still files blocking issues after that, the card gets the Needs input flag and waits for you. Without a cap, two agents can trade the same fix back and forth and burn money.

## How agents hand off

Agents do not pass chat transcripts to each other. Each stage ends by calling a submit tool with a structured payload. The orchestrator validates it with zod, stores it as an artifact, and builds the next stage's prompt from the task card plus the earlier artifacts. Each stage starts with a clean context, and every handoff is something you can read on the card.

The submit tools live on an MCP endpoint inside Dot's own server (`/api/mcp/<token>`). Each agent launch gets a fresh random token in its `--mcp-config`, so a tool call always maps to its run, and the handlers write straight to the database.

| Stage | Tool | Payload |
|---|---|---|
| Any | `ask_human` | Question, optional choices, why it blocks |
| Research | `submit_plan` | Goal, acceptance criteria, files to touch, steps, test plan, risks, open assumptions |
| Execute | `submit_execution_report` | Summary, commits made, deviations from plan, how to verify |
| Review | `submit_review` | Verdict (approve or changes requested), issues with severity, file, line, and repro steps |

A stage that ends without calling its submit tool counts as failed. The orchestrator retries once, then flags the card for you.

### Asking you questions

When an agent calls `ask_human`, the tool stores the question, returns at once, and tells the agent to stop. The orchestrator ends the session and saves its session id. When you answer, it resumes that session with your answer as the next message. Holding a promise open inside the tool would also work, but a question can wait for hours, and an open promise dies on a server restart.

### Chatting with agents

Every task has a chat panel for each stage's agent. You can write long explanations and paste or drop images into it. The `ask_human` questions show up in the same thread, with any choices as quick-reply buttons, so answering a question and chatting are the same action.

- **Agent working.** Your message goes into the running session and the agent reads it at its next turn. The run does not restart.
- **Agent finished or waiting.** Dot resumes that stage's session with your message. If you chat with the researcher after it submitted a plan, it can submit a revised plan, which becomes a new plan version.
- **Earlier stages.** You can still chat with the researcher while the executor works, for example to ask why the plan chose something. Past-stage agents always run read-only, so they never touch the worktree another agent is using.
- **Images.** Dot stores them under `data/attachments/<task-id>/` and sends them as image blocks. PNG, JPEG, GIF and WebP up to 5 MB each.

The chat transcript is the same event stream the activity log shows, so one view serves both.

## The agents

Each stage is a config object holding the system prompt, model, allowed tools, permission rules, and its submit tool. All stages default to `claude-opus-5-5`, and the settings page can change the model per stage.

**Researcher.** Read-only. It gets Read, Glob, Grep, WebSearch, WebFetch, and Bash limited to read commands (`git log`, `ls`, running existing scripts with `--help`). It explores the repo, asks you about anything ambiguous, and submits a plan. The plan has to name acceptance criteria, because the reviewer checks against them later.

**Executor.** Starts when you approve the plan. It runs in the task's git worktree with Read, Write, Edit, Bash and web tools. `--restricted` confines file tools to the worktree. Deny rules block `git push`, `pull`, `fetch`, `remote`, `checkout`, `switch`, `branch`, `tag`, `worktree`, `config`, and `git -C`, so it can't leave its branch or touch your main checkout's refs. It commits to the task branch as it goes and finishes with `submit_execution_report`. Dot checks git before accepting the report: the worktree must be clean and the branch must have commits. Dot reads the commit list from git, not from the agent. The task then moves to Review. On a fix round it resumes its previous session and gets the reviewer's issue list.

Chatting with the executor outside the Execute column gives it the researcher's read-only tools.

The deny rules are guard rails, not a boundary. The executor needs a general shell for builds and tests, and testing showed that `git -c x=y branch …` or `sh -c '…'` get past prefix rules. There's no OS sandbox for Claude Code on Windows. So Dot also checks the outcome. It snapshots every ref in the repo (plus the main checkout's HEAD) when the executor starts, and compares after every turn. A change outside the task's branch shows up as an error in the chat and puts the task on Needs input. That covers new, moved or deleted branches and tags, a checkout in the main repo, and pushes or fetches, since those move the remote-tracking refs.

**Reviewer.** Starts once the executor's report is accepted and its process has exited, so the two never work in the worktree at the same time. It runs in the task's worktree with Read, Glob, Grep, and Bash, with no Write or Edit. Its shell allows the researcher's read-only commands plus the project's own test, lint and typecheck commands, exactly as configured and with no extra arguments, so it can't run something like `npm test -- -u` that rewrites files. Those commands still run code from the task branch, so the reviewer gets the same ref audit as the executor. Any files the checks leave behind are listed in the chat and passed on to the executor. It reads the diff against the base branch, runs those checks, and records every acceptance criterion as met, not met or unclear, with evidence. It finishes with `submit_review`. Dot rejects a review that skips criteria, and one whose verdict doesn't match its issues: approve means no blocking issues, changes requested means at least one.

Each review records which execution report it checked. Blocking issues go back to the executor in its own session, as a fix round, once the reviewer's process has exited. The executor's next report starts the next review, and the reviewer resumes its own session for it. Round numbers count every review on the task and never reset, so the chat, the Review tab and the reviewer all show the same number. The cap counts separately: only the reviewer's own verdicts since your last change request, so your requests never use up the agents' rounds. After three such rounds (`MAX_REVIEW_ROUNDS`) request changes, the loop stops and the task waits for you. If Dot restarts between two of these handoffs, it starts the pending review or fix round on boot. In Review you can approve anyway or write your own change request for the executor. In Merge approval you can still request changes. Non-blocking issues show in the Review tab, and any of them becomes a new task with one click.

Browser testing is planned as its own step. With the project setting on, the reviewer would also get Playwright MCP tools, start the dev server with the project's dev command, open the configured URL, and click through the changed screens.

**Merge step.** Plain code, no agent. You press Merge in Merge approval, and it runs these steps:
1. If the task's PR is already merged (Dot restarted mid-merge), it skips straight to cleanup.
2. It fetches origin's base and checks with `git merge-tree` that the branch still merges cleanly into it. No checkout is touched.
3. It pushes the branch to `origin` with your git credentials. Prompts are off and there's a time limit.
4. It opens a pull request through the Bitbucket Cloud REST API 2.0, or reuses the task's open one. The description comes from the task, the plan's goal and criteria, every execution report, and the review.
5. It polls the commit's build statuses until every one is SUCCESSFUL, FAILED or STOPPED. Any other state means keep waiting.
6. It squash merges, with the task title and plan goal as the message.
7. It moves the task to Done and removes the worktree, the local branch and its remote-tracking ref. If Bitbucket refuses the merge (required approvals, say), the chat says so and Retry merge picks up from there.

Conflicts and red builds go back to the executor, with the conflicted files or the failed step's log. The review cycle starts over, and you approve the merge again afterwards. No separate merge agent is needed. If no build status shows up within five minutes, Dot asks you, and Merge without CI skips the wait. A repository with no `bitbucket-pipelines.yml` on the branch and no pipeline runs ever counts as having no Pipelines. Then Dot waits at most 30 seconds for another CI service to report, and merges if none does. The pipelines_config endpoint would answer directly, but it needs repository admin rights. Every step is safe to repeat, so Retry merge and restart recovery run the job again from the top. Stop halts it at the next step.

The Bitbucket token lives in Dot's `.env`. It is kept out of every agent's environment and out of git's.

**Base branch.** Your local base branch falls behind as soon as Dot merges on Bitbucket. So before it creates a worktree or merges, Dot fetches origin's base into its own ref, `refs/dot/origin/<base>`, and uses that for new branches, diffs, reviews and the conflict check. The ref audit ignores that namespace. If the fetch fails, Dot falls back to your local branch and says so in the chat.

**Dot's own git calls.** Dot runs git in a `.git` folder the executor's shell can write to. So its own git calls never run repository hooks or an fsmonitor command, and never get Dot's settings in their environment. Testing confirmed a planted `post-checkout` hook and fsmonitor command fire for plain git, but not for Dot. This closes the easy routes to the token, not every route: the executor runs shell commands as you and could read `.env` directly. Use a repository access token limited to one repo, with pull request and pipeline read permissions, to keep the damage small if it ever leaks.

## Architecture

```
React board (Vite,  <--SSE/REST-->
shadcn/ui)           Node server (Hono)
                                       |
                    +------------------+------------------+
                    |                  |                  |
               Orchestrator        SQLite (node:sqlite) Bitbucket client
               (state machine,                         (REST, token in env)
                job queue)
                    |
           claude -p processes, one per stage run,
           each with cwd = the task's git worktree
```

- One TypeScript monorepo with `server/`, `web/`, and `shared/` (zod schemas and types used on both sides).
- SQLite runs through Node's built-in `node:sqlite` with plain SQL and numbered migrations. It needs no native build, which matters on Windows.
- The orchestrator is a state machine. Every transition is written to SQLite before anything runs, so a restart can pick up where it stopped.
- A job queue caps how many agents run at once, three by default.
- The server streams agent messages to the board over SSE, so you can watch a stage live from the card.
- Each task gets a worktree at `data/worktrees/<task-id>` in Dot's folder, on branch `dot/<task-id>-<slug>`, cut from the project's base branch. Keeping it outside the repo means it never shows up as untracked files in your checkout. Deleting a task removes the worktree folder but keeps the branch, so committed work is never lost. Merge (step 5) will clean up both.

## Data model

- `projects`: repo path, base branch, Bitbucket workspace and repo slug, test/lint/typecheck commands, browser testing flag with dev command and URL, per-stage model overrides.
- `tasks`: title, description, project, column, needs-input flag, branch, worktree path, review round, created and updated times.
- `runs`: task, stage, Claude Code session id, status (idle, queued, running, failed), cost at API prices.
- `messages`: the chat and activity log per task, including questions, tool calls, failed tool calls and status lines.
- `attachments`: images pasted into chat, stored under `data/attachments/`.
- `artifacts`: task, stage run, type (plan, execution report, review, merge result), JSON payload, version. Edits to a plan create a new version.
- `questions`: task, stage run, text, choices, answer, answered at.
- `events`: the raw agent message stream per stage run, for the live log and for debugging.

## Restart recovery

Dot kills its agent processes when it shuts down. On boot, any run still marked running goes back to idle, the task gets the needs-input flag, and the chat says Dot restarted. Your next message, or the Resume button, resumes the session. Questions and approvals never need recovery, since they only exist in the database.

## Cost and safety

- Each run records the cost the CLI reports. On a subscription that is what the usage would cost at API prices, so the panel labels it that way. Your plan's usage limits are the real constraint, which is why `DOT_MAX_AGENTS` defaults to 2.
- A per-task budget pauses the task and sets the needs-input flag when spent. I'd start at a few dollars per task and tune from there.
- Agents run Bash on your machine. `--restricted`, per-stage tool lists and allow rules are the main protection. Every denied call shows in the task's chat, so you can see what an agent tried.

## Build order

1. Skeleton (done). Server, SQLite, board UI with projects and tasks, manual moves between columns. No agents yet.
2. Researcher (done). Orchestrator, agent runner, `ask_human` with resume, `submit_plan`, the chat panel with image paste, and the plan review screen with approve, edit, and send back.
3. Executor (done). Worktree lifecycle, the executor's tool rules, execution report, a Changes tab with the report, commits and diff, and a chat per agent. Dot refuses to start when the base branch has no commits and warns when the main checkout has uncommitted changes, since those aren't in the worktree.
4. Reviewer (done). Test commands from project settings, review verdicts, the fix loop with its round cap, a Review tab, your approve and change-request overrides.
5. Merge (done, tested against a fake Bitbucket API). Bitbucket PR creation, waiting on Pipelines, merge, worktree cleanup, the conflict and failed-build paths.
6. Hardening. Budgets, desktop notifications for questions and approvals, settings for prompts and models per stage.
7. Browser testing in review, for projects that turn it on.

Each step leaves a working app. After step 2 you can already use Dot as a planning assistant.

## Bitbucket auth

Dot reads an Atlassian API token from `.env` with read and write scopes for repositories and pull requests. Pushing uses your existing git credentials in each repo. Neither ever reaches an agent.

## Task kinds (beyond pull requests)

A task has a kind. The kind decides which columns the task passes through, which agent stages run, which columns wait for you, and what counts as done. `shared/src/kinds.ts` holds the registry. The `code` kind is the pipeline above, and it is the only kind so far. Existing tasks migrate to `code`. `tasks.kind` holds the value.

Phases, each shippable on its own:

0. Kinds registry (done). `tasks.kind`, `KINDS`, and the orchestrator, lanes and board read gates, steps and stage columns from the kind. No behavior change for `code`.
1. Report kind (done). Columns inbox, research, report_review, done. The researcher's read-only tools, a `submit_report` tool (headline, summary, markdown body, sources, open questions) stored as a `report` artifact with versions. Approve moves the task to done. Send back resumes the session with your notes. A document view replaces the plan panel.
2. Workspace projects (done). `projects.kind` is `repo` or `workspace`. A workspace has no repository. Dot makes a scratch folder at `data/workspaces/<name>-<id>` and stores it in `repo_path`, so the column stays non-null and the code that reads it needs no null checks. The `code` kind is refused on a workspace, the dialogs hide the repository settings, and deleting the project removes the folder.
3. Triage kind (done). Columns inbox, research, triage_review, done. Input is pasted text in the description, attached images, or files in the project's working folder. `submit_proposals` returns items that are either `create_task` (title, description, kind, reason) or `drop` (with a reason). There is no label action, because Dot has no labels. The Proposals tab accepts or rejects each task with buttons or j, k, a and r, and accepting creates the task in the Inbox without starting it. Your decisions are saved apart from the agent's artifact, per version. Finishing drops what you left undecided, and sending back resumes the agent. Attachments other than images are not supported yet.
4. Schedules. A `schedules` table (project, kind, title, prompt, interval, enabled, last run, per-run budget), seeded from task templates. A server ticker creates the task and auto-starts it. It skips a run while the previous one is still active, and scheduled runs count against `DOT_MAX_AGENTS`. A feed view lists runs.
5. Outputs. A table of finished results across kinds, filterable by kind and searchable.

Column stays a closed enum. Each new kind adds its columns to it and lists the ones it uses in the registry.
