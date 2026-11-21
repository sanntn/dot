import type { ExternalIssue } from "@dot/shared";

// Reads cards from Favro through its MCP server, with the same API token the Favro REST API takes.
//   DOT_FAVRO_EMAIL  the email of the Favro account the token belongs to
//   DOT_FAVRO_TOKEN  a Favro API token (My profile, API Tokens). A read-only token is enough.
//   DOT_FAVRO_URL    the MCP endpoint, https://favro.com/mcp unless it is set
//   DOT_FAVRO_ORG    the organization ID, when the account belongs to several
// Credentials stay in Dot's server process and never reach an agent.

export class FavroError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const PROTOCOL_VERSION = "2025-06-18";
// The organization found for an account, so each request does not look it up again.
const orgCache = new Map<string, string>();
const PAGE_SIZE = 100;
const MAX_PAGES = 5;

type JsonRpcReply = { id?: number | string | null; result?: unknown; error?: { code: number; message: string } };
type ToolReply = { content?: { type: string; text?: string }[]; isError?: boolean };

type RawCard = {
  cardId: string;
  cardCommonId?: string;
  sequentialId: number;
  name: string;
  columnId?: string;
  isLane?: boolean;
  archived?: boolean;
  tags?: string[];
  detailedDescription?: string;
  description?: string;
};

// The text of a server-sent-events body: the last message that carries a JSON-RPC reply.
function replyFromEvents(text: string): JsonRpcReply | null {
  let found: JsonRpcReply | null = null;
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("\n");
    if (!data) continue;
    try {
      const parsed = JSON.parse(data) as JsonRpcReply;
      if (parsed.result !== undefined || parsed.error) found = parsed;
    } catch {
      // Not JSON, so not a reply.
    }
  }
  return found;
}

// A board as a person gives it: a link copied from Favro, or a board ID.
export const boardRef = (board: string): { boardUrl: string } | { boardId: string } =>
  /^https?:\/\//i.test(board.trim()) ? { boardUrl: board.trim() } : { boardId: board.trim() };

export class Favro {
  private session: Promise<string | null> | null = null;
  private orgId: Promise<string> | null = null;
  private nextId = 1;

  private constructor(
    private readonly url: string,
    private readonly auth: string,
    private readonly org: string | null,
  ) {}

  // Null when no token is configured. The import then says what to set.
  static fromEnv(env: NodeJS.ProcessEnv = process.env): Favro | null {
    const email = env.DOT_FAVRO_EMAIL?.trim();
    const token = env.DOT_FAVRO_TOKEN?.trim();
    if (!email || !token) return null;
    const auth = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
    return new Favro(env.DOT_FAVRO_URL?.trim() || "https://favro.com/mcp", auth, env.DOT_FAVRO_ORG?.trim() || null);
  }

  private async post(body: unknown, session: string | null): Promise<{ reply: JsonRpcReply | null; session: string | null }> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        Authorization: this.auth,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "User-Agent": "dot-favro-import",
        ...(session ? { "Mcp-Session-Id": session } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403 ? " Check DOT_FAVRO_EMAIL and DOT_FAVRO_TOKEN, and that MCP is on for the organization." : "";
      throw new FavroError(res.status, `Favro answered ${res.status}.${hint}`);
    }
    const sessionId = res.headers.get("mcp-session-id") ?? session;
    if (res.status === 202) return { reply: null, session: sessionId };
    const text = await res.text();
    // Some servers answer a notification with 200 or 204 and no body.
    if (!text.trim()) return { reply: null, session: sessionId };
    const reply = (res.headers.get("content-type") ?? "").includes("text/event-stream")
      ? replyFromEvents(text)
      : (JSON.parse(text) as JsonRpcReply);
    return { reply, session: sessionId };
  }

  // Opens the MCP session once per client.
  private open(): Promise<string | null> {
    this.session ??= (async () => {
      const init = await this.post(
        {
          jsonrpc: "2.0",
          id: this.nextId++,
          method: "initialize",
          params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "dot", version: "0.1.0" } },
        },
        null,
      );
      if (init.reply?.error) throw new FavroError(502, `Favro refused the connection: ${init.reply.error.message}`);
      await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, init.session);
      return init.session;
    })();
    // A failed open is tried again next time.
    this.session.catch(() => (this.session = null));
    return this.session;
  }

  private async tool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const session = await this.open();
    const { reply } = await this.post({ jsonrpc: "2.0", id: this.nextId++, method: "tools/call", params: { name, arguments: args } }, session);
    if (!reply || reply.error) throw new FavroError(502, `Favro's ${name} failed: ${reply?.error?.message ?? "no answer"}`);
    const result = reply.result as ToolReply;
    const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
    if (result.isError) throw new FavroError(404, text || `Favro's ${name} failed`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new FavroError(502, `Favro's ${name} answered with something Dot cannot read.`);
    }
  }

  private organizationId(): Promise<string> {
    // One lookup per account for as long as Dot runs.
    const cached = orgCache.get(this.auth);
    if (cached) return Promise.resolve(cached);
    this.orgId ??= (async () => {
      if (this.org) return this.org;
      const list = await this.tool<{ entities: { organizationId: string; name: string; mcpEnabled?: boolean }[] }>("get_organizations", { limit: 100 });
      const usable = list.entities.filter((o) => o.mcpEnabled !== false);
      if (usable.length === 0) throw new FavroError(409, "No Favro organization allows MCP. An administrator can turn it on under Apps and integrations.");
      if (usable.length > 1) {
        throw new FavroError(409, `The account belongs to ${usable.length} Favro organizations. Set DOT_FAVRO_ORG to one of: ${usable.map((o) => `${o.name} (${o.organizationId})`).join(", ")}.`);
      }
      return usable[0]!.organizationId;
    })().then((id) => {
      orgCache.set(this.auth, id);
      return id;
    });
    this.orgId.catch(() => (this.orgId = null));
    return this.orgId;
  }

  // The organization part of a task's source reference, so the same card is not imported twice.
  async refPrefix(): Promise<string> {
    return `favro:${await this.organizationId()}#`;
  }

  // Open cards on a board, newest sequential number first. `column` limits them to one column by name.
  async listCards(board: string, column?: string): Promise<{ cards: ExternalIssue[]; truncated: boolean }> {
    const organizationId = await this.organizationId();
    let boardInfo: { board: { columns?: { columnId: string; name: string }[] } };
    try {
      boardInfo = await this.tool("get_board", { organizationId, boardRef: boardRef(board) });
    } catch (err) {
      if (err instanceof FavroError && err.status === 404) {
        throw new FavroError(
          404,
          `Favro could not open the board "${board}" in organization ${organizationId}. Check the board link or ID in the project settings, and that this token's account can see the board. Favro said: ${err.message}`,
        );
      }
      throw err;
    }
    const columns = boardInfo.board.columns ?? [];
    const names = new Map(columns.map((c) => [c.columnId, c.name]));
    let from: Record<string, unknown> = { boardRef: boardRef(board) };
    if (column) {
      const wanted = columns.find((c) => c.name.toLowerCase() === column.trim().toLowerCase());
      if (!wanted) throw new FavroError(400, `The board has no column called "${column}". Its columns are ${columns.map((c) => c.name).join(", ")}.`);
      from = { columnId: wanted.columnId };
    }

    const cards: RawCard[] = [];
    let requestId: string | undefined;
    let truncated = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const answer = await this.tool<{ entities: RawCard[]; pages?: number; requestId?: string }>("get_cards", {
        organizationId,
        from,
        archived: false,
        limit: PAGE_SIZE,
        page,
        ...(requestId ? { requestId } : {}),
      });
      cards.push(...answer.entities);
      requestId = answer.requestId;
      if (page + 1 >= (answer.pages ?? 1)) break;
      if (page + 1 === MAX_PAGES) truncated = true;
    }
    const listed = cards
      .filter((c) => !c.isLane && !c.archived)
      .sort((a, b) => b.sequentialId - a.sequentialId)
      .map((c) => ({
        number: c.sequentialId,
        title: c.name,
        body: "",
        url: "",
        labels: c.columnId && names.has(c.columnId) ? [names.get(c.columnId)!] : [],
        author: null,
      }));
    return { cards: listed, truncated };
  }

  // One card with its description, or null when Favro has no card with that number.
  async getCard(number: number): Promise<ExternalIssue | null> {
    const organizationId = await this.organizationId();
    let answer: { card: RawCard };
    try {
      answer = await this.tool<{ card: RawCard }>("get_card", { organizationId, cardRef: { cardSequentialId: number } });
    } catch (err) {
      // Favro words a missing card and a card the account cannot see the same way. Any other failure is a real error.
      if (err instanceof FavroError && err.status === 404 && /not found|does(n't| not) exist/i.test(err.message)) return null;
      throw err;
    }
    const card = answer.card;
    if (card.archived) return null;
    return {
      number: card.sequentialId,
      title: card.name,
      body: card.detailedDescription ?? card.description ?? "",
      url: "",
      labels: [],
      author: null,
    };
  }
}
