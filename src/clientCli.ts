import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "fs";
import path from "path";


// 使い方:
//   npx tsx src/clientCli.ts "要件プロンプト..."
//   npx tsx src/clientCli.ts --docs "要件プロンプト..."
// --docs で Docs+LLM の統合ツールを使用（なしならルールベース）

// --- MCP tool response minimal types ---
type MCPTextContent = { type: "text"; text: string };
type MCPContent = MCPTextContent | { type: string; [k: string]: any };
interface ToolResponse { content: MCPContent[]; }
const isText = (c: MCPContent): c is MCPTextContent => c.type === "text" && typeof (c as any).text === "string";

function parseArgs() {
  const args = process.argv.slice(2);
  const useDocs = args[0] === "--docs";
  const prompt = (useDocs ? args.slice(1) : args).join(" ").trim()
    || "中規模Web、可用性高、WAFあり、DBはPaaS、Hub-Spoke、社内とVPN、東日本";
  return { useDocs, prompt };
}

async function main() {
  const { useDocs, prompt } = parseArgs();

  // env: convert NodeJS.ProcessEnv to Record<string,string>
  const envObj: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => typeof v === "string")
  ) as Record<string, string>;

  // サーバープロセスを子プロセスとしてspawn（STDIO接続）
  // すでに build 済みなら ["node","dist/server.js"] でもOK
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "tsx", "src/server.ts"],
    env: envObj,
  });

  const client = new Client({ name: "azure-arch-client", version: "0.1.0" });
  await client.connect(transport);

  const toolName = useDocs ? "arch_from_prompt_via_docs" : "design_azure_architecture";
  const res = (await client.callTool({
    name: toolName,
    arguments: { prompt }
  })) as ToolResponse;

  // content からテキスト（Mermaid）を抽出
  let mermaid = "";
  for (const c of res.content) {
    if (isText(c)) {
      const t = c.text;
      if (/^graph\s/i.test(t.trim())) { mermaid = t; break; }
      if (!mermaid) mermaid = t;
    }
  }
  if (!mermaid) throw new Error("Mermaidコードが取得できませんでした。");

  // 出力フォルダ
  const outDir = path.join(process.cwd(), "out");
  await fs.mkdir(outDir, { recursive: true });

  // .mmd ファイル保存
  const mmdPath = path.join(outDir, "diagram.mmd");
  await fs.writeFile(mmdPath, mermaid, "utf-8");

  // プレビュー用HTMLを生成
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Azure Architecture Preview</title>
<script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
<style>body{font:14px/1.5 system-ui;margin:24px;max-width:1000px}pre{background:#f8f8f8;padding:12px;border-radius:8px;overflow:auto}</style>
</head>
<body>
<h1>Azure Architecture Preview</h1>
<pre>${escapeHtml(mermaid)}</pre>
<div id="d" class="mermaid">${escapeHtml(mermaid)}</div>
<script>mermaid.initialize({ startOnLoad: true });</script>
</body>
</html>`;
  const htmlPath = path.join(outDir, "diagram.html");
  await fs.writeFile(htmlPath, html, "utf-8");

  console.log("\n✅ Mermaidを生成しました。");
  console.log(" - MMD :", mmdPath);
  console.log(" - HTML:", htmlPath);

  // macOSなら自動で開く
  if (process.platform === "darwin") {
    const { exec } = await import("node:child_process");
    exec(`open "${htmlPath}"`);
  }

  await client.close();
}

// HTMLエスケープ
function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string)
  );
}

main().catch((e) => {
  console.error("Error:", e?.message || e);
  process.exit(1);
});