// src/lib/templates.ts
import type {
  Model, VNet, SubnetPurpose, Resource,
  ResourceAppService, ResourceAppGateway, ResourceAzureFirewall, ResourceBastion,
  ResourceVpnGateway, ResourceExpressRouteGateway, ResourcePublicIP,
  ResourceSqlDb, ResourceStorage, ResourceKeyVault, ResourcePrivateEndpoint,
  ResourcePrivateDnsZone, ResourceRouteTable, ResourceNSG, Peering, Edge,
} from "./types.js";

export type TemplateFlags = {
  region: string;
  cidrHub?: string;
  cidrSpoke?: string;
  // スイッチ
  vpn?: boolean;                  // S2S VPN 有
  expressRouteReady?: boolean;    // 将来 ER 併用を想定（GatewaySubnetを用意）
  firewall?: boolean;             // Azure Firewall 有
  bastion?: boolean;              // Bastion 有
  waf?: boolean;                  // App Gateway (WAF_v2)
  appServiceSku?: string;         // 例: "P1v3"
  appInstances?: number;          // 例: 2
  storageRedundancy?: "LRS" | "ZRS" | "GZRS";
  sqlTier?: "GP" | "BC";
  // Private Endpoint/DNS
  privateEndpointSql?: boolean;
  privateEndpointStorage?: boolean;
  privateEndpointKeyVault?: boolean;
};

