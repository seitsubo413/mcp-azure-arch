// // src/lib/parse.ts
// export type Flags = {
//   region: string;
//   vpn?: boolean;
//   waf?: boolean;
//   firewall?: boolean;
//   bastion?: boolean;
//   expressRouteReady?: boolean;
//   appServiceSku?: string;
//   appInstances?: number;
//   storageRedundancy?: "LRS" | "ZRS" | "GZRS";
//   sqlTier?: "GP" | "BC";
//   privateEndpointSql?: boolean;
//   privateEndpointStorage?: boolean;
//   privateEndpointKeyVault?: boolean;
// };

// export function parsePrompt(s: string): Flags {
//   const t = s.toLowerCase();

//   const region =
//     /西日本|japan\s*west/.test(s) ? "japanwest" :
//     /東日本|japan\s*east/.test(s) ? "japaneast" :
//     /japaneast|japan\-?east/.test(t) ? "japaneast" :
//     /japanwest|japan\-?west/.test(t) ? "japanwest" : "japaneast";

//   const vpn = /(vpn|s2s|site\-to\-site|拠点間)/i.test(s);
//   const waf = /(waf|app\s*gateway)/i.test(s);
//   const firewall = /(firewall|ファイアウォール|azure\s*firewall)/i.test(s);
//   const bastion = /(bastion|踏み台)/i.test(s);
//   const er = /(express\s*route|er併用|er\s*gw)/i.test(s) || /将来.*er/i.test(s);

//   const peSql = /(private\s*endpoint|pe).*(sql|database)/i.test(t);
//   const peSt  = /(private\s*endpoint|pe).*(storage|blob)/i.test(t);
//   const peKv  = /(private\s*endpoint|pe).*(key\s*vault|kv)/i.test(t);

//   const sku = /p\d(v\d)?/i.exec(s)?.[0]?.toUpperCase();
//   const inst = /(\d+)\s*(台|instances?|replicas?)/i.exec(s)?.[1];

//   const storageRedundancy: Flags["storageRedundancy"] =
//     /gzrs/i.test(s) ? "GZRS" : /zrs/i.test(s) ? "ZRS" : /lrs/i.test(s) ? "LRS" : undefined;

//   const sqlTier: Flags["sqlTier"] =
//     /(general\s*purpose|gp|汎用)/i.test(s) ? "GP" :
//     /(business\s*critical|bc|重要)/i.test(s) ? "BC" : undefined;

//   return {
//     region,
//     vpn,
//     waf,
//     firewall,
//     bastion,
//     expressRouteReady: er,
//     appServiceSku: sku,
//     appInstances: inst ? Number(inst) : undefined,
//     storageRedundancy,
//     sqlTier,
//     privateEndpointSql: peSql,
//     privateEndpointStorage: peSt,
//     privateEndpointKeyVault: peKv,
//   };
// }
// src/lib/parse.ts
export type Flags = {
  // 基本
  region: string;                     // 基本リージョン（既定は japaneast）
  drRegion?: string;                  // DR 用の第二リージョン（例: japanwest）
  trafficManager?: boolean;           // TM を使うフェイルオーバー意図

  // ネットワーク/セキュリティ
  vpn?: boolean;
  waf?: boolean;
  firewall?: boolean;
  bastion?: boolean;
  expressRouteReady?: boolean;

  // アプリ/データ要件
  appServiceSku?: string;
  appInstances?: number;
  storageRedundancy?: "LRS" | "ZRS" | "GZRS";
  sqlTier?: "GP" | "BC";

  // プライベート接続
  privateEndpointSql?: boolean;
  privateEndpointStorage?: boolean;
  privateEndpointKeyVault?: boolean;
};

// --- helpers ---
function normRegion(raw?: string): string | undefined {
  if (!raw) return undefined;
  const t = raw.toLowerCase().replace(/\s+/g, "");
  if (/(^|[^a-z])japaneast([^a-z]|$)|japan\-?east|東日本|eastjapan/.test(t)) return "japaneast";
  if (/(^|[^a-z])japanwest([^a-z]|$)|japan\-?west|西日本|westjapan/.test(t)) return "japanwest";
  return undefined;
}

