// src/lib/synthMermaid.ts
import OpenAI from "openai";
import { searchDocs } from "./docsClient.js"; // ★ 必ずDocsを通す

export type MermaidKnobs = {
  enforceHubSpoke?: boolean;
  enforceSingleAppGateway?: boolean;
  enforceVpnGatewayInHub?: boolean;
  enforceExpressRouteInHub?: boolean;
  enforceDbPrivateEndpoint?: boolean;
  enforcePeeringTransit?: boolean;
  enforceZones?: boolean;
  requireAppService?: boolean;
  requireAKS?: boolean;
  requireVMSS?: boolean;
  requireSQLMI?: boolean;
  requireAzureSQL?: boolean;
  includeBlobStorage?: boolean;
  includeCDN?: boolean;
  includeMonitoring?: boolean;
  includeGeoBackup?: boolean;
  withCidrHints?: boolean;
};

/* ─────────────────────────────────────────────────────────────
 *  Region / Knobs 推定
 * ──────────────────────────────────────────────────────────── */

function inferRegionHint(text: string): string | undefined {
  const t = text.toLowerCase();
  if (/(東日本|japaneast|日本東)/i.test(t)) return "japaneast";
  if (/(西日本|japanwest|日本西)/i.test(t)) return "japanwest";
  if (/(東南アジア|southeast asia|southeastasia)/i.test(t)) return "southeastasia";
  if (/(米国東部|east us|eastus)/i.test(t)) return "eastus";
  if (/(米国西部|west us|westus)/i.test(t)) return "westus";
  return undefined;
}

function inferKnobsFromText(text: string): MermaidKnobs {
  const t = text.toLowerCase().replace(/\s+/g, " ");

  const hasHubSpoke     = /(hub[-\s]?spoke|ハブ.*スポーク|スポーク.*ハブ)/i.test(t);
  const hasVPN          = /(vpn ?gateway|vpnゲートウェイ|ipsec|site[-\s]?to[-\s]?site)/i.test(t);
  const hasER           = /(express ?route|er ?gateway|erゲートウェイ)/i.test(t);
  const wantsWAF        = /(waf|アプリケーション ?ゲートウェイ|application ?gateway)/i.test(t);
  const wantsAppSvc     = /(app ?service|アプリサービス|web ?app)/i.test(t);
  const wantsAKS        = /\baks\b|kubernetes|くばねて|クバネテス/i.test(t);
  const wantsVMSS       = /\bvmss\b|仮想マシン スケール ?セット/i.test(t);
  const wantsSQLDB      = /(azure sql( database)?|sql ?db|sqlデータベース)/i.test(t);
  const wantsSQLMI      = /(sql managed instance|sql mi|sql マネージド インスタンス)/i.test(t);
  const mentionsPE      = /(private ?endpoint|プライベート ?エンドポイント|privatelink)/i.test(t);
  const wantsBlob       = /(blob|ストレージ|storage)/i.test(t);
  const mentionsGeo     = /(geo|grs|ra[- ]?grs|ジオ冗長|地理的冗長)/i.test(t);
  const mentionsTransit = /(transit|トランジット|use ?remote ?gateways|allow ?gateway ?transit|ゲートウェイ ?トランジット)/i.test(t);
  const wantsCDN        = /(front ?door|cdn)/i.test(t);
  const wantsMon        = /(monitor|log analytics|監視|ログ ?アナリティクス)/i.test(t);
  const mentionsZones   = /(ゾーン|zone|zonal|zone[- ]?redundant)/i.test(t);
  const mentionsCIDR    = /(\/\d{1,2}|\b\d{1,3}(\.\d{1,3}){3}\/\d{1,2}\b|cidr|サブネット)/i.test(t);

  const knobs: MermaidKnobs = {
    enforceHubSpoke: hasHubSpoke,
    enforceSingleAppGateway: wantsWAF,
    enforceVpnGatewayInHub: hasVPN,
    enforceExpressRouteInHub: hasER,
    enforceDbPrivateEndpoint: mentionsPE || wantsSQLDB,
    enforcePeeringTransit: hasHubSpoke || mentionsTransit,
    enforceZones: mentionsZones,
    requireAppService: wantsAppSvc,
    requireAKS: wantsAKS,
    requireVMSS: wantsVMSS,
    requireSQLMI: wantsSQLMI,
    requireAzureSQL: wantsSQLDB && !wantsSQLMI,
    includeBlobStorage: wantsBlob,
    includeCDN: wantsCDN,
    includeMonitoring: wantsMon,
    includeGeoBackup: mentionsGeo || (wantsBlob && /geo|grs/i.test(t)),
    withCidrHints: mentionsCIDR,
  };

  // 競合ゆる解決
  const backendCount = [knobs.requireAppService, knobs.requireAKS, knobs.requireVMSS].filter(Boolean).length;
  if (backendCount > 1) { knobs.requireAKS = false; knobs.requireVMSS = false; }
  if (knobs.requireSQLMI) knobs.requireAzureSQL = false;

  return knobs;
}

