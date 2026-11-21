import { MODEL_CHOICES, REPO_HOST_LABELS, STAGE_LABELS, type AgentStage, type ClaudeAccount, type ClaudeTokens, type Project, type ProjectInput, type ProjectKind, type RemoteInfo, type RepoHost } from "@dot/shared";
import { useEffect, useId, useState, type FormEvent } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, errorMessage } from "./api.ts";
import { ConfirmButton } from "./ConfirmButton.tsx";

const TEXT_FIELDS = [
  { name: "testCommand", label: "Test command", placeholder: "npm test" },
  { name: "lintCommand", label: "Lint command", placeholder: "npm run lint" },
  { name: "typecheckCommand", label: "Typecheck command", placeholder: "npm run typecheck" },
  { name: "devCommand", label: "Dev server command", placeholder: "npm run dev" },
  { name: "devUrl", label: "Dev server URL", placeholder: "http://localhost:3000" },
] as const;

// Mounted to open. onClose runs after the close animation, when the parent can unmount it.
export function ProjectDialog(props: {
  project: Project | null;
  onClose: () => void;
  onSaved: (project: Project) => void;
}) {
  const { project } = props;
  const id = useId();
  const [open, setOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [removeFolder, setRemoveFolder] = useState(false);
  // A project is a repository, or a workspace with no repository. It cannot change after it is made.
  const [kind, setKind] = useState<ProjectKind>(project?.kind ?? "repo");
  const isWorkspace = kind === "workspace";
  const [repoPath, setRepoPath] = useState(project?.repoPath ?? "");
  const [repoHost, setRepoHost] = useState<RepoHost | "auto">(project?.repoHost ?? "auto");
  // A new project can name a GitHub repository for Dot to clone, when a GitHub token is set.
  const [source, setSource] = useState<"path" | "clone">("path");
  const [cloneHost, setCloneHost] = useState<RepoHost>("github");
  // Whether Dot has a token for each host, so it knows which can be cloned from.
  const [canClone, setCanClone] = useState(true);
  const [tokenMissing, setTokenMissing] = useState(false);
  const [repos, setRepos] = useState<{ fullName: string; defaultBranch: string; private: boolean }[]>([]);
  const [baseBranch, setBaseBranch] = useState(project?.baseBranch ?? "main");
  // "default" means no named token. Otherwise the name of a DOT_CLAUDE_TOKEN_<NAME> variable.
  const [claudeToken, setClaudeToken] = useState(project?.claudeToken ?? "default");
  // "default" means the server's model. Otherwise an alias, or a full model name set through the API.
  const [models, setModels] = useState<Record<AgentStage, string>>({
    research: project?.researchModel ?? "default",
    execute: project?.executeModel ?? "default",
    review: project?.reviewModel ?? "default",
  });

  useEffect(() => {
    if (project) return;
    api.githubRepos().then(
      (r) => {
        setRepos(r.repos);
        setCloneHost(r.configured || !r.bitbucket ? "github" : "bitbucket");
        // Without a token only public repos clone. Say so, and start on cloning anyway when deployed.
        setTokenMissing(!r.configured && !r.bitbucket);
        if (r.configured || r.bitbucket || r.deployed) setSource("clone");
      },
      () => undefined,
    );
  }, [project]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setOpen(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "").trim();
    const shared = {
      claudeConfigDir: text("claudeConfigDir") || null,
      claudeToken: claudeToken === "default" ? null : claudeToken,
      taskBudgetUsd: text("taskBudgetUsd") === "" ? null : Number(text("taskBudgetUsd")),
      researchModel: models.research === "default" ? null : models.research,
    };
    const input: ProjectInput = isWorkspace
      ? { kind: "workspace", name: text("name"), ...shared }
      : {
      kind: "repo",
      name: text("name"),
      ...(source === "clone" && !project ? { cloneRepo: text("cloneRepo") } : { repoPath: text("repoPath") }),
      baseBranch: text("baseBranch") || "main",
      browserTesting: form.get("browserTesting") === "on",
      ...shared,
      executeModel: models.execute === "default" ? null : models.execute,
      reviewModel: models.review === "default" ? null : models.review,
      repoHost: source === "clone" && !project ? cloneHost : repoHost === "auto" ? null : repoHost,
      repoOwner: text("repoOwner") || null,
      repoName: text("repoName") || null,
    };
    if (!isWorkspace) for (const field of TEXT_FIELDS) input[field.name] = text(field.name) || null;
    input.favroBoard = text("favroBoard") || null;

    // Once saved, the button only closes. A base branch swap stays on screen until it is read.
    if (notice) {
      setOpen(false);
      return;
    }
    setBusy(true);
    setError(null);
    (project ? api.updateProject(project.id, input) : api.createProject(input)).then(
      (saved) => {
        props.onSaved(saved);
        if (saved.baseBranchNote) setNotice(saved.baseBranchNote);
        else setOpen(false);
        setBusy(false);
      },
      (err) => {
        setError(errorMessage(err));
        setBusy(false);
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl" onCloseAutoFocus={props.onClose}>
        <form className="grid gap-5" onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>{project ? "Project settings" : "New project"}</DialogTitle>
            <DialogDescription>
              {isWorkspace
                ? "A workspace has no repository. Dot makes a scratch folder for its agents. It holds tasks that don't change code, such as reports."
                : "A project points Dot at a git repo, either a folder on this machine or a GitHub or Bitbucket repository Dot clones. Agents work in worktrees of that repo."}
            </DialogDescription>
          </DialogHeader>

          {!project && (
            <Tabs value={kind} onValueChange={(v) => setKind(v as ProjectKind)}>
              <TabsList>
                <TabsTrigger value="repo">Repository</TabsTrigger>
                <TabsTrigger value="workspace">Workspace</TabsTrigger>
              </TabsList>
            </Tabs>
          )}

          <div className="grid gap-2">
            <Label htmlFor={`${id}-name`}>Name</Label>
            <Input id={`${id}-name`} name="name" required maxLength={100} defaultValue={project?.name} />
          </div>

          {!isWorkspace && (
          <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
            {source === "clone" && !project ? (
              <div className="grid gap-2">
                <Label htmlFor={`${id}-cloneRepo`}>{cloneHost === "bitbucket" ? "Bitbucket repository" : "GitHub repository"}</Label>
                <div className="flex gap-2">
                  <Select value={cloneHost} onValueChange={(v) => setCloneHost(v as RepoHost)}>
                    <SelectTrigger aria-label="Host" className="w-32 shrink-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="github">GitHub</SelectItem>
                      <SelectItem value="bitbucket">Bitbucket</SelectItem>
                    </SelectContent>
                  </Select>
                <Input
                  id={`${id}-cloneRepo`}
                  name="cloneRepo"
                  required
                  list={cloneHost === "github" ? `${id}-repos` : undefined}
                  placeholder={cloneHost === "bitbucket" ? "workspace/repo-slug" : "owner/name"}
                  spellCheck={false}
                  autoComplete="off"
                  className="font-mono"
                  onChange={(e) => {
                    const match = repos.find((r) => r.fullName === e.target.value);
                    if (cloneHost === "github" && match) setBaseBranch(match.defaultBranch);
                  }}
                />
                </div>
                <datalist id={`${id}-repos`}>
                  {repos.map((r) => (
                    <option key={r.fullName} value={r.fullName} />
                  ))}
                </datalist>
                {tokenMissing && (
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    No DOT_GITHUB_TOKEN or DOT_BITBUCKET_TOKEN is set on the server, so only public repositories can be cloned.
                  </p>
                )}
                <button
                  type="button"
                  className="justify-self-start text-xs text-muted-foreground underline"
                  onClick={() => setSource("path")}
                >
                  Use a folder on this machine instead
                </button>
              </div>
            ) : (
              <div className="grid gap-2">
                <Label htmlFor={`${id}-repoPath`}>Repo path</Label>
                <Input
                  id={`${id}-repoPath`}
                  name="repoPath"
                  required
                  value={repoPath}
                  onChange={(e) => setRepoPath(e.target.value)}
                  placeholder="D:\code\my-repo"
                  spellCheck={false}
                  className="font-mono"
                />
                {!project && canClone && (
                  <button
                    type="button"
                    className="justify-self-start text-xs text-muted-foreground underline"
                    onClick={() => setSource("clone")}
                  >
                    Clone a repository instead
                  </button>
                )}
              </div>
            )}
            <div className="grid gap-2">
              <Label htmlFor={`${id}-baseBranch`}>Base branch</Label>
              <Input
                id={`${id}-baseBranch`}
                name="baseBranch"
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.target.value)}
                spellCheck={false}
                className="font-mono"
              />
            </div>
          </div>
          )}

          <div className="grid gap-2">
            <Label htmlFor={`${id}-favroBoard`}>Favro board to import cards from</Label>
            <Input
              id={`${id}-favroBoard`}
              name="favroBoard"
              defaultValue={project?.favroBoard ?? ""}
              placeholder="A link copied from Favro, or a board ID"
              spellCheck={false}
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">Optional. Needs DOT_FAVRO_EMAIL and DOT_FAVRO_TOKEN in Dot's .env file.</p>
          </div>

          {!isWorkspace && <PullRequestFields id={id} project={project} repoPath={repoPath} host={repoHost} onHostChange={setRepoHost} />}

          {!isWorkspace && (
          <fieldset className="grid gap-4 rounded-lg border p-4">
            <legend className="px-1 text-sm font-medium">Commands</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              {TEXT_FIELDS.map((f) => (
                <div key={f.name} className="grid gap-2">
                  <Label htmlFor={`${id}-${f.name}`}>{f.label}</Label>
                  <Input
                    id={`${id}-${f.name}`}
                    name={f.name}
                    defaultValue={project?.[f.name] ?? ""}
                    placeholder={f.placeholder}
                    spellCheck={false}
                    className="font-mono"
                  />
                </div>
              ))}
            </div>
            <div className="flex items-start gap-3">
              <Checkbox
                id={`${id}-browserTesting`}
                name="browserTesting"
                defaultChecked={project?.browserTesting}
                className="mt-0.5"
              />
              <Label htmlFor={`${id}-browserTesting`} className="leading-snug font-normal">
                Reviewer tests UI changes in a browser, using the dev server command and URL
              </Label>
            </div>
          </fieldset>
          )}

          <fieldset className="grid gap-3">
            <legend className="mb-1 text-sm font-medium">{isWorkspace ? "Model" : "Model per stage"}</legend>
            <div className={isWorkspace ? "grid gap-3 sm:max-w-xs" : "grid gap-3 sm:grid-cols-3"}>
              {(isWorkspace ? (["research"] as const) : (["research", "execute", "review"] as const)).map((stage) => {
                const value = models[stage];
                const custom = value !== "default" && !(MODEL_CHOICES as readonly string[]).includes(value);
                return (
                  <div key={stage} className="grid gap-2">
                    <Label htmlFor={`${id}-model-${stage}`}>{isWorkspace ? "Report agent" : STAGE_LABELS[stage]}</Label>
                    <Select value={value} onValueChange={(v) => setModels((m) => ({ ...m, [stage]: v }))}>
                      <SelectTrigger id={`${id}-model-${stage}`} className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="default">Server default</SelectItem>
                        {MODEL_CHOICES.map((m) => (
                          <SelectItem key={m} value={m}>
                            {m[0]!.toUpperCase() + m.slice(1)}
                          </SelectItem>
                        ))}
                        {custom && <SelectItem value={value}>{value}</SelectItem>}
                      </SelectContent>
                    </Select>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              A cheaper model for research or review saves usage. A running agent keeps its model until it restarts.
            </p>
          </fieldset>

          <div className="grid gap-2">
            <Label htmlFor={`${id}-taskBudgetUsd`}>Budget per task (USD)</Label>
            <Input
              id={`${id}-taskBudgetUsd`}
              name="taskBudgetUsd"
              type="number"
              inputMode="decimal"
              min="0.01"
              step="any"
              defaultValue={project?.taskBudgetUsd ?? ""}
              placeholder="No limit"
              aria-describedby={`${id}-taskBudgetUsd-hint`}
              className="max-w-40"
            />
            <p id={`${id}-taskBudgetUsd-hint`} className="text-xs text-muted-foreground">
              A task pauses and asks for you when its agents have spent this much at API prices. Resuming gives it
              another budget. Your subscription covers the real cost.
            </p>
          </div>

          <ClaudeAccountField
            id={`${id}-claudeConfigDir`}
            initial={project?.claudeConfigDir ?? ""}
            token={claudeToken}
            onTokenChange={setClaudeToken}
          />

          {error && (
            <Alert variant="destructive">
              <AlertDescription className="whitespace-pre-wrap">{error}</AlertDescription>
            </Alert>
          )}

          {notice && (
            <Alert>
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            {project && !notice && (
              <ConfirmButton
                label="Delete project"
                title="Delete this project?"
                description={
                  <span className="grid gap-3">
                    <span>
                      "{project.name}" and all its tasks will be removed.
                      {project.kind === "workspace" ? " Its scratch folder is removed too." : project.cloned ? "" : " The repo on disk is not touched."} This cannot be undone.
                    </span>
                    {project.cloned && (
                      <span className="flex items-start gap-2">
                        <Checkbox
                          id={`${id}-removeFolder`}
                          checked={removeFolder}
                          onCheckedChange={(checked) => setRemoveFolder(checked === true)}
                          className="mt-0.5"
                        />
                        <Label htmlFor={`${id}-removeFolder`} className="leading-snug font-normal">
                          Also delete the cloned folder from disk ({project.repoPath})
                        </Label>
                      </span>
                    )}
                  </span>
                }
                confirmLabel="Delete project"
                disabled={busy}
                className="sm:mr-auto"
                onConfirm={() => void run(() => api.deleteProject(project.id, project.cloned === true && removeFolder))}
              />
            )}
            {!notice && (
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
            )}
            <Button type="submit" disabled={busy} loading={busy}>
              {notice ? "Done" : project ? "Save" : "Add project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Where the merge step opens pull requests. Dot reads the host, owner and repo from the origin
// remote. Each field here overrides what origin says, and blank fields follow it.
function PullRequestFields(props: {
  id: string;
  project: Project | null;
  repoPath: string;
  host: RepoHost | "auto";
  onHostChange: (host: RepoHost | "auto") => void;
}) {
  const { id, project, repoPath, host } = props;
  const [info, setInfo] = useState<RemoteInfo | null>(null);
  const [failed, setFailed] = useState(false);

  // Reads origin once the path has settled, so typing doesn't send a request per key.
  useEffect(() => {
    const path = repoPath.trim();
    setInfo(null);
    setFailed(false);
    if (!path) return;
    let current = true;
    const timer = setTimeout(() => {
      api.repoRemote(path).then(
        (result) => current && setInfo(result),
        () => current && setFailed(true),
      );
    }, 400);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [repoPath]);

  const effectiveHost = host === "auto" ? (info?.host ?? null) : host;
  const token = effectiveHost === "github" ? "DOT_GITHUB_TOKEN" : effectiveHost === "bitbucket" ? "DOT_BITBUCKET_TOKEN" : null;

  return (
    <fieldset className="grid gap-4 rounded-lg border p-4">
      <legend className="px-1 text-sm font-medium">Pull requests</legend>
      <div id={`${id}-remote`} role="status" className="text-sm">
        {failed ? (
          <span className="text-muted-foreground">Dot reads the host and repo from origin once the repo path is valid.</span>
        ) : !info ? null : !info.url ? (
          <span className="text-amber-700 dark:text-amber-300">
            This repository has no origin remote. Set the host, owner and repo below to merge.
          </span>
        ) : (
          <div className="grid gap-1">
            {info.host ? (
              <span>
                Origin is on <span className="font-medium">{REPO_HOST_LABELS[info.host]}</span>
                {info.owner && info.name ? (
                  <>
                    {" at "}
                    <span className="font-mono">{`${info.owner}/${info.name}`}</span>
                  </>
                ) : null}
                .
              </span>
            ) : (
              <span className="text-amber-700 dark:text-amber-300">Dot can't tell which host origin is on. Pick it below.</span>
            )}
            <code className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{info.url}</code>
          </div>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="grid gap-2">
          <Label htmlFor={`${id}-repoHost`}>Host</Label>
          <Select value={host} onValueChange={(v) => props.onHostChange(v as RepoHost | "auto")}>
            <SelectTrigger id={`${id}-repoHost`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{info?.host ? `From origin (${REPO_HOST_LABELS[info.host]})` : "From origin"}</SelectItem>
              <SelectItem value="bitbucket">Bitbucket</SelectItem>
              <SelectItem value="github">GitHub</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${id}-repoOwner`}>{effectiveHost === "bitbucket" ? "Workspace" : "Owner"}</Label>
          <Input
            id={`${id}-repoOwner`}
            name="repoOwner"
            defaultValue={project?.repoOwner ?? ""}
            placeholder={info?.owner ?? "my-team"}
            aria-describedby={`${id}-remote ${id}-repoHint`}
            spellCheck={false}
            className="font-mono"
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${id}-repoName`}>{effectiveHost === "bitbucket" ? "Repo slug" : "Repo"}</Label>
          <Input
            id={`${id}-repoName`}
            name="repoName"
            defaultValue={project?.repoName ?? ""}
            placeholder={info?.name ?? "my-repo"}
            aria-describedby={`${id}-remote ${id}-repoHint`}
            spellCheck={false}
            className="font-mono"
          />
        </div>
      </div>
      <p id={`${id}-repoHint`} className="text-xs text-muted-foreground">
        Leave the owner and repo blank to use what origin says.
        {token ? ` Merging needs ${token} in Dot's .env file.` : ""}
      </p>
    </fieldset>
  );
}

// The Claude login this project's agents use. Blank uses the one Dot itself runs with.
function ClaudeAccountField(props: {
  id: string;
  initial: string;
  token: string;
  onTokenChange: (token: string) => void;
}) {
  const { id, initial, token, onTokenChange } = props;
  const [tokens, setTokens] = useState<ClaudeTokens | null>(null);
  const [dir, setDir] = useState(initial);
  const [checked, setChecked] = useState<{ dir: string; account: ClaudeAccount } | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  // Set only when the browser blocked the new tab, so the person can open the sign-in page by hand.
  const [loginUrl, setLoginUrl] = useState<string | null>(null);

  // Opens the Claude sign-in page in this browser. The server runs the CLI, which finishes the
  // sign-in once the browser calls back to it, so poll until the folder shows a login.
  async function signIn(value: string) {
    const folder = value.trim();
    // Open the tab now, inside the click, or the browser blocks the popup once the request returns.
    const tab = window.open("about:blank", "_blank");
    setSigningIn(true);
    setError(null);
    setLoginUrl(null);
    try {
      const { url } = await api.claudeLogin(folder);
      if (tab) tab.location.href = url;
      else setLoginUrl(url);
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const status = await api.claudeLoginStatus(folder);
        if (status.error) throw new Error(status.error);
        if (!status.running) break;
      }
      setChecked({ dir: value, account: await api.claudeAccount(folder) });
    } catch (err) {
      tab?.close();
      setError(errorMessage(err));
    } finally {
      setSigningIn(false);
      setLoginUrl(null);
    }
  }

  async function check(value: string, tokenName = token) {
    setChecking(true);
    setError(null);
    try {
      setChecked({
        dir: value,
        account: await api.claudeAccount(value.trim() || null, tokenName === "default" ? null : tokenName),
      });
    } catch (err) {
      setChecked(null);
      setError(errorMessage(err));
    } finally {
      setChecking(false);
    }
  }

  // Show who the saved setting logs in as when the dialog opens.
  useEffect(() => {
    void check(initial);
    api.claudeTokens().then(setTokens, () => undefined);
  }, []);

  const account = checked && checked.dir === dir ? checked.account : null;
  const folder = account?.configDirectory ?? dir.trim();

  return (
    <fieldset className="grid gap-3 rounded-lg border p-4">
      <legend className="px-1 text-sm font-medium">Claude account</legend>
      {tokens && tokens.names.length > 0 && (
        <div className="grid gap-2">
          <Label htmlFor={`${id}-token`}>Claude token</Label>
          <p id={`${id}-token-hint`} className="text-xs text-muted-foreground">
            Each token is one account, set on the server as DOT_CLAUDE_TOKEN_NAME. It takes priority over the config folder below.
          </p>
          <Select
            value={token}
            onValueChange={(value) => {
              onTokenChange(value);
              void check(dir, value);
            }}
          >
            <SelectTrigger id={`${id}-token`} className="w-full" aria-describedby={`${id}-token-hint`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">{tokens.hasDefault ? "Default token (DOT_CLAUDE_TOKEN)" : "Default login"}</SelectItem>
              {tokens.names.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <div className="grid gap-2">
        <Label htmlFor={id}>Claude config folder</Label>
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          Each folder holds its own Claude login. Leave it blank to use the account Dot runs with.
        </p>
        <div className="flex gap-2">
          <Input
            id={id}
            name="claudeConfigDir"
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            onBlur={() => {
              if (!checked || checked.dir !== dir) void check(dir);
            }}
            placeholder="~/.claude-work"
            aria-describedby={`${id}-hint ${id}-status`}
            spellCheck={false}
            className="font-mono"
          />
          <Button type="button" variant="outline" disabled={checking} onClick={() => void check(dir)}>
            Check
          </Button>
        </div>
      </div>
      <div id={`${id}-status`} role="status" className="text-sm">
        {checking ? (
          <span className="text-muted-foreground">Checking the login...</span>
        ) : error ? (
          <span className="text-destructive">{error}</span>
        ) : account?.loggedIn ? (
          <span>
            Logged in as{" "}
            <span className="font-medium">
              {account.email ?? (token !== "default" ? `the ${token} token` : "an account with no email on record")}
            </span>
            {account.orgName || account.subscriptionType
              ? ` (${[account.orgName, account.subscriptionType && `${account.subscriptionType} plan`].filter(Boolean).join(", ")})`
              : ""}
          </span>
        ) : account ? (
          <div className="grid gap-1.5">
            <span className="text-amber-700 dark:text-amber-300">This folder has no Claude login yet.</span>
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" disabled={signingIn || !dir.trim()} onClick={() => void signIn(dir)}>
                {signingIn ? "Waiting for the browser..." : "Sign in"}
              </Button>
              {signingIn ? (
                loginUrl ? (
                  <a href={loginUrl} target="_blank" rel="noreferrer" className="text-xs underline">
                    Open the sign-in page
                  </a>
                ) : (
                  <span className="text-xs text-muted-foreground">Finish signing in in the tab that opened.</span>
                )
              ) : null}
            </div>
            <span className="text-xs text-muted-foreground">Or run this in PowerShell, then press Check:</span>
            <code className="rounded bg-muted px-2 py-1 font-mono text-xs [overflow-wrap:anywhere]">
              {`$env:CLAUDE_CONFIG_DIR="${folder}"; claude auth login; Remove-Item Env:CLAUDE_CONFIG_DIR`}
            </code>
          </div>
        ) : null}
      </div>
    </fieldset>
  );
}
