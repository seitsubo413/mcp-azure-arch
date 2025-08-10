import { z } from "zod";
import { parsePrompt } from "../lib/parse.js";
import { templateWebPaaS } from "../lib/templates.js";
import { emitMermaid } from "../lib/emitMermaid.js";
import type { Model } from "../lib/types.js";

export const designAzureArch = {
  name: "design_azure_architecture",
  description: "自然言語の要件からAzureアーキテクチャ案（Mermaid）を生成する",
  inputSchema: z.object({
    prompt: z.string().min(3).describe("要件（日本語OK）")
  }),
  async execute(input: { prompt: string }) {
    const flags = parsePrompt(input.prompt);
    const model: Model = templateWebPaaS({
      region: flags.region, vpn: flags.vpn, waf: flags.waf
    });
    const mermaid = emitMermaid(model);
    const notes = [
      `Region: ${model.region}`,
      ...(flags.vpn ? ["拠点間VPN前提。ExpressRoute併用時はルーティング要検討"] : []),
      ...model.notes
    ];
    return { mermaid, model, notes };
  }
};