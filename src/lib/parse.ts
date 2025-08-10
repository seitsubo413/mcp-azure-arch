export function parsePrompt(p: string) {
    const s = (p || "").toLowerCase();
    const vpn = /(vpn|site-to-site|拠点)/.test(s);
    const waf = /(waf|app gateway|アプリケーションゲートウェイ)/.test(s) || /(公開|internet)/.test(s);
    const region =
      /(東日本|japaneast)/.test(s) ? "japaneast" :
      /(西日本|japanwest)/.test(s) ? "japanwest" :
      /(southeastasia)/.test(s) ? "southeastasia" :
      "japaneast";
    return { vpn, waf, region };
  }