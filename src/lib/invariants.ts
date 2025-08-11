// src/lib/invariants.ts
import type { Model, VNet, Resource } from "./types.js";

export type InvariantResult = { warnings: string[]; fixes: string[] };

export function enforceAzureInvariants(m: Model, flags: {
  waf?: boolean;
  vpn?: boolean;
  firewall?: boolean;
  bastion?: boolean;
  privateEndpointSql?: boolean;
  privateEndpointStorage?: boolean;
  privateEndpointKeyVault?: boolean;
}) : InvariantResult {
  const warns: string[] = [];
  const fixes: string[] = [];

  const hubs: VNet[] = ((m as any).hubs && (m as any).hubs.length ? (m as any).hubs : [m.hub]).filter(Boolean);
  const ensureSubnet = (name: string, cidr: string) => {
    for (const hb of hubs) {
      if (!hb.subnets.some(s => s.id === name)) {
        hb.subnets.push({ id: name, cidr, purpose: inferPurpose(name) });
        fixes.push(`added subnet ${name} in hub ${hb.id} (${cidr})`);
      }
    }
  };
  const inferPurpose = (id: string): "public" | "app" | "data" | "infra" => {
    if (id === "AppGatewaySubnet") return "public";
    // GatewaySubnet / AzureFirewallSubnet / AzureBastionSubnet は infra に寄せる
    return "infra";
  };

  const has = (t: Resource["type"]) => m.resources.some(r => (r as any).type === t);
  const idOf = (t: Resource["type"]) => (m.resources.find(r => (r as any).type === t) as any)?.id;
  const add = (r: any) => { m.resources.push(r); fixes.push(`added resource ${r.type}(${r.id})`); return r.id; };

  // VPN
  if (flags.vpn) {
    ensureSubnet("GatewaySubnet", "10.0.0.32/27");
    if (!has("VpnGateway")) warns.push("VPN requested but VpnGateway missing (auto-added)");
  }

  // Firewall
  if (flags.firewall) {
    ensureSubnet("AzureFirewallSubnet", "10.0.1.0/26");
    if (!has("AzureFirewall")) warns.push("Firewall requested but AzureFirewall missing (consider adding PIP and UDR)");
  }

  // Bastion
  if (flags.bastion) {
    ensureSubnet("AzureBastionSubnet", "10.0.1.64/26");
    if (!has("Bastion")) warns.push("Bastion requested but resource missing");
  }

  // WAF / App Gateway
  if (flags.waf) {
    // 各 Spoke に AppGatewaySubnet を用意（CIDR は仮置き。必要に応じて見直し）
    for (const sp of m.spokes || []) {
      if (!sp.subnets.some(s => s.id === "AppGatewaySubnet")) {
        sp.subnets.push({ id: "AppGatewaySubnet", cidr: "10.1.3.0/24", purpose: "public" as any });
        fixes.push(`added AppGatewaySubnet in spoke ${sp.id} (10.1.3.0/24)`);
        warns.push(`AppGatewaySubnet in ${sp.id} uses default CIDR (10.1.3.0/24) — review`);
      }
    }
    if (!has("AppGateway")) warns.push("WAF requested but AppGateway missing (auto-added)");
  }

  // Private Endpoints → Private DNS zones 注記
  const needsPDZ =
    (!!flags.privateEndpointSql) ||
    (!!flags.privateEndpointStorage) ||
    (!!flags.privateEndpointKeyVault);
  if (needsPDZ) {
    const zonesNeeded = [
      flags.privateEndpointSql && "privatelink.database.windows.net",
      flags.privateEndpointStorage && "privatelink.blob.core.windows.net",
      flags.privateEndpointKeyVault && "privatelink.vaultcore.azure.net",
    ].filter(Boolean) as string[];

    zonesNeeded.forEach(z => {
      if (!m.resources.some(r => (r as any).type === "PrivateDnsZone" && (r as any).zoneName === z)) {
        m.resources.push({ type: "PrivateDnsZone", id: `pdz-${z.replace(/\./g,"-")}`, label: z, zoneName: z } as any);
        fixes.push(`added PrivateDnsZone ${z}`);
      }
    });
    warns.push("Private Endpoint uses require Private DNS zones and zone links to VNets.");
  }

  // UDR（Firewallがあるなら各 Spoke の app/data に既定ルート→FW）
  if (flags.firewall) {
    for (const sp of m.spokes || []) {
      const rtId = `rt-${sp.id}-default`;
      if (!m.resources.some(r => (r as any).type === "RouteTable" && r.id === rtId)) {
        m.resources.push({
          type: "RouteTable", id: rtId, label: `RT ${sp.id} → FW`,
          routes: [{ name: "defaultToFW", addressPrefix: "0.0.0.0/0", nextHopType: "VirtualAppliance", nextHopIpAddress: "10.0.1.4" }]
        } as any);
        fixes.push(`added RouteTable for ${sp.id} default route to Firewall`);
        warns.push(`nextHopIpAddress for ${rtId} is default (10.0.1.4) — review`);
      }
      sp.subnets.forEach(sn => {
        if (sn.id === "sn_app" || sn.id === "sn_data") (sn as any).routeTableId = rtId;
      });
    }
  }

  // Public IP (AGW)
  if (has("AppGateway") && !m.resources.some(r => (r as any).type === "PublicIP" && /agw/i.test((r as any).label || (r as any).id))) {
    m.resources.push({ type: "PublicIP", id: "pip-agw", label: "PIP (AppGW)", sku: "Standard", allocation: "Static" } as any);
    fixes.push("added PublicIP for App Gateway");
  }
  // invariants.ts の最後あたり
  if (needsPDZ) {
    warns.push("Private Endpoint を使う場合、Private DNS ゾーンとVNetリンク構成が必要。");
  }

  return { warnings: warns, fixes };
}