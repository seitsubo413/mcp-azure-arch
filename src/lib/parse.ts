// src/lib/parse.ts
export type Flags = {
  region: string;
  vpn?: boolean;
  waf?: boolean;
  firewall?: boolean;
  bastion?: boolean;
  expressRouteReady?: boolean;
  appServiceSku?: string;
  appInstances?: number;
  storageRedundancy?: "LRS" | "ZRS" | "GZRS";
  sqlTier?: "GP" | "BC";
  privateEndpointSql?: boolean;
  privateEndpointStorage?: boolean;
  privateEndpointKeyVault?: boolean;
};

export function parsePrompt(s: string): Flags {
  const t = s.toLowerCase();

  const region =
    /西日本|japan\s*west/.test(s) ? "japanwest" :
    /東日本|japan\s*east/.test(s) ? "japaneast" :
    /japaneast|japan\-?east/.test(t) ? "japaneast" :
    /japanwest|japan\-?west/.test(t) ? "japanwest" : "japaneast";

  const vpn = /(vpn|s2s|site\-to\-site|拠点間)/i.test(s);
  const waf = /(waf|app\s*gateway)/i.test(s);
  const firewall = /(firewall|ファイアウォール|azure\s*firewall)/i.test(s);
  const bastion = /(bastion|踏み台)/i.test(s);
  const er = /(express\s*route|er併用|er\s*gw)/i.test(s) || /将来.*er/i.test(s);

  const peSql = /(private\s*endpoint|pe).*(sql|database)/i.test(t);
  const peSt  = /(private\s*endpoint|pe).*(storage|blob)/i.test(t);
  const peKv  = /(private\s*endpoint|pe).*(key\s*vault|kv)/i.test(t);

  const sku = /p\d(v\d)?/i.exec(s)?.[0]?.toUpperCase();
  const inst = /(\d+)\s*(台|instances?|replicas?)/i.exec(s)?.[1];

  const storageRedundancy: Flags["storageRedundancy"] =
    /gzrs/i.test(s) ? "GZRS" : /zrs/i.test(s) ? "ZRS" : /lrs/i.test(s) ? "LRS" : undefined;

  const sqlTier: Flags["sqlTier"] =
    /(general\s*purpose|gp|汎用)/i.test(s) ? "GP" :
    /(business\s*critical|bc|重要)/i.test(s) ? "BC" : undefined;

  return {
    region,
    vpn,
    waf,
    firewall,
    bastion,
    expressRouteReady: er,
    appServiceSku: sku,
    appInstances: inst ? Number(inst) : undefined,
    storageRedundancy,
    sqlTier,
    privateEndpointSql: peSql,
    privateEndpointStorage: peSt,
    privateEndpointKeyVault: peKv,
  };
}