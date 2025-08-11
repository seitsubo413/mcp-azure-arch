// src/lib/synth.ts
import OpenAI from "openai";
import { z } from "zod";

/** 軽いrefine（厳密な包含判定は normalize/リンタで） */
const idRe = /^[A-Za-z0-9_]+$/;
const cidrRe = /^(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

const SubnetSchema = z.object({
  id: z.string().regex(idRe, "id must be [A-Za-z0-9_]+"),
  cidr: z.string().regex(cidrRe, "cidr must be IPv4 CIDR"),
  purpose: z.enum(["public", "app", "data", "infra"]),
});

export const ModelSchema = z.object({
  region: z.string(),
  hub: z.object({
    id: z.string().regex(idRe),
    label: z.string().optional(),
    cidr: z.string().regex(cidrRe),
    kind: z.literal("hub"),
    subnets: z.array(SubnetSchema),
  }),
  spokes: z.array(
    z.object({
      id: z.string().regex(idRe),
      label: z.string().optional(),
      cidr: z.string().regex(cidrRe),
      kind: z.literal("spoke"),
      subnets: z.array(SubnetSchema),
    })
  ),
  resources: z.array(z.any()),
  edges: z
    .array(
      z.object({
        from: z.string(),
        to: z.string(),
        kind: z.enum(["l3", "l7"]).optional(),
      })
    )
    .optional()
    .default([]),
  notes: z.array(z.string()),
});
export type ArchModel = z.infer<typeof ModelSchema>;

/** OpenAI クライアント */
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

/** Docs抜粋は短く圧縮（コスト＆暴走抑制） */
function trimDocs(docs: string[], maxChars = 1000) {
  const joined = docs.slice(0, 3).join("\n\n").replace(/\s+/g, " ").trim();
  return joined.slice(0, maxChars);
}

function lintAndNudge(obj: any) {
  obj.notes ||= [];

  // AppGatewaySubnet を持つ spoke は1つだけ
  const appGwSpokes = (obj.spokes||[]).filter((s:any)=>
    (s.subnets||[]).some((sn:any)=>/^AppGatewaySubnet$/i.test(sn.id))
  );
  if (appGwSpokes.length > 1) {
    // 2個目以降を notes に警告して削除
    for (let i=1;i<appGwSpokes.length;i++){
      obj.notes.push(`Removed extra AppGatewaySubnet from ${appGwSpokes[i].id}`);
      appGwSpokes[i].subnets = appGwSpokes[i].subnets.filter((sn:any)=>!/^AppGatewaySubnet$/i.test(sn.id));
    }
  }

  // Data spoke 内のサブネットCIDRが 10.2.x.0/24 のみか軽くチェック
  const dataSpoke = (obj.spokes||[]).find((s:any)=>/data/i.test(s.id));
  if (dataSpoke) {
    dataSpoke.subnets = (dataSpoke.subnets||[]).filter((sn:any)=>{
      const ok = /^10\.2\.\d+\.0\/24$/.test(sn.cidr||"");
      if (!ok) obj.notes.push(`Removed subnet ${sn.id} with out-of-range CIDR from ${dataSpoke.id}`);
      return ok;
    });
  }

  return obj;
}

/** JSON抽出（保険） */
function salvageJson(s: string) {
  const i = s.indexOf("{");
  const j = s.lastIndexOf("}");
  if (i >= 0 && j > i) {
    try { return JSON.parse(s.slice(i, j + 1)); } catch {}
  }
  throw new Error("JSON parse failed");
}

/** 429/一時エラー用: 簡易リトライ（指数バックオフ） */
async function withRetries<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e: any) {
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

// 置き換え: JsonSchemaForModel
const JsonSchemaForModel = {
  name: "ArchModel",
  schema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    properties: {
      region: { type: "string" },
      hub: {
        type: "object",
        required: ["id","cidr","kind","subnets"],
        additionalProperties: false,
        properties: {
          id:   { type: "string" },
          label:{ type: "string" },
          cidr: { type: "string" },
          kind: { const: "hub" },
          subnets: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["id","cidr","purpose"],
              additionalProperties: false,
              properties: {
                id: { type: "string" },
                cidr: { type: "string" },
                purpose: { enum: ["public","app","data","infra"] }
              }
            }
          }
        }
      },
      spokes: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["id","cidr","kind","subnets"],
          additionalProperties: false,
          properties: {
            id:   { type: "string" },
            label:{ type: "string" },
            cidr: { type: "string" },
            kind: { const: "spoke" },
            subnets: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                required: ["id","cidr","purpose"],
                additionalProperties: false,
                properties: {
                  id: { type: "string" },
                  cidr: { type: "string" },
                  purpose: { enum: ["public","app","data","infra"] }
                }
              }
            }
          }
        }
      },

      // ★ resources を型付きユニオンにする
      resources: {
        type: "array",
        minItems: 4, // AppGW, VPN GW, SQL, PE は最低でも欲しい
        items: {
          oneOf: [
            { // Application Gateway (WAF_v2)
              type: "object",
              additionalProperties: false,
              required: ["type","id","spokeId","subnetId","waf","publicIpId"],
              properties: {
                type: { const: "applicationGateway" },
                id: { type: "string" },
                spokeId: { type: "string" },
                subnetId: { type: "string" }, // 例: "AppGatewaySubnet"
                waf: { type: "string", enum: ["WAF_v2"] },
                publicIpId: { type: "string" }
              }
            },
            { // Public IP (for AppGW)
              type: "object",
              additionalProperties: false,
              required: ["type","id","sku"],
              properties: {
                type: { const: "publicIp" },
                id: { type: "string" },
                sku: { type: "string" } // Standard推奨
              }
            },
            { // VPN Gateway (Hub)
              type: "object",
              additionalProperties: false,
              required: ["type","id","hubId","activeActive"],
              properties: {
                type: { const: "vpnGateway" },
                id: { type: "string" },
                hubId: { type: "string" },
                activeActive: { type: "boolean" }
              }
            },
            { // Azure SQL (PaaS)
              type: "object",
              additionalProperties: false,
              required: ["type","id","tier"],
              properties: {
                type: { const: "azureSql" },
                id: { type: "string" },
                tier: { type: "string" } // "GeneralPurpose" 等
              }
            },
            { // Private Endpoint (to SQL)
              type: "object",
              additionalProperties: false,
              required: ["type","id","spokeId","subnetId","targetResourceId"],
              properties: {
                type: { const: "privateEndpoint" },
                id: { type: "string" },
                spokeId: { type: "string" },
                subnetId: { type: "string" },
                targetResourceId: { type: "string" } // azureSql の id を参照
              }
            },
            { // Private DNS Zone for SQL
              type: "object",
              additionalProperties: false,
              required: ["type","id","zone"],
              properties: {
                type: { const: "privateDnsZone" },
                id: { type: "string" },
                zone: { const: "privatelink.database.windows.net" }
              }
            },
            { // App層 (どちらかでOK)
              type: "object",
              additionalProperties: false,
              required: ["type","id","spokeId","sku"],
              properties: {
                type: { const: "appService" },
                id: { type: "string" },
                spokeId: { type: "string" },
                sku: { type: "string" }
              }
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["type","id","spokeId","instanceCount"],
              properties: {
                type: { const: "vmss" },
                id: { type: "string" },
                spokeId: { type: "string" },
                instanceCount: { type: "integer", minimum: 2 }
              }
            }
          ]
        }
      },

      edges: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            from: { type: "string" },
            to:   { type: "string" },
            kind: { enum: ["l3","l7"] }
          }
        }
      },
      notes: { type: "array", items: { type: "string" } }
    },
    required: ["region","hub","spokes","resources","notes"]
  }
} as const;

