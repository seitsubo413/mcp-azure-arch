import { OpenAI } from "openai";

const schema = {
  name: "AzureArchModel",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      region: { type: "string" },
      hub: { type: "object" },
      spokes: { type: "array", items: { type: "object" } },
      edges: { type: "array", items: { type: "object" } },
      resources: { type: "array", items: { type: "object", additionalProperties: true } },
      notes: { type: "array", items: { type: "string" } }
    },
    required: ["region", "hub", "spokes", "edges", "resources", "notes"]
  }
} as const;

export async function fixModelWithLLM(modelRaw: any, userPrompt: string, hints?: string) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return modelRaw;

  const client = new OpenAI({ apiKey });
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const sys = `You are a STRICT JSON repair tool for Azure architecture models.
Rules:
1. Do not invent resources, IDs, or CIDRs.
2. Keep existing IDs/labels/CIDRs unless they are invalid.
3. Ensure arrays: spokes[], edges[], resources[], notes[].
4. Hub–Spoke: bidirectional peering (Hub→Spoke allowGatewayTransit, Spoke→Hub useRemoteGateways).
5. Only one spoke may have AppGatewaySubnet and App Gateway.
6. Remove CIDRs outside VNet range; do not replace.
7. If ambiguous, keep original and add short note to notes[].`;

  const user = `Prompt:\n${userPrompt}${
    hints ? `\nHints:\n${hints}` : ""
  }\n\nModel:\n${JSON.stringify(modelRaw)}`;

  try {
    const completion = await client.chat.completions.create({
      model,
      max_tokens: 900,
      response_format: {
        type: "json_schema",
        json_schema: schema
      },
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user }
      ],
    });

    const text = completion.choices[0].message?.content;
    return text ? JSON.parse(text) : modelRaw;
  } catch (e) {
    console.warn("fixModelWithLLM error:", e instanceof Error ? e.message : e);
    return modelRaw;
  }
}