/* ─────────────────────────────────────────────────────────────
 *  OpenAI クライアント / Docs
 * ──────────────────────────────────────────────────────────── */

function getClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is missing. Set it in environment or .env");
  return new OpenAI({ apiKey });
}

function trimDocs(docs: string[], maxChars = 1400) {
  const joined = (docs ?? []).slice(0, 4).join("\n\n").replace(/\s+/g, " ").trim();
  return joined.slice(0, maxChars);
}

/* ─────────────────────────────────────────────────────────────
 *  System Prompt（Mermaid v11.9 向けに厳密化）
 * ──────────────────────────────────────────────────────────── */

const BASE_SYSTEM = `
You are a strict Azure network diagram generator.
Return ONLY a valid Mermaid flowchart (TB or LR). No code fences, no extra text.

RULES:
- Each VNet MUST be a Mermaid subgraph: \`subgraph <id>["<label>"]\` ... \`end\`.
- NEVER use \`:::\` class on subgraph headers; classes are for nodes only.
- One node per line. Edges on their own lines.
- Labels can include \\n for new lines inside brackets/quotes.

NODES (IDs → examples):
- hub_vnet, spoke_web_vnet, spoke_data_vnet   (subgraphs; no class)
- onprem:::sec, vpn_gw:::sec
- agw:::appc, pip_agw:::appc, appsvc:::appc
- sql_db:::data, pe_sql:::pe, pdns_sql:::keyv
- (optional) storage_blob:::data, pe_blob:::pe, pdns_blob:::keyv, monitor:::sec

EDGES:
- onprem -. IPsec .-> vpn_gw
- pip_agw --- agw
- agw --> appsvc | aks_ingress | vmss
- appsvc -.-> pe_sql ; pe_sql --- sql_db ; pe_sql -.-> pdns_sql
- pdns_* --- spoke_web_vnet ; pdns_* --- spoke_data_vnet
- hub_vnet == "VNet Peering\\n(AllowGatewayTransit)" ==> spoke_*
- spoke_* == "UseRemoteGateways" ==> hub_vnet

CLASS DEFINITIONS (append at end if used):
- classDef sec fill:#bbf,stroke:#333,stroke-width:1.2px;
- classDef appc fill:#fbb,stroke:#333,stroke-width:1.2px;
- classDef data fill:#bfb,stroke:#333,stroke-width:1.2px;
- classDef keyv fill:#ffb,stroke:#333,stroke-width:1.2px;
- classDef pe fill:#ff9,stroke:#333,stroke-width:1.2px;

OUTPUT:
- Start with \`flowchart TB\` (or LR). If region known, put \`%% Region: <region>\` on the next line.
- Do not invent SKUs/CIDR; include only when provided or obvious from overlay.
`.trim();

/* ─────────────────────────────────────────────────────────────
 *  Overlay（LLMへの具体命令）
 * ──────────────────────────────────────────────────────────── */