/** LLMに “JSONのみ” で Azure構成モデルを合成させる */
export async function synthesizeModelFromPrompt(
  prompt: string,
  docs: string[]
): Promise<ArchModel> {
  const sys = `You are an Azure cloud architect.
  Output ONLY a single JSON object that matches the provided schema.
  
  Non-negotiable requirements (apply if compatible with the prompt):
  - Use region "japaneast" when Japan East / 東日本 is mentioned.
  - Use a hub-and-spoke topology with a VPN Gateway in the hub.
  - Put a single Application Gateway (WAF_v2) in exactly one spoke hosting "AppGatewaySubnet".
  - Database is Azure SQL (PaaS) reachable ONLY via Private Endpoint in the data spoke.
  - Include a Private DNS Zone "privatelink.database.windows.net" bound to the PE.
  - Include an app tier (App Service or VMSS>=2) behind the Application Gateway.
  - If unsure about CIDRs, omit them but keep the structure.
  
  IDs must be letters/digits/underscore only. No markdown. JSON only.`;

  const user =
`Requirement (Japanese allowed):
${prompt}

Helpful Microsoft Docs snippets (condensed):
${trimDocs(docs)}

Return ONLY a single JSON object similar to:
{
  "region": "japaneast",
  "hub": { "id":"hub","cidr":"10.0.0.0/16","kind":"hub","subnets":[{"id":"hub_infra","cidr":"10.0.0.0/24","purpose":"infra"}]},
  "spokes": [ { "id":"spoke_web","cidr":"10.1.0.0/16","kind":"spoke",
    "subnets":[{"id":"pub","cidr":"10.1.0.0/24","purpose":"public"},{"id":"app","cidr":"10.1.1.0/24","purpose":"app"},{"id":"data","cidr":"10.1.2.0/24","purpose":"data"}] } ],
  "resources": [],
  "edges": [],
  "notes": []
}
`;

  // 呼び出し（429などは自動リトライ）
  const chat = await withRetries(() =>
    client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      // temperature は指定しない（非対応モデル対策）
      max_tokens: 900,
      response_format: {
        type: "json_schema",
        json_schema: JsonSchemaForModel
      },
      messages: [
        { role: "system", content: sys },
        // ★ few-shot: 良い例（短く）
        { role: "user", content: "要件: 東日本 / Hub-Spoke / VPN / WAF / PaaS DB / Private Endpoint" },
        { role: "assistant", content: JSON.stringify({
            region: "japaneast",
            hub: { id:"hub", cidr:"10.0.0.0/16", kind:"hub", subnets:[{id:"hub_infra", cidr:"10.0.0.0/24", purpose:"infra"}]},
            spokes: [{ id:"spoke_web", cidr:"10.1.0.0/16", kind:"spoke",
              subnets:[{id:"pub",cidr:"10.1.0.0/24",purpose:"public"},{id:"app",cidr:"10.1.1.0/24",purpose:"app"},{id:"AppGatewaySubnet",cidr:"10.1.3.0/24",purpose:"infra"}]
            }],
            resources: [
              {type:"publicIp",id:"pip_agw",sku:"Standard"},
              {type:"applicationGateway",id:"agw",spokeId:"spoke_web",subnetId:"AppGatewaySubnet",waf:"WAF_v2",publicIpId:"pip_agw"},
              {type:"vpnGateway",id:"vpngw",hubId:"hub",activeActive:true},
              {type:"azureSql",id:"sql1",tier:"GeneralPurpose"},
              {type:"privateEndpoint",id:"pe_sql",spokeId:"spoke_web",subnetId:"app",targetResourceId:"sql1"},
              {type:"privateDnsZone",id:"pdns_sql",zone:"privatelink.database.windows.net"},
              {type:"vmss",id:"appvmss",spokeId:"spoke_web",instanceCount:2}
            ],
            edges: [],
            notes: []
          })}
        ,
        { role: "user", content: user }, // ← 本番の user
      ]
    })
  );

  let raw = chat.choices[0]?.message?.content ?? "{}";
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    obj = salvageJson(raw);
  }

  // 念のため edges を掃除（出力されていた場合のみ）
  if (Array.isArray(obj?.edges)) {
    obj.edges = obj.edges.filter(
      (e: any) => e && typeof e.from === "string" && typeof e.to === "string"
    );
  } else {
    obj.edges = [];
  }
  obj = lintAndNudge(obj);
  // Zod で最終検証
  return ModelSchema.parse(obj);
}