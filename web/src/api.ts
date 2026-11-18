import type {
  AttachmentRef,
  ChatMessage,
  ClaudeAccount,
  ClaudeTokens,
  ClaudeUsage,
  ExecutionArtifact,
  Plan,
  PlanArtifact,
  Project,
  ProjectInput,
  ProjectOverview,
  ProjectPatch,
  RemoteInfo,
  ReviewArtifact,
  Run,
  SendMessage,
  Task,
  TaskDiff,
  TaskInput,
  TaskMove,
  TaskPatch,
  TaskEvent,
  TaskTemplate,
  TemplateInput,
} from "@dot/shared";

const signedOutListeners = new Set<() => void>();

// Runs when the server answers 401, so the board can show the login form again.
export function onSignedOut(listener: () => void): () => void {
  signedOutListeners.add(listener);
  return () => signedOutListeners.delete(listener);
}

async function send<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, init);
  // Login attempts also answer 401 (a wrong password). Those errors belong to the form.
  if (res.status === 401 && path !== "/login") signedOutListeners.forEach((listener) => listener());
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? `${res.status} ${res.statusText}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  return send<T>(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export const api = {
  session: () => request<{ authRequired: boolean; signedIn: boolean }>("/session"),
  login: (password: string) => request<void>("/login", "POST", { password }),
  logout: () => request<void>("/logout", "POST"),
  githubRepos: () =>
    request<{ configured: boolean; bitbucket: boolean; deployed: boolean; repos: { fullName: string; defaultBranch: string; private: boolean }[] }>("/github/repos"),
  listProjects: () => request<Project[]>("/projects"),
  createProject: (input: ProjectInput) => request<Project>("/projects", "POST", input),
  updateProject: (id: number, patch: ProjectPatch) => request<Project>(`/projects/${id}`, "PATCH", patch),
  deleteProject: (id: number, removeFolder = false) =>
    request<void>(`/projects/${id}${removeFolder ? "?removeFolder=1" : ""}`, "DELETE"),
  claudeAccount: (configDir: string | null, token: string | null = null) =>
    request<ClaudeAccount>("/claude-account", "POST", { configDir, token }),
  claudeUsage: (configDir: string | null, token: string | null = null) =>
    request<ClaudeUsage>("/claude-usage", "POST", { configDir, token }),
  claudeTokens: () => request<ClaudeTokens>("/claude-tokens"),
  claudeLogin: (configDir: string) => request<{ url: string }>("/claude-login", "POST", { configDir }),
  claudeLoginStatus: (configDir: string) =>
    request<{ running: boolean; error: string | null }>("/claude-login-status", "POST", { configDir }),
  repoRemote: (repoPath: string) => request<RemoteInfo>("/repo-remote", "POST", { repoPath }),

  overview: () => request<ProjectOverview[]>("/overview"),
  listTasks: (projectId: number) => request<Task[]>(`/projects/${projectId}/tasks`),
  createTask: (input: TaskInput) => request<Task>("/tasks", "POST", input),
  createTasks: (projectId: number, titles: string[]) => request<Task[]>("/tasks/batch", "POST", { projectId, titles }),
  listTemplates: (projectId: number) => request<TaskTemplate[]>(`/projects/${projectId}/templates`),
  addTemplate: (projectId: number, input: TemplateInput) =>
    request<TaskTemplate>(`/projects/${projectId}/templates`, "POST", input),
  deleteTemplate: (id: number) => request<void>(`/templates/${id}`, "DELETE"),
  updateTask: (id: number, patch: TaskPatch) => request<Task>(`/tasks/${id}`, "PATCH", patch),
  moveTask: (id: number, move: TaskMove) => request<Task>(`/tasks/${id}/move`, "POST", move),
  deleteTask: (id: number) => request<void>(`/tasks/${id}`, "DELETE"),

  startTask: (id: number) => request<Task>(`/tasks/${id}/start`, "POST"),
  stopTask: (id: number) => request<void>(`/tasks/${id}/stop`, "POST"),
  listEvents: (id: number) => request<TaskEvent[]>(`/tasks/${id}/events`),
  listRuns: (id: number) => request<Run[]>(`/tasks/${id}/runs`),
  listMessages: (id: number, after = 0) =>
    request<ChatMessage[]>(`/tasks/${id}/messages${after > 0 ? `?after=${after}` : ""}`),
  sendMessage: (id: number, message: SendMessage) => request<ChatMessage>(`/tasks/${id}/messages`, "POST", message),

  getPlan: (id: number) => request<PlanArtifact | null>(`/tasks/${id}/plan`),
  getReport: (id: number) => request<ExecutionArtifact | null>(`/tasks/${id}/report`),
  getReview: (id: number) => request<ReviewArtifact | null>(`/tasks/${id}/review`),
  approveReview: (id: number) => request<Task>(`/tasks/${id}/review/approve`, "POST"),
  merge: (id: number, skipCi = false) => request<Task>(`/tasks/${id}/merge`, "POST", { skipCi }),
  requestChanges: (id: number, notes: string) =>
    request<Task>(`/tasks/${id}/review/request-changes`, "POST", { notes }),
  getDiff: (id: number) => request<TaskDiff | null>(`/tasks/${id}/diff`),
  savePlan: (id: number, plan: Plan) => request<PlanArtifact>(`/tasks/${id}/plan`, "PUT", { plan }),
  approvePlan: (id: number) => request<Task>(`/tasks/${id}/plan/approve`, "POST"),
  sendBack: (id: number, notes: string) => request<Task>(`/tasks/${id}/plan/send-back`, "POST", { notes }),

  // kind "task" images go to the researcher with the task's brief. Chat images (the default) go with a message.
  uploadAttachment: (taskId: number, file: File, kind: "chat" | "task" = "chat") =>
    send<AttachmentRef>(`/tasks/${taskId}/attachments${kind === "task" ? "?kind=task" : ""}`, {
      method: "POST",
      headers: { "Content-Type": file.type, "X-File-Name": encodeURIComponent(file.name || "image") },
      body: file,
    }),
};

export const attachmentUrl = (id: number) => `/api/attachments/${id}`;

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