export function templateWebPaaS(opts: TemplateFlags): Model {
  const hubId = "hub";
  const spokeId = "spoke-web";

  // ----- VNets / Subnets -----
  const hub: VNet = {
    id: hubId, label: "Hub VNet", kind: "hub",
    cidr: opts.cidrHub ?? "10.0.0.0/16",
    subnets: [
      { id: "hub-infra",           cidr: "10.0.0.0/24", purpose: "infra" },
      { id: "GatewaySubnet",       cidr: "10.0.0.32/27", purpose: "gateway" },   // VPN/ER 共用
      { id: "AzureFirewallSubnet", cidr: "10.0.1.0/26",  purpose: "firewall" },  // Azure Firewall 専用
      { id: "AzureBastionSubnet",  cidr: "10.0.1.64/26", purpose: "bastion" },   // Bastion 専用
    ]
  };

  const spoke: VNet = {
    id: spokeId, label: "Spoke-Web", kind: "spoke",
    cidr: opts.cidrSpoke ?? "10.1.0.0/16",
    subnets: [
      { id: "sn_pub",           cidr: "10.1.0.0/24", purpose: "public" },
      { id: "sn_app",           cidr: "10.1.1.0/24", purpose: "app" },
      { id: "sn_data",          cidr: "10.1.2.0/24", purpose: "data" },
      { id: "AppGatewaySubnet", cidr: "10.1.3.0/24", purpose: "agw" },      // App GW 専用
    ]
  };

  // ----- Resources -----
  const res: Resource[] = [];

  // Public IP（AGW/Firewall/Bastion 用）
  const pipAgw: ResourcePublicIP = { type: "PublicIP", id: "pip-agw", label: "PIP (AppGW)", sku: "Standard", allocation: "Static" };
  const pipAfw: ResourcePublicIP = { type: "PublicIP", id: "pip-afw", label: "PIP (Firewall)", sku: "Standard", allocation: "Static" };
  const pipBas: ResourcePublicIP = { type: "PublicIP", id: "pip-bastion", label: "PIP (Bastion)", sku: "Standard", allocation: "Static" };

  if (opts.waf) res.push(pipAgw);
  if (opts.firewall) res.push(pipAfw);
  if (opts.bastion) res.push(pipBas);

  // Security / NW
  if (opts.firewall) {
    const afw: ResourceAzureFirewall = { type: "AzureFirewall", id: "afw", label: "Azure Firewall", pipId: pipAfw.id };
    res.push(afw);
  }
  if (opts.bastion) {
    const bastion: ResourceBastion = { type: "Bastion", id: "bastion", label: "Azure Bastion", pipId: pipBas.id };
    res.push(bastion);
  }
  if (opts.vpn) {
    const vpngw: ResourceVpnGateway = { type: "VpnGateway", id: "vpngw", label: "VPN Gateway", sku: "VpnGw2AZ", activeActive: true };
    res.push(vpngw);
  }
  if (opts.expressRouteReady) {
    const ergw: ResourceExpressRouteGateway = { type: "ExpressRouteGateway", id: "ergw", label: "ExpressRoute GW", sku: "ErGw2AZ" };
    res.push(ergw);
  }

  // App Gateway (WAF_v2)
  const agw: ResourceAppGateway | undefined = opts.waf ? {
    type: "AppGateway", id: "agw", label: "App Gateway (WAF_v2)", waf: true, zoneRedundant: true, pipId: pipAgw.id
  } : undefined;
  if (agw) res.push(agw);

  // App / Data
  const appsvc: ResourceAppService = {
    type: "AppService", id: "appsvc", label: "App Service",
    sku: opts.appServiceSku ?? "P1v3",
    instances: opts.appInstances ?? 2,
    planName: "asp-spoke-web"
  };
  const sqldb: ResourceSqlDb = { type: "SqlDb", id: "sqldb", label: "Azure SQL DB", tier: opts.sqlTier ?? "BC", zoneRedundant: true, serverName: "sql-spoke-web" };
  const st: ResourceStorage = { type: "Storage", id: "st", label: "Storage", redundancy: opts.storageRedundancy ?? "ZRS" };
  const kv: ResourceKeyVault = { type: "KeyVault", id: "kv", label: "Key Vault", privateEndpoint: true };

  res.push(appsvc, sqldb, st, kv);

  // Private Endpoint / Private DNS（任意）
  const pe: Resource[] = [];
  const privateDns: ResourcePrivateDnsZone[] = [];
  const addPE = (id: string, target: Resource["type"], targetId: string, subnetId = "sn_data") => {
    pe.push({ type: "PrivateEndpoint", id, label: `PE → ${target}`, targetResourceType: target, targetResourceId: targetId, subnetId });
  };
  const dnsAdd = (zoneName: string) => ({ type: "PrivateDnsZone", id: `pdz-${zoneName.replace(/\./g, "-")}`, label: zoneName, zoneName } as ResourcePrivateDnsZone);

  if (opts.privateEndpointSql) {
    addPE("pe-sql", "SqlDb", sqldb.id);
    privateDns.push(dnsAdd("privatelink.database.windows.net"));
  }
  if (opts.privateEndpointStorage) {
    addPE("pe-st", "Storage", st.id);
    privateDns.push(dnsAdd("privatelink.blob.core.windows.net"));
  }
  if (opts.privateEndpointKeyVault) {
    addPE("pe-kv", "KeyVault", kv.id);
    privateDns.push(dnsAdd("privatelink.vaultcore.azure.net"));
  }
  res.push(...pe, ...privateDns);

  // UDR（既定ルート→Firewall）※Firewallある場合だけ Spoke にアタッチする最小例
  if (opts.firewall) {
    const rt: ResourceRouteTable = {
      type: "RouteTable", id: "rt-spoke-default", label: "RT Spoke → FW",
      routes: [{ name: "defaultToFW", addressPrefix: "0.0.0.0/0", nextHopType: "VirtualAppliance", nextHopIpAddress: "10.0.1.4" /* 例：FWのIPを後で調整 */ }]
    };
    res.push(rt);
    // どのサブネットに割り当てるかは描画ヒントとして保持（Bicep側で使ってもOK）
    [ "sn_app", "sn_data" ].forEach(id => {
      const sn = spoke.subnets.find(s => s.id === id);
      if (sn) sn.routeTableId = rt.id;
    });
  }

  // NSG（最小・任意）
  const nsgWeb: ResourceNSG = {
    type: "NetworkSecurityGroup", id: "nsg-app", label: "NSG (App)",
    rules: [{ name: "allow-https-out", priority: 100, direction: "Outbound", access: "Allow", protocol: "*", source: "*", destination: "*", port: "443" }]
  };
  res.push(nsgWeb);
  const appSn = spoke.subnets.find(s => s.id === "sn_app"); if (appSn) appSn.nsgId = nsgWeb.id;

  // ----- Peerings -----
  const peerings: Peering[] = [
    { fromVnetId: hub.id, toVnetId: spoke.id, allowGatewayTransit: true, allowVnetAccess: true, allowForwardedTraffic: true },
    { fromVnetId: spoke.id, toVnetId: hub.id, useRemoteGateways: true, allowVnetAccess: true, allowForwardedTraffic: true },
  ];

  // ----- Edges（視覚化） -----
  const edges: Edge[] = [
    ...(opts.vpn ? [{ from: "onprem", to: "vpngw", kind: "l3" as const }] : []),
    ...(opts.vpn
      ? [{
          from: "vpngw",
          to: (opts.firewall ? "afw" : (agw ? "agw" : "appsvc")),
          kind: "l3" as const,
        }]
      : []),
    ...(opts.firewall
      ? [{
          from: "afw",
          to: (agw ? "agw" : "appsvc"),
          kind: "l3" as const,
        }]
      : []),
    ...(agw ? [{ from: "agw", to: "appsvc", kind: "l7" as const }] : []),
    { from: "appsvc", to: "sqldb", kind: "l7" as const },
    { from: "appsvc", to: "st",    kind: "l7" as const },
    { from: "sqldb",  to: "kv",    kind: "l7" as const },
    { from: "st",     to: "kv",    kind: "l7" as const },
  ];

  const notes: string[] = [
    `Region: ${opts.region}`,
    ...(opts.vpn ? ["S2S VPN 前提（GatewaySubnet使用）。将来ER併用を想定。"] : []),
    ...(opts.firewall ? ["Spoke 既定ルートは Firewall 経由（UDR）。"] : []),
    ...(opts.waf ? ["App Gateway は WAF_v2 / 専用サブネット。"] : []),
    "Private Endpoint はそれぞれ Private DNS 構成が必要（ゾーンリンク注意）。",
  ];

  return {
    region: opts.region,
    hub,
    spokes: [spoke],
    peerings,
    edges,
    resources: res,
    notes,
  };
}