export function parsePrompt(s: string): Flags {
  const t = s.toLowerCase();

  // --- region / drRegion 推定 ---
  // 明示形式: "region: japanwest" などを先に拾う
  const regionExplicit = /region\s*[:=]\s*([A-Za-z\- ]+)/i.exec(s)?.[1];
  let regionFromExplicit = normRegion(regionExplicit);

  const mentionsEast = /(東日本|japan\s*east|japaneast)/i.test(s);
  const mentionsWest = /(西日本|japan\s*west|japanwest)/i.test(s);

  // 片方/両方の言及から region/drRegion を推定
  let region = regionFromExplicit
    ?? (mentionsEast && !mentionsWest ? "japaneast"
    :  mentionsWest && !mentionsEast ? "japanwest"
    :  "japaneast"); // 既定
  let drRegion: string | undefined =
    mentionsEast && mentionsWest
      ? (region === "japaneast" ? "japanwest" : "japaneast")
      : undefined;

  // 「東西ペア/DR/二地域」などの表現に反応して、片方しか明示されない場合も DR を補完
  const asksDR = /(disaster\s*recovery|dr|二地域|dual|ペア|冗長.*地域|東西|east.*west|west.*east)/i.test(s);
  if (asksDR && !drRegion) {
    drRegion = region === "japaneast" ? "japanwest" : "japaneast";
  }

  // --- ネットワーク/セキュリティ ---
  const vpn = /(vpn|s2s|site\-to\-site|拠点間)/i.test(s);
  const waf = /(waf|app\s*gateway)/i.test(s);
  const firewall = /(firewall|ファイアウォール|azure\s*firewall)/i.test(s);
  const bastion = /(bastion|踏み台)/i.test(s);
  const er =
    /(express\s*route|er併用|er\s*gw)/i.test(s) ||
    /将来.*express\s*route|将来.*er/i.test(s);

  // --- Private Endpoint ---
  const peSql = /(private\s*endpoint|pe).*(sql|database)/i.test(t);
  const peSt  = /(private\s*endpoint|pe).*(storage|blob)/i.test(t);
  const peKv  = /(private\s*endpoint|pe).*(key\s*vault|kv)/i.test(t);

  // --- App Service SKU / 台数 ---
  const sku = /p\d(?:v\d)?/i.exec(s)?.[0]?.toUpperCase();
  //   「×2」「x2」「*2」や「2台」「2 instances」など
  const instMatch = /(?:×|x|\*)\s*(\d+)|\b(\d+)\s*(台|instances?|replicas?)\b/i.exec(s);
  const instNum = instMatch ? Number(instMatch[1] || instMatch[2]) : undefined;

  // --- Storage 冗長化 / SQL Tier ---
  const storageRedundancy: Flags["storageRedundancy"] =
    /gzrs/i.test(s) ? "GZRS" :
    /zrs/i.test(s)  ? "ZRS"  :
    /lrs/i.test(s)  ? "LRS"  : undefined;

  const sqlTier: Flags["sqlTier"] =
    /(general\s*purpose|gp|汎用)/i.test(s)      ? "GP" :
    /(business\s*critical|bc|重要)/i.test(s)    ? "BC" : undefined;

  // --- Traffic Manager ---
  // 明示 or DR＋フェイルオーバーの記述で true
  const trafficManager =
    /(traffic\s*manager|\btm\b)/i.test(s) ||
    (asksDR && /(フェイルオーバー|fail\s*over|切り替え)/i.test(s));

  return {
    region,
    drRegion,
    trafficManager,
    vpn,
    waf,
    firewall,
    bastion,
    expressRouteReady: er,
    appServiceSku: sku,
    appInstances: instNum,
    storageRedundancy,
    sqlTier,
    privateEndpointSql: peSql,
    privateEndpointStorage: peSt,
    privateEndpointKeyVault: peKv,
  };
}