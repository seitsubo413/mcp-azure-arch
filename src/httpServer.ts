// src/httpServer.ts
import express from "express";
import cors from "cors";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "path";
import { fileURLToPath } from "url";

type MCPTextContent = { type: "text"; text: string };
type MCPContent = MCPTextContent | { type: string; [k: string]: any };
interface ToolResponse { content: MCPContent[]; }

const app = express();
const PORT = Number(process.env.PORT || 3000);

function sanitizeMermaid(input: string) {
    let i = 0;
    // 例:  undefined["AppGateway"]:::sec  →  n0["AppGateway"]:::sec
    const out = input.replace(/(^|\s)undefined\[(.*?)\]/g, (_m, lead, label) => {
      const id = `n${i++}`;
      return `${lead}${id}[${label || "Unnamed"}]`;
    });
    // MermaidのIDは英数と_推奨。ラベルはそのまま。
    // もし "bad id" が入ってた場合も救う（id[...label...])
    return out.replace(/(^|\s)([^\s\[\]]+)\[/g, (_m, lead, rawId) => {
      const safe = rawId.replace(/[^\w]/g, "_");
      return `${lead}${safe}[`;
    });
  }

// ---- middlewares ----
app.use(cors()); // 型エラーが出るなら: npm i -D @types/cors
app.use(express.json({ limit: "1mb" }));

// ---- API ----
app.post("/api/design", async (req, res) => {
  const { prompt, mode } = (req.body ?? {}) as { prompt?: string; mode?: "rule" | "docs" };
  if (!prompt || prompt.trim().length < 3) return res.status(400).json({ error: "prompt is required (>=3 chars)" });
  const useDocs = mode === "docs";

  const envObj: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => typeof v === "string")
  ) as Record<string, string>;

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "tsx", "src/server.ts"],
    env: envObj,
  });

  const client = new Client({ name: "web-frontend", version: "0.1.0" });
  try {
    await client.connect(transport);

    const toolName = useDocs ? "arch_from_prompt_via_docs" : "design_azure_architecture";
    const resp = (await client.callTool({ name: toolName, arguments: { prompt } })) as ToolResponse;

    let mermaid = "", bicep = "", model: any = null, fallback: string | null = null;
    for (const c of resp.content ?? []) {
      if (c.type === "text" && typeof (c as any).text === "string") {
        const t = (c as any).text.trim();
        if (!mermaid && (/^flowchart\s/i.test(t) || /^graph\s/i.test(t))) mermaid = t;
        if (!bicep && /(^|\n)\s*(param|resource)\s+[A-Za-z0-9_]+\s+/.test(t)) bicep = t;
        if (!model && t.startsWith("{")) { try { model = JSON.parse(t); } catch {} }
        if (/\/\*\s*Fallback used due to error:/i.test(t)) fallback = t;
      }
    }
    if (!mermaid) return res.status(500).json({ error: "Mermaid not found in response" });
    const sanitized = sanitizeMermaid(mermaid);
    res.json({ mermaid: sanitized, bicep: bicep || null, model, fallback, mode: useDocs ? "docs" : "rule" });
    // res.json({ mermaid, bicep: bicep || null, model, fallback, mode: useDocs ? "docs" : "rule" });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  } finally {
    await client.close().catch(() => {});
  }
});

// ---- static & SPA fallback ----
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "..", "public");

// 静的ファイル配信
app.use(express.static(publicDir));

// ルートで index.html を返す（明示）
app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// 追加: SPA想定で、未マッチのGETは index.html にフォールバック（APIは除外）
app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// ---- start ----
app.listen(PORT, () => {
  console.log(`Web API ready: http://localhost:${PORT}`);
});