# Dot

A local kanban board where Claude agents research, build, review and merge tasks. See [PLAN.md](PLAN.md) for the design.

## Run it

Needs Node 24 or newer (for the built-in `node:sqlite`).

```bash
npm install
npm run dev
```

The board opens at http://127.0.0.1:5173. The API runs on http://127.0.0.1:4317. Both bind to loopback only.

Agents run through the `claude` CLI, so it must be installed and logged in with your subscription (`claude auth`). Dot removes `ANTHROPIC_API_KEY` and other `ANTHROPIC_*` and `CLAUDE*` variables from the agents' environment, so they always use your subscription login.

To run a project on a different Claude account, set a Claude config folder in its settings, such as `~/.claude-work`. Each folder holds its own login. Log the folder in once from PowerShell:

```powershell
$env:CLAUDE_CONFIG_DIR="$HOME\.claude-work"; claude auth login; Remove-Item Env:CLAUDE_CONFIG_DIR
```

The settings dialog shows which account the folder is logged into. Leave the field blank to use the account Dot runs with. A change applies to new agent sessions. A session that already started keeps the account it started on, because its history lives in that folder.

Data lives in `data/dot.db`, with chat images in `data/attachments/` and the executor's git worktrees in `data/worktrees/`. Each worktree is on a `dot/<task-id>-<slug>` branch in your repo. The executor starts from the project's base branch, so commit anything it should see first.

Settings go in a `.env` file at the repo root, and all of them are optional:

| Variable | Default | What it does |
|---|---|---|
| `DOT_MODEL` | `opus` | Model alias or full name passed to `claude --model` |
| `DOT_MAX_AGENTS` | `2` | How many agents run at once. More tasks wait in a queue. |
| `DOT_CLAUDE_BIN` | `claude` | Path to the CLI, if it isn't on `PATH` |
| `DOT_PORT` | `4317` | API port |
| `DOT_DB` | `data/dot.db` | Database file |
| `DOT_BITBUCKET_TOKEN` | none | Bitbucket token for the merge step. Required to merge Bitbucket projects. |
| `DOT_BITBUCKET_EMAIL` | none | Your Atlassian account email, when the token is an Atlassian API token. Leave it out for a repository or workspace access token. |
| `DOT_GITHUB_TOKEN` | none | GitHub personal access token for the merge step. Required to merge GitHub projects. |
| `DOT_GITHUB_API` | `https://api.github.com` | GitHub API base URL. Change it only for GitHub Enterprise Server. |
| `DOT_MERGE_POLL_MS` | `15000` | How often the merge step checks the build |
| `DOT_MERGE_NO_CI_MS` | `300000` | How long it waits for any build status before asking you. In a repository without Pipelines or GitHub Actions it waits at most 30 seconds, then merges. |

## Merging

Pressing Merge in Merge approval runs the merge step. It checks that the branch still merges cleanly, pushes it to `origin` with your own git credentials, and opens a pull request on Bitbucket or GitHub (or reuses the open one). It then waits for the build, squash merges, moves the task to Done, and removes the worktree and local branch. Conflicts and failed builds send the task back to the executor and through review again.

Dot reads the host, owner and repo from the repository's `origin` remote. The project settings show what it found. Fill in the host, owner or repo there only to override origin, for example when origin uses an SSH alias Dot can't recognize. A host name that contains "github" or "bitbucket" counts, so aliases like `github-work` work. The tokens stay in Dot's server process. Agents and git never see them.

### GitHub

A fine-grained token for the repository needs Contents Read and Write (to merge and delete the branch), Pull requests Read and Write, Commit statuses Read, Checks Read, and Actions Read. GitHub records the token's owner as the merger, so merges show up under your name.

Dot waits for both check runs (GitHub Actions and apps) and commit statuses. A repository counts as having no CI when the branch has no `.github/workflows` folder and the repository has no workflows. A failed build sends the checks' own summaries to the executor. Dot doesn't download the full Actions logs.

After the squash merge, Dot deletes the branch on GitHub. Branch protection rules, such as required reviews, can stop the merge. The chat then says so, and Retry merge picks up from there.

### Bitbucket

A repository access token works with these permissions: Repositories Read, Pull requests Read and Write, and Pipelines Read. That's what the first real merge used.

Bitbucket records whoever calls its merge API as the author of the squash commit. With a repository or workspace access token, that's the token's name, such as "Dot app", not you. To have merges show up under your name, use an Atlassian API token from your own account instead. Set `DOT_BITBUCKET_EMAIL` to your Atlassian email and `DOT_BITBUCKET_TOKEN` to the API token. Bitbucket's merge API has no way to set a different author.

