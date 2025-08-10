// src/lib/emitMermaid.ts
import type { Model, Resource } from "./types.js";

export type MermaidOptions = {
  legend?: boolean;                     // 凡例表示
  subnetDetail?: "full" | "compact";    // サブネット詳細度
  direction?: "TB" | "LR";              // 図の向き
  showPeerings?: boolean;               // VNet間ピアリングの注記表示
  showIdsInLabels?: boolean;            // ラベルにIDを含める
};

export function emitMermaid(m: Model, opts: MermaidOptions = {}): string {
  const legend = opts.legend ?? false;
  const subnetDetail = opts.subnetDetail ?? "compact";
  const dir = opts.direction ?? "TB";
  const showPeer = opts.showPeerings ?? true;
  const showIds = opts.showIdsInLabels ?? false;

  const L: string[] = [];
  push(`flowchart ${dir}`);
  push(`%% Region: ${m.region}`);

  // Legend
  if (legend) {
    push(`
subgraph legend["Legend"]
  direction LR
  net["Network (VNet/Subnet)"]:::net
  sec["Security (Firewall/WAF/VPN/Bastion)"]:::sec
  appc["App (PaaS)"]:::appc
  data["Data (DB/Storage)"]:::data
  keyv["Key/Secrets"]:::keyv
  pe["Private Endpoint / DNS"]:::pe
end`);
  }

  // On-Prem 必要時のみ
  const hasOnprem = m.edges.some(e => e.from === "onprem" || e.to === "onprem");
  if (hasOnprem) {
    push(`subgraph onp["On-Premises"]`);
    push(`  onprem["On-Premises"]:::net`);
    push(`end`);
  }

  // Hub
  push(`subgraph ${m.hub.id}["${titleVNet(m.hub.label ?? "Hub VNet", m.hub.cidr, showIds ? m.hub.id : undefined)}"]`);
  if (subnetDetail === "full") {
    for (const sn of m.hub.subnets) push(`  ${sn.id}["${titleSubnet(sn)}"]:::net`);
  } else {
    push(`  ${m.hub.subnets[0].id}["Subnets: ${m.hub.subnets.map(s=>s.cidr).join(", ")}"]:::net`);
  }
  push(`end`);

  // Spokes
  for (const sp of m.spokes) {
    push(`subgraph ${sp.id}["${titleVNet(sp.label ?? "Spoke", sp.cidr, showIds ? sp.id : undefined)}"]`);
    if (subnetDetail === "full") {
      for (const sn of sp.subnets) push(`  ${sn.id}["${titleSubnet(sn)}"]:::net`);
    } else {
      push(`  ${sp.subnets[0].id}["Subnets: ${sp.subnets.map(s=>s.cidr).join(", ")}"]:::net`);
    }
    push(`end`);
  }

  // Resources
  for (const r of m.resources) push(resourceNode(r));

  // Edges（L3は破線、L7は太線）
  for (const e of m.edges) {
    const style = e.kind === "l3" ? "-.->" : "==>";
    push(`  ${e.from} ${style} ${e.to}`);
  }

  // Peerings 注記（任意）
  if (showPeer && m.peerings?.length) {
    for (const p of m.peerings) {
      const ann = [
        p.allowGatewayTransit ? "GT" : "",
        p.useRemoteGateways ? "RG" : "",
        p.allowForwardedTraffic ? "FWD" : "",
      ].filter(Boolean).join("/");
      if (ann) push(`  ${p.fromVnetId} --- ${p.toVnetId}:::peerNote`);
      if (ann) push(`  linkStyle ${linkIndex(L)} stroke:#999,stroke-dasharray: 2 2;`);
      if (ann) push(`  click ${p.fromVnetId} "Peering: ${p.fromVnetId}→${p.toVnetId} [${ann}]" _self`);
    }
  }

  // Styles
  push('classDef net fill:#E6F4F1,stroke:#7FB3AE;');
  push('classDef sec fill:#FCE5E1,stroke:#E39A8A;');
  push('classDef appc fill:#EAE7FF,stroke:#A79BEA;');
  push('classDef data fill:#FFF3C4,stroke:#E2C35A;');
  push('classDef keyv fill:#F2F2F2,stroke:#BBBBBB;');
  push('classDef pe fill:#E7F0FF,stroke:#89A6E8;');
  push('classDef peerNote fill:#fff,stroke:#bbb,stroke-dasharray: 2 2;');
  push('classDef note fill:#fff,stroke:#bbb,stroke-dasharray: 3 3;');

  // Notes
  m.notes.forEach((n, i) => {
    const nid = `note${i + 1}`;
    push(`  ${nid}["${escape(n)}"]:::note`);
    if (i === 0 && m.resources.some(x => x.type === "KeyVault")) push(`  kv --- ${nid}`);
  });

  return L.join("\n");

  // --- helpers ---
  function push(s: string) { L.push(s); }
  function escape(s: string) { return s.replace(/"/g, '\\"'); }
  function titleVNet(label: string, cidr: string, id?: string) {
    return `${label} (${cidr})${id ? ` [${id}]` : ""}`;
  }
  function titleSubnet(sn: { purpose: string; cidr: string }) {
    const name = sn.purpose[0].toUpperCase() + sn.purpose.slice(1);
    return `${name} Subnet (${sn.cidr})`;
  }
  function linkIndex(lines: string[]) {
    // 最後に追加した線を狙うための雑な index（Mermaid仕様上 厳密制御は難しいので控えめに）
    return Math.max(0, lines.filter(x => x.includes('---') || x.includes('-->') || x.includes('==>') || x.includes('-.->')).length - 1);
  }
  function resourceNode(r: Resource): string {
    const label = r.label ?? r.type;
    const base = (clazz: string) => `  ${r.id}["${escape(label)}"]:::${clazz}`;
    switch (r.type) {
      case "AzureFirewall":
      case "AppGateway":
      case "VpnGateway":
      case "ExpressRouteGateway":
      case "Bastion":
        return base("sec");
      case "AppService":
        return base("appc");
      case "SqlDb":
      case "Storage":
        return base("data");
      case "KeyVault":
        return base("keyv");
      case "PrivateEndpoint":
      case "PrivateDnsZone":
        return base("pe");
      case "NetworkSecurityGroup":
      case "RouteTable":
      case "PublicIP":
        return base("net");
      default:
        return base("appc");
    }
  }
}