function buildOverlay(knobs: MermaidKnobs, regionHint?: string) {
  const L: string[] = [];
  if (regionHint) L.push(`- Region: ${regionHint}`);
  if (knobs.enforceHubSpoke) {
    L.push(`- Use hub-and-spoke with: hub_vnet, spoke_web_vnet, spoke_data_vnet as subgraphs.`);
  }
  if (knobs.enforceSingleAppGateway) {
    L.push(`- In spoke_web_vnet, include a single agw["App Gateway (WAF_v2)"] and pip_agw; connect pip_agw --- agw.`);
  }
  if (knobs.enforceVpnGatewayInHub) {
    L.push(`- In hub_vnet, include onprem and vpn_gw; connect onprem -. IPsec .-> vpn_gw.`);
  }
  if (knobs.enforceExpressRouteInHub) {
    L.push(`- If ExpressRoute is requested, prefer er_gw; avoid mixing unless dual connectivity is explicit.`);
  }
  if (knobs.enforcePeeringTransit) {
    L.push(
      `- Draw peering with transit exactly as:`,
      `  hub_vnet == "VNet Peering\\n(AllowGatewayTransit)" ==> spoke_web_vnet`,
      `  hub_vnet == "VNet Peering\\n(AllowGatewayTransit)" ==> spoke_data_vnet`,
      `  spoke_web_vnet == "UseRemoteGateways" ==> hub_vnet`,
      `  spoke_data_vnet == "UseRemoteGateways" ==> hub_vnet`
    );
  }
  if (knobs.requireAppService) {
    L.push(`- In spoke_web_vnet, include appsvc["App Service (VNet Integration)"]; connect agw --> appsvc when agw exists.`);
  }
  if (knobs.requireAzureSQL || knobs.enforceDbPrivateEndpoint) {
    L.push(
      `- In spoke_data_vnet, include pe_sql and sql_db; connect appsvc -.-> pe_sql ; pe_sql --- sql_db ;`,
      `- Include pdns_sql["Private DNS Zone:\\nprivatelink.database.windows.net"] and connect pe_sql -.-> pdns_sql;`,
      `- Connect pdns_sql --- spoke_web_vnet and --- spoke_data_vnet.`
    );
  }
  if (knobs.includeBlobStorage) {
    L.push(`- If Blob is mentioned, include storage_blob and private path pe_blob + pdns_blob similarly; (optional).`);
  }
  if (knobs.withCidrHints) {
    L.push(`- If CIDR hints appear, put them inside subgraph labels. Do not invent them.`);
  }
  return L.length ? `\nApply ALL of the following constraints:\n${L.map(x => `• ${x}`).join("\n")}` : "";
}

/* ─────────────────────────────────────────────────────────────
 *  出力整形・補修ユーティリティ
 * ──────────────────────────────────────────────────────────── */

function sanitizeMermaid(s: string) {
  s = s
    .replace(/```(?:mermaid)?\s*([\s\S]*?)```/gi, "$1")
    .replace(/~~(?:~)?(?:mermaid)?\s*([\s\S]*?)~~(?:~)?/gi, "$1")
    .trim();
  const m = s.match(/\b(?:flowchart|graph)\s+(?:TB|LR)\b/i);
  if (m && m.index! > 0) s = s.slice(m.index!);
  if (!/^(flowchart|graph)\s+(TB|LR)\b/i.test(s)) {
    const head = s.slice(0, 120).replace(/\n/g, "\\n");
    throw new Error(`LLM did not return a Mermaid diagram starting with 'flowchart TB/LR'. head="${head}"`);
  }
  return s.trim();
}

// Mermaid 本文だけを抜き出し
function stripToMermaid(text: string): string {
  if (typeof text !== "string") throw new Error("Mermaid text is not a string.");
  const cleaned = text.replace(/^\uFEFF/, "").replace(/[\u200B-\u200D\u2060\u00A0]+/g, "");
  const m = cleaned.match(/\b(?:flowchart|graph)\s+(?:TB|LR)\b/i);
  if (!m) throw new Error("No Mermaid header (flowchart/graph) found in text.");
  return cleaned.slice(m.index!).trim();
}

