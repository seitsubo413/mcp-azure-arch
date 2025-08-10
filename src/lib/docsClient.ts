import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

type MCPContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string }
  | { type: "json"; data: any };

interface ToolResponse { content: MCPContent[]; }

function withTimeout<T>(p: Promise<T>, ms: number, label = "operation"): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(v => { clearTimeout(id); resolve(v); }, err => { clearTimeout(id); reject(err); });
  });
}

export async function searchDocs(query: string, topK = 5): Promise<string[]> {
  const endpoint = new URL("https://learn.microsoft.com/api/mcp");
  const client = new Client({ name: "docs-client", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(endpoint);

  try {
    await withTimeout(client.connect(transport), 10_000, "Docs MCP connect");
    console.error(`Connected to Docs MCP: ${endpoint.href}`);

    const toolList = await withTimeout(client.listTools(), 10_000, "listTools");
    const names = (toolList.tools ?? []).map(t => t.name);
    console.error(`Tools: ${names.join(", ") || "(none)"}`);

    const toolName = names.includes("microsoft_docs_search")
      ? "microsoft_docs_search"
      : names[0];
    if (!toolName) throw new Error("No tools exposed by Docs MCP");

    console.error(`Using tool: ${toolName}  query="${query}"`);
    const res = (await withTimeout(
      client.callTool({ name: toolName, arguments: { query } }),
      20_000,
      "callTool"
    )) as ToolResponse;

    const texts = (Array.isArray(res?.content) ? res.content : [])
      .filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof (c as any).text === "string")
      .map(c => c.text.trim())
      .filter(Boolean);

    console.error(`Received text chunks: ${texts.length}`);
    // console.error(texts);
    return texts.slice(0, topK);
  } catch (e: any) {
    console.error("Docs MCP error:", e?.message || e);
    throw e;
  } finally {
    await client.close().catch(() => {});
  }
}