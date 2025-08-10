// src/lib/synth.ts
import OpenAI from "openai";
import { z } from "zod";

/**
 * Zod schema（MVP版）
 * ※ resources は緩め（any）— 正規化は別レイヤで行う想定
 */
export const ModelSchema = z.object({
  region: z.string(),
  hub: z.object({
    id: z.string(),
    label: z.string().optional(),
    cidr: z.string(),
    kind: z.literal("hub"),
    subnets: z.array(
      z.object({
        id: z.string(),
        cidr: z.string(),
        purpose: z.enum(["public", "app", "data", "infra"]),
      })
    ),
  }),
  spokes: z.array(
    z.object({
      id: z.string(),
      label: z.string().optional(),
      cidr: z.string(),
      kind: z.literal("spoke"),
      subnets: z.array(
        z.object({
          id: z.string(),
          cidr: z.string(),
          purpose: z.enum(["public", "app", "data", "infra"]),
        })
      ),
    })
  ),
  resources: z.array(z.any()),
  edges: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      kind: z.enum(["l3", "l7"]).optional(),
    })
  ).optional().default([]),
  notes: z.array(z.string()),
});
export type ArchModel = z.infer<typeof ModelSchema>;

/** OpenAI クライアント（本家） */
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

/** Docs抜粋は短く圧縮（コスト＆暴走抑制） */
function trimDocs(docs: string[], maxChars = 1000) {
  const joined = docs.slice(0, 3).join("\n\n").replace(/\s+/g, " ").trim();
  return joined.slice(0, maxChars);
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

const schemaHint = `
Return ONLY a single JSON object matching this shape:
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

/**
 * LLMに “JSONのみ” で Azure構成モデルを合成させる
 * - Mermaid/説明文は禁止
 * - 低温度・トークン制限・簡易リトライ付き
 */
export async function synthesizeModelFromPrompt(
  prompt: string,
  docs: string[]
): Promise<ArchModel> {
  const sys = `You are an Azure cloud architect.
  Output ONLY a single JSON object that passes the provided Zod schema.
  Do NOT include markdown, code fences, mermaid, or explanations.
  Every "id" MUST be machine-safe: letters, digits, underscore only.
  If unsure about a field, omit it rather than inventing.
  Do NOT include the "edges" field. It will be inferred later.
  Prefer hub-spoke when mentioned. Use "japaneast" if Japan/East is referenced.`;

  const user =
`Requirement (Japanese allowed):
${prompt}

Helpful Microsoft Docs snippets (condensed):
${trimDocs(docs)}

${schemaHint}
`;

  // 呼び出し（429などは自動リトライ）
  const chat = await withRetries(() =>
    client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 900,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
    })
  );

  let raw = chat.choices[0]?.message?.content ?? "{}";
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    obj = salvageJson(raw);
  }
  
  // ← ここで “念のため” edges を除去/掃除
  if (Array.isArray(obj?.edges)) {
    obj.edges = obj.edges.filter(
      (e: any) => e && typeof e.from === "string" && typeof e.to === "string"
    );
  } else {
    obj.edges = []; // LLMが変な値を入れても潰す
  }
  
  // ここで初めて Zod 検証
  return ModelSchema.parse(obj);
}