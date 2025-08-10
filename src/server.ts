// src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import "dotenv/config";
// ルールベース生成（オフライン可）
import { parsePrompt } from "./lib/parse.js";
import { templateWebPaaS } from "./lib/templates.js";
import { emitMermaid } from "./lib/emitMermaid.js";
import { normalizeModel } from "./lib/normalize.js";


// Docs＋LLM パイプライン（要ネット・要Azure OpenAI環境変数）
import { searchDocs } from "./lib/docsClient.js";          // ← 使う場合は src/lib/docsClient.ts を用意
import { synthesizeModelFromPrompt } from "./lib/synth.js"; // ← 使う場合は src/lib/synth.ts を用意

const server = new McpServer({ name: "mcp-azure-arch", version: "0.2.0" });

/**
 * ツール1: ルールベース（超高速・オフラインOK）
 * 入力のキーワードからテンプレ構成 → Mermaid を返す
 */
server.registerTool(
  "design_azure_architecture",
  {
    title: "Design Azure Architecture (Rule-based)",
    description: "自然言語の要件からルールベースにAzureアーキテクチャ図(mermaid)を生成",
    inputSchema: { prompt: z.string().min(3) },
  },
  async ({ prompt }) => {
    const flags = parsePrompt(prompt);

    // まず雛形を生成（今まで通り）
    let model = templateWebPaaS({
      region: flags.region,
      vpn: flags.vpn,
      waf: flags.waf,
      firewall: flags.firewall,
      bastion: flags.bastion,
      expressRouteReady: flags.expressRouteReady,
      appServiceSku: flags.appServiceSku,
      appInstances: flags.appInstances,
      storageRedundancy: flags.storageRedundancy,
      sqlTier: flags.sqlTier,
      privateEndpointSql: flags.privateEndpointSql,
      privateEndpointStorage: flags.privateEndpointStorage,
      privateEndpointKeyVault: flags.privateEndpointKeyVault,
    });
    
    // ↓ ここで不足補完・重複除去などの正規化
    model = normalizeModel(model, {
      enforceWaf: flags.waf,
      enforceVpn: flags.vpn,
      enforceFirewall: flags.firewall, 
      enforceBastion: flags.bastion, 
      enforcePE: {
        sql: flags.privateEndpointSql,
        storage: flags.privateEndpointStorage,
        kv: flags.privateEndpointKeyVault,
      },
    });
    
    // 最終的にMermaid化
    const mermaid = emitMermaid(model);
    const notes = [
      `Region: ${model.region}`,
      ...(flags.vpn ? ["拠点間VPN前提。ExpressRoute併用時はルーティング要検討"] : []),
      ...model.notes,
    ];
    return {
      content: [
        { type: "text", text: mermaid },
        { type: "text", text: JSON.stringify({ model, notes }, null, 2) }
      ],
    };
  }
);

/**
 * ツール2: Docs参照＋LLMで中間JSON合成 → Mermaid
 * 失敗時はルールベースにフォールバック（デモを止めない）
 */
server.registerTool(
  "arch_from_prompt_via_docs",
  {
    title: "Design via Microsoft Docs + LLM",
    description: "プロンプト→Docs検索→LLMで中間JSON→Mermaid。失敗時はルールベースに自動フォールバック",
    inputSchema: { prompt: z.string().min(3) },
  },
  async ({ prompt }) => {
    try {
      const docsSnippets = await searchDocs(prompt);
      const modelRaw = await synthesizeModelFromPrompt(prompt, docsSnippets);
    
      const f = parsePrompt(prompt); // ← 追加
    
      const model = normalizeModel(modelRaw, {
        enforceWaf: f.waf,
        enforceVpn: f.vpn,
        enforceFirewall: f.firewall,
        enforceBastion: f.bastion,
        enforcePE: {
          sql: f.privateEndpointSql,
          storage: f.privateEndpointStorage,
          kv: f.privateEndpointKeyVault,
        },
      });
    
      const mermaid = emitMermaid(model);
      return {
        content: [
          { type: "text", text: mermaid },
          { type: "text", text: JSON.stringify({ model, notes: model.notes }, null, 2) }
        ],
      };
    
    } catch (e: any) {
      // フォールバック（ネット/認証/整形失敗でもデモ継続する）
      const f = parsePrompt(prompt);
      const fallback = templateWebPaaS({
        region: f.region,
        vpn: f.vpn,
        waf: f.waf,
        firewall: f.firewall,
        bastion: f.bastion,
        expressRouteReady: f.expressRouteReady,
        appServiceSku: f.appServiceSku,
        appInstances: f.appInstances,
        storageRedundancy: f.storageRedundancy,
        sqlTier: f.sqlTier,
        privateEndpointSql: f.privateEndpointSql,
        privateEndpointStorage: f.privateEndpointStorage,
        privateEndpointKeyVault: f.privateEndpointKeyVault,
      });
      const mermaid = emitMermaid(fallback);
      return {
        content: [
          { type: "text", text: mermaid },
          { type: "text", text: `/* Fallback used due to error: ${e?.message || String(e)} */` }
        ],
      };
    }
  }
);

// STDIO で待受
const transport = new StdioServerTransport();
await server.connect(transport);

// 任意: 起動確認ログ（STDIO衝突回避のため stderr に）

console.error("MCP server ready (stdio). Tools: design_azure_architecture, arch_from_prompt_via_docs");