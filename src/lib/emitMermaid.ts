// src/lib/emitMermaid.ts
import type { Model, Resource } from "./types.js";

export type MermaidOptions = {
  legend?: boolean;                     // 凡例を出す
  subnetDetail?: "full" | "compact";    // サブネットを詳細表示するか
  direction?: "TB" | "LR";              // 矢印の向き
  showPeerings?: boolean;               // VNet ピアリング注記
  showIdsInLabels?: boolean;            // ラベル末尾に [id] を出す
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

  // Legend（任意）
  if (legend) {
    push(`subgraph legend["Legend"]
  direction LR
  net["Network (VNet/Subnet/PIP/NSG/RouteTable/DNS)"]:::net
  sec["Security (Firewall/WAF/VPN/Bastion)"]:::sec
  appc["App (PaaS)"]:::appc
  data["Data (DB/Storage)"]:::data
  keyv["Key/Secrets"]:::keyv
  pe["Private Endpoint / Private DNS"]:::pe
end`);
  }

  // On-Prem（必要時のみ）
  if (m.edges?.some(e => e.from === "onprem" || e.to === "onprem")) {
    push(`subgraph onp["On-Premises"]
  onprem["On-Premises"]:::net
end`);
  }

  // Hub
  push(
    `subgraph ${safeId(m.hub.id)}["${titleVNet(
      m.hub.label ?? "Hub VNet",
      m.hub.cidr,
      showIds ? m.hub.id : undefined
    )}"]`
  );
  emitSubnets(m.hub.subnets);
  push("end");

  // Spokes
  for (const sp of m.spokes) {
    push(
      `subgraph ${safeId(sp.id)}["${titleVNet(
        sp.label ?? "Spoke",
        sp.cidr,
        showIds ? sp.id : undefined
      )}"]`
    );
    emitSubnets(sp.subnets);
    push("end");
  }

  // Resources（ノード）
  const resources = (m.resources ?? []) as Resource[];
  for (const r of resources) {
    push(resourceNode(r));
  }

  // Edges（L3は破線、L7は太線）
  for (const e of m.edges) {
    const style = e.kind === "l3" ? "-.->" : "==>";
    const from = safeId(e.from);
    const to = safeId(e.to);
    if (!from || !to) continue;
    push(`  ${from} ${style} ${to}`);
  }

  // Peerings（任意）
  if (showPeer && m.peerings?.length) {
    // ざっくり補助線＆注記
    for (const p of m.peerings) {
      const a = safeId(p.fromVnetId);
      const b = safeId(p.toVnetId);
      if (!a || !b) continue;
      const ann = [
        p.allowGatewayTransit ? "GT" : "",
        p.useRemoteGateways ? "RG" : "",
        p.allowForwardedTraffic ? "FWD" : "",
        p.allowVnetAccess ?? true ? "" : "noAccess",
      ]
        .filter(Boolean)
        .join("/");

      push(`  ${a} --- ${b}:::peerNote`);
      // Mermaid は線インデックスを厳密指定しにくいので CSS 的な装飾は控えめに
      if (ann) {
        // クリック注記（単なるラベルの代わり）
        push(`  click ${a} "Peering: ${a}→${b} [${ann}]" _self`);
      }
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

  // Notes（KeyVaultに紐付けるのはやめて、フローティングの注記に）
  m.notes?.forEach((n, i) => {
    const nid = `note${i + 1}`;
    push(`  ${nid}["${escape(n)}"]:::note`);
  });

  return L.join("\n");

  // ===== helpers =====

  function push(s: string) {
    L.push(s);
  }

  function escape(s: string) {
    return String(s).replace(/"/g, '\\"');
  }

  function safeId(s?: string) {
    if (!s) return "";
    return s.replace(/[^\w]/g, "_");
  }

  function titleVNet(label: string, cidr: string, id?: string) {
    return `${label} (${cidr})${id ? ` [${id}]` : ""}`;
  }

  function titleSubnet(sn: { purpose?: string; cidr: string; id?: string }) {
    const name =
      (sn.purpose
        ? sn.purpose[0].toUpperCase() + sn.purpose.slice(1)
        : (sn.id ?? "Subnet")) + " Subnet";
    return `${name} (${sn.cidr})`;
  }

  function emitSubnets(subnets: any[]) {
    if (!subnets?.length) return;
    if (subnetDetail === "full") {
      for (const sn of subnets) {
        push(`  ${safeId(sn.id)}["${titleSubnet(sn)}"]:::net`);
      }
    } else {
      // CIDR をまとめて1行で
      const first = safeId(subnets[0].id || "sn0");
      const list = subnets.map((s) => s.cidr).join(", ");
      push(`  ${first}["Subnets: ${list}"]:::net`);
    }
  }

  function labelOf(r: Resource) {
    // それぞれのタイプでラベルを豊かにする
    switch (r.type) {
      case "AppService": {
        const sku = (r as any).sku ? ` ${(r as any).sku}` : "";
        const inst =
          typeof (r as any).instances === "number"
            ? ` x${(r as any).instances}`
            : "";
        return `App Service${sku}${inst}`;
      }
      case "AppGateway": {
        const waf = (r as any).waf ? " (WAF_v2)" : "";
        return `App Gateway${waf}`;
      }
      case "AzureFirewall":
        return "Azure Firewall";
      case "VpnGateway":
        return "VPN Gateway";
      case "ExpressRouteGateway":
        return "ExpressRoute Gateway";
      case "Bastion":
        return "Azure Bastion";
      case "SqlDb": {
        const tier = (r as any).tier ? ` ${(r as any).tier}` : "";
        const zr = (r as any).zoneRedundant ? " ZR" : "";
        return `Azure SQL DB${tier}${zr}`;
      }
      case "Storage": {
        const red = (r as any).redundancy ? ` ${(r as any).redundancy}` : "";
        return `Storage${red}`;
      }
      case "KeyVault":
        return "Key Vault";
      case "PrivateEndpoint": {
        const t = (r as any).targetResourceType ?? "";
        return `Private Endpoint → ${t}`;
      }
      case "PrivateDnsZone": {
        const z = (r as any).zoneName ?? "Private DNS";
        return `Private DNS: ${z}`;
      }
      case "NetworkSecurityGroup":
        return r.label || "NSG";
      case "RouteTable":
        return r.label || "Route Table";
      case "PublicIP":
        return r.label || "Public IP";
      default: {
        // When the union is fully covered, TS narrows `r` to `never` in `default`.
        // Use `any` to safely fall back.
        const anyR = r as any;
        return anyR?.label ?? String(anyR?.type ?? "Resource");
      }
    }
  }

  function classOf(r: Resource) {
    switch (r.type) {
      case "AppGateway":
      case "AzureFirewall":
      case "VpnGateway":
      case "ExpressRouteGateway":
      case "Bastion":
        return "sec";
      case "AppService":
        return "appc";
      case "SqlDb":
      case "Storage":
        return "data";
      case "KeyVault":
        return "keyv";
      case "PrivateEndpoint":
      case "PrivateDnsZone":
        return "pe";
      case "NetworkSecurityGroup":
      case "RouteTable":
      case "PublicIP":
        return "net";
      default:
        return "appc";
    }
  }

  function resourceNode(r: Resource): string {
    const id = safeId(r.id);
    const label = labelOf(r);
    const clazz = classOf(r);
    return `  ${id}["${escape(label)}"]:::${clazz}`;
  }
}