A repository counts as having no Pipelines when the branch has no `bitbucket-pipelines.yml` and the repository has never run a pipeline. Then the merge step waits at most 30 seconds in case another CI service reports a build, and merges if none does. A build that does report still has to pass.

To ask the executor a question in Review or Merge approval, use the Chat tab. Request changes sends the task back through the executor and another review.

## Deploy on Coolify

The `Dockerfile` builds one image that runs the API and serves the board. It installs git and the `claude` CLI.

1. Push this repo to a private GitHub repository.
2. In Coolify, add a new resource from that repository and pick the Dockerfile build pack. Set the port to `4317` and give it a domain.
3. Add one persistent storage mount at `/data`, as a named volume, before the first deploy. It holds the database, cloned repos, worktrees, chat images and the Claude login. The `VOLUME /data` line in the Dockerfile is not enough: without the mount in Coolify, every redeploy starts with an empty `/data` and your tasks are gone. If that already happened, the old data may still sit in an orphaned volume (`docker volume ls` on the server). Copy `dot/dot.db` from it into the new volume.
4. Set these environment variables:

| Variable | Required | What it does |
|---|---|---|
| `DOT_PASSWORD` | yes | The login password. Dot refuses to start on a network address without it. |
| `DOT_ALLOWED_HOSTS` | yes | The domain you gave Coolify, such as `dot.example.com`. Requests to any other host name are rejected. Separate several with commas. |
| `DOT_GITHUB_TOKEN` | for GitHub projects | Fine-grained token with the permissions listed under GitHub above. Dot also uses it to clone and push. |
| `DOT_BITBUCKET_TOKEN`, `DOT_BITBUCKET_EMAIL` | for Bitbucket projects | As under Bitbucket above. Cloning and pushing also need read and write access to repository contents. An Atlassian API token needs the `read:repository:bitbucket` and `write:repository:bitbucket` scopes. |
| `DOT_CLAUDE_TOKEN` | yes | Run `claude setup-token` on your own machine and paste the result. Agents run on your subscription with it. This is the default account. |
| `DOT_CLAUDE_TOKEN_<NAME>` | no | One more account. Run `claude setup-token` while signed in to that account and add it as, say, `DOT_CLAUDE_TOKEN_WORK`. Names are upper case letters, digits and underscores. |
| `DOT_SESSION_SECRET` | no | Signs the login cookie. Defaults to a value derived from the password. |
| `DOT_GIT_NAME`, `DOT_GIT_EMAIL` | no | The identity on the executor's commits. Defaults to `Dot` and `dot@localhost`. |
| `DOT_MAX_AGENTS` and the others above | no | Work the same as locally. |

5. Deploy, open the domain and sign in. In New project, pick the host and the repository. GitHub shows a list of the repos the token can reach. For Bitbucket, type `workspace/repo-slug`. Dot clones it into `/data/dot/repos`.

Notes:

- Agents run shell commands inside the container as the `node` user, not on your server. Agents never get Dot's variables in their environment, but they run as the same user as the server, so one could still read the server's environment through `/proc`. Use a fine-grained GitHub token limited to the repos Dot works on.
- To run a project on another account, open its settings and pick the token under Claude account. The list shows the names Dot found and never the values. A session keeps the token it started with, so changing a project's token affects new sessions only. Add or remove a token variable, then redeploy.
- A project's Claude config folder still works, but the in-app Sign in button does not, because the sign-in callback goes to localhost. In the Coolify terminal, run `gosu node env CLAUDE_CONFIG_DIR=/data/home/.claude-work claude auth login` and set the same folder in the project.
- Local use is unchanged. Without `DOT_HOST` and `DOT_PASSWORD`, Dot binds to loopback with no login.

## Layout

- `shared/` holds zod schemas and types used by both sides.
- `server/` is a Hono API over SQLite, with server-sent events at `/api/events` so open boards refresh.
- `web/` is the React board, styled with Tailwind CSS v4 and shadcn/ui (Radix, Nova preset). Add components with `npx shadcn@latest add <name>` from `web/`. They land in `web/src/components/ui/` and are ours to edit. Dark mode follows the system setting through a `.dark` class set in `index.html`.

## Moving cards

Drag a card by its grip. With the keyboard, focus the grip and press Alt with the arrow keys. Left and right change column. Up and down change order.
