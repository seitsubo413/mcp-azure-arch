// src/lib/synth.ts
import OpenAI from "openai";
import { z } from "zod";

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
  resources: z.array(z.any()), // MVPでは緩め。後で厳密化予定
  edges: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      kind: z.enum(["l3", "l7"]).optional(),
    })
  ),
  notes: z.array(z.string()),
});
export type ArchModel = z.infer<typeof ModelSchema>;

// --- OpenAI（通常）クライアント。必要なのは OPENAI_API_KEY のみ。
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

// Docsの抜粋は詰めて短く（tokens節約）
function trimDocs(docs: string[], maxChars = 1200) {
  const joined = docs.slice(0, 3).join("\n\n").replace(/\s+/g, " ").trim();
  return joined.slice(0, maxChars);
}

const schemaHint = `
Return ONLY a single JSON object matching this shape:
{
  "region": "japaneast",
  "hub": { "id":"hub","cidr":"10.0.0.0/16","kind":"hub","subnets":[{"id":"hub-infra","cidr":"10.0.0.0/24","purpose":"infra"}]},
  "spokes": [ { "id":"spoke-web","cidr":"10.1.0.0/16","kind":"spoke",
    "subnets":[{"id":"pub","cidr":"10.1.0.0/24","purpose":"public"},{"id":"app","cidr":"10.1.1.0/24","purpose":"app"},{"id":"data","cidr":"10.1.2.0/24","purpose":"data"}] } ],
  "resources": [],
  "edges": [],
  "notes": []
}
`;

// 失敗時に括弧抽出で救済
function salvageJson(s: string) {
  const i = s.indexOf("{");
  const j = s.lastIndexOf("}");
  if (i >= 0 && j > i) {
    try {
      return JSON.parse(s.slice(i, j + 1));
    } catch {}
  }
  throw new Error("JSON parse failed");
}

export async function synthesizeModelFromPrompt(
  prompt: string,
  docs: string[]
): Promise<ArchModel> {
  const sys = `You are an Azure cloud architect. Produce an Azure architecture JSON that passes the given Zod schema.
Rules:
- Output ONLY JSON (no markdown, no explanations).
- Use hub-spoke when mentioned. Add App Gateway for WAF. Use "japaneast" when Japan/East is referenced.`;

  const user = `Requirement (JP allowed):
${prompt}

Helpful Microsoft Docs snippets (condensed):
${trimDocs(docs)}

${schemaHint}
`;

  // JSONを強制
  const chat = await client.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    temperature: 0.2,
  });

  let raw = chat.choices[0]?.message?.content ?? "{}";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = salvageJson(raw);
  }

  return ModelSchema.parse(parsed);
}