// OpenAI 応答から content を安全に取り出す
function pickContent(res: any): string {
  const c = res?.choices?.[0]?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p: any) => (typeof p === "string" ? p : (p?.text ?? ""))).join("");
  throw new Error("LLM response has no .message.content string.");
}

// 使用されているクラスの不足分だけ classDef を補完
function ensureClassDefsForUsedClasses(s: string): string {
  const used = new Set<string>();
  for (const m of s.matchAll(/:::\s*([a-z0-9_]+)/gi)) used.add(m[1]);

  const defs: Record<string, string> = {
    sec:  "classDef sec fill:#bbf,stroke:#333,stroke-width:1.2px;",
    appc: "classDef appc fill:#fbb,stroke:#333,stroke-width:1.2px;",
    data: "classDef data fill:#bfb,stroke:#333,stroke-width:1.2px;",
    keyv: "classDef keyv fill:#ffb,stroke:#333,stroke-width:1.2px;",
    pe:   "classDef pe fill:#ff9,stroke:#333,stroke-width:1.2px;",
  };

  const missing: string[] = [];
  for (const cls of used) {
    const re = new RegExp(`^\\s*classDef\\s+${cls}\\b`, "m");
    if (!re.test(s) && defs[cls]) missing.push(defs[cls]);
  }
  return missing.length ? `${s}\n${missing.join("\n")}\n` : s;
}

// Mermaid を v11向けに正規化＆自己修復
function normalizeMermaid(diagram: string): string {
  let s = diagram;

  // ラベル中のバックスラッシュ改行を統一
  s = s.replace(/\\\s*\n/g, "\\n");
  s = s.replace(/\\\\n/g, "\\n");

  // subgraph のあとが改行だけなら次行と結合
  s = s.replace(
    /^(\s*)subgraph\s*\n(\s*)([a-z0-9_]+\s*(?:\[[^\n]*\]|\([^\n]*\)|\{[^\n]*\}|"[^"\n]*"))/gmi,
    (_m, ind, _i2, idLine) => `${ind}subgraph ${idLine}`
  );

  // subgraph ヘッダ上の :::class を除去
  s = s.replace(/^(\s*subgraph\s+[^\n]*?)(:::\s*[a-z0-9_]+)+(?=\s|$)/gmi, "$1");

  // subgraph の前に改行を足す（行頭のみ）
  s = s.replace(/^\s+(subgraph\s+)/gmi, "\n$1");

  // flowchart と Region コメントを分離
  s = s.replace(
    /^(flowchart|graph)\s+(TB|LR)\s*%%\s*Region:\s*([^\n]+)\s*$/i,
    (_m, a, b, c) => `${a} ${b}\n%% Region: ${c}`
  );

  // ブロック整形
  s = s
    .replace(/\s+(end)(?=\s|$)/g, "\n$1\n")
    .replace(/\s+(classDef\s+)/g, "\n$1")
    .replace(/\s+(%%\s*Region:)/g, "\n$1");

  // エッジ/ノードの前で改行
  s = s.replace(/\s+([a-z0-9_]+\s*(?:---|-->|-\.\->|==>|==)\s*[a-z0-9_]+)/gi, "\n$1");
  s = s.replace(/\s+([a-z0-9_]+\s*(?:\[[^\]]*\]|\([^)]+\)|\{[^}]+\}|"[^"]*")(?:::?[a-z0-9_]+)?)/gi, "\n$1");

  // エッジ行に混入した :::class を除去
  s = s.replace(/(\b[a-z0-9_]+\s*(?:---|-->|-\.\->|==>|==)\s*\b[a-z0-9_]+)\s*:::\s*[a-z0-9_]+/gi, "$1");
  s = s.replace(/(\b[a-z0-9_]+)\s*:::\s*[a-z0-9_]+\s*(?=(?:---|-->|-\.\->|==>|==)\s*\b[a-z0-9_]+)/gi, "$1");

  // クラス定義補完（既存の ensureClassDefsForUsedClasses を利用）
  s = ensureClassDefsForUsedClasses(s);
  s = s.replace(
    /^(\s*subgraph)\s*\n\s*([a-zA-Z0-9_]+\s*(?:\[[^\n]*\]|\([^\n]*\)|\{[^\n]*\}|"[^"\n]*"))/gmi,
    (_m, sg, id) => `${sg} ${id}`
  );

  // 余計な空白除去
  return s.replace(/[ \t]+\n/g, "\n").trim();
}
/* ─────────────────────────────────────────────────────────────
 *  簡易ポスト検証（致命傷のみ）
 * ──────────────────────────────────────────────────────────── */

function quickValidateMermaid(diagram: string) {
  const subgraphs = (diagram.match(/^\s*subgraph\s+/gim) || []).length;
  if (subgraphs < 2) throw new Error("Not enough VNets (subgraphs).");

  // 実際に使われているクラスだけ存在チェック
  const used = new Set<string>();
  for (const m of diagram.matchAll(/:::\s*([a-z0-9_]+)/gi)) used.add(m[1]);
  for (const cls of used) {
    const re = new RegExp(`^\\s*classDef\\s+${cls}\\b`, "m");
    if (!re.test(diagram)) throw new Error(`classDef for "${cls}" is missing.`);
  }

  // AGW の重複定義（ノード定義行のみ）検出
  const agwDefRegex = /^\s*agw\s*(?:\[[^\]]*\]|\([^)]+\)|\{[^}]+\}|"[^"]*")/gm;
  const agwDefs = diagram.match(agwDefRegex) || [];
  if (agwDefs.length > 1) throw new Error("Multiple AGWs found (node definitions); expected exactly 1.");
}

/* ─────────────────────────────────────────────────────────────
 *  リトライ共通
 * ──────────────────────────────────────────────────────────── */

async function withRetries<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e: any) {
      lastErr = e;
      const status = e?.status || e?.response?.status;
      if (status === 429 || status >= 500) {
        const wait = Math.min(8000, 1000 * Math.pow(2, i));
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      break;
    }
  }
  throw lastErr;
}

/* ─────────────────────────────────────────────────────────────
 *  メイン：Mermaid 生成
 * ──────────────────────────────────────────────────────────── */

export async function synthesizeMermaidDiagram(
  requirementText: string,
  knobs: MermaidKnobs = {},
  regionHint?: string
): Promise<string> {
  const client = getClient();
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const inferred = inferKnobsFromText(requirementText);
  const mergedKnobs: MermaidKnobs = { ...inferred, ...knobs };
  const finalRegion = regionHint ?? inferRegionHint(requirementText);

  const docsSnippets = await withRetries(() => searchDocs(requirementText));
  const docsPart = trimDocs(docsSnippets);

  const system = BASE_SYSTEM + buildOverlay(mergedKnobs, finalRegion);
  const user = `Requirement (Japanese allowed):
${requirementText}

Helpful Microsoft Docs snippets (condensed; FOLLOW these over free-form text when conflicting):
${docsPart}

Constraints priority (highest first):
1) Overlay knobs (below)
2) Docs snippets (above)
3) Requirement text (free-form)

${buildOverlay(mergedKnobs, finalRegion)}

Return Mermaid diagram ONLY. No explanations, no backticks, no comments.`;

  const res = await withRetries(() =>
    client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 2000,
    })
  );

  // 整形 → 正規化 → 検証
  const raw = pickContent(res);
  const sliced = stripToMermaid(raw);
  const cleaned = sanitizeMermaid(sliced);
  const normalized = normalizeMermaid(cleaned);
  quickValidateMermaid(normalized);
  return normalized;
}