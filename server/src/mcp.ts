import { z } from "zod";

// A minimal MCP server over Streamable HTTP, answering every POST with plain JSON (no SSE stream).
// Each agent launch gets its own URL token, so a tool call always knows which run it belongs to.
// Supported: initialize, ping, tools/list, tools/call, and notifications (acknowledged, ignored).

export type ToolResult = { text: string; isError?: boolean };

export type McpTool<T extends z.ZodType = z.ZodType> = {
  name: string;
  description: string;
  schema: T;
  handler: (input: z.output<T>) => ToolResult | Promise<ToolResult>;
};

export const defineTool = <T extends z.ZodType>(tool: McpTool<T>): McpTool => tool as unknown as McpTool;

type JsonRpcRequest = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };
type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
};

const PROTOCOL_VERSION = "2025-06-18";

async function handleOne(req: JsonRpcRequest, tools: McpTool[]): Promise<JsonRpcResponse | null> {
  // Notifications have no id and get no response.
  if (req.id === undefined || req.id === null) return null;
  const reply = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id: req.id!, result });
  const fail = (code: number, message: string): JsonRpcResponse => ({
    jsonrpc: "2.0",
    id: req.id!,
    error: { code, message },
  });

  switch (req.method) {
    case "initialize":
      return reply({
        protocolVersion: typeof req.params?.protocolVersion === "string" ? req.params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "dot", version: "0.1.0" },
      });

    case "ping":
      return reply({});

    case "tools/list":
      return reply({
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: z.toJSONSchema(t.schema, { io: "input" }),
        })),
      });

    case "tools/call": {
      const name = req.params?.name;
      const tool = tools.find((t) => t.name === name);
      if (!tool) return fail(-32602, `Unknown tool: ${String(name)}`);
      const parsed = tool.schema.safeParse(req.params?.arguments ?? {});
      if (!parsed.success) {
        return reply({ content: [{ type: "text", text: z.prettifyError(parsed.error) }], isError: true });
      }
      try {
        const result = await tool.handler(parsed.data);
        return reply({ content: [{ type: "text", text: result.text }], isError: result.isError ?? false });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply({ content: [{ type: "text", text: message }], isError: true });
      }
    }

    default:
      return fail(-32601, `Method not found: ${req.method}`);
  }
}

// Returns the JSON body to send, or null for "202 Accepted, no body".
export async function handleMcp(body: unknown, tools: McpTool[]): Promise<unknown | null> {
  if (Array.isArray(body)) {
    const responses = (await Promise.all(body.map((r) => handleOne(r as JsonRpcRequest, tools)))).filter(Boolean);
    return responses.length > 0 ? responses : null;
  }
  return handleOne(body as JsonRpcRequest, tools);
}
