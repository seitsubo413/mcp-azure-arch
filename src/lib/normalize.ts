import type { Model, Resource, Edge } from "./types.js";
import { enforceAzureInvariants } from "./invariants.js";

const idSafe = (s?: string) => (s ?? "").trim().replace(/[^\w]/g, "_");

const ensureIdFactory = () => {
  let auto = 0;
  return (s?: string) => {
    const z = idSafe(s);
    return z && z !== "_" ? z : `n${auto++}`;
  };
};

const normType = (t: string): Resource["type"] => {
  const x = (t || "").toLowerCase();
  if (/(app\s*gateway|waf)/.test(x)) return "AppGateway";
  if (/(azure\s*firewall|firewall)/.test(x)) return "AzureFirewall";
  if (/vpn/.test(x)) return "VpnGateway";
  if (/express.?route/.test(x)) return "ExpressRouteGateway";
  if (/bastion/.test(x)) return "Bastion";
  if (/(app\s*service|web\s*app)/.test(x)) return "AppService";
  if (/(sql|database)/.test(x)) return "SqlDb";                // Database → SqlDb
  if (/cosmos/.test(x)) return "CosmosDb" as any;
  if (/storage/.test(x)) return "Storage";
  if (/(key.?vault|kv)/.test(x)) return "KeyVault";
  if (/traffic.?manager/.test(x)) return "TrafficManager" as any;
  if (/nsg/.test(x)) return "NetworkSecurityGroup";
  if (/route/.test(x)) return "RouteTable";
  if (/private\s*endpoint/.test(x)) return "PrivateEndpoint";
  if (/private\s*dns/.test(x)) return "PrivateDnsZone";
  return "AppService";
};

function autoWireEdges(m: Model) {
    m.edges ||= [];
  
    const byType = (t: string) => m.resources.filter((r: any) => r.type === t);
    const idOf = (t: string) => byType(t)[0]?.id;
  
    const agw = idOf("AppGateway");
    const app = idOf("AppService");
    const sql = idOf("SqlDb");
    const st  = idOf("Storage");
    const afw = idOf("AzureFirewall");
    const vpn = idOf("VpnGateway");
    const kv  = idOf("KeyVault");
    const tm  = idOf("TrafficManager");
    const peList = byType("PrivateEndpoint");
  
    const add = (from?: string, to?: string, kind: "l3" | "l7" = "l7") => {
      if (!from || !to) return;
      if (!m.edges!.some(e => e.from === from && e.to === to)) {
        m.edges!.push({ from, to, kind });
      }
    };
  
    // L7: アプリ層
    add(agw, app, "l7");
    add(app, sql, "l7");
    add(app, st,  "l7");
    add(app, kv,  "l7");     // App → KeyVault
  
    // Private Endpoint の補助線（図示のため）
    peList.forEach((pe: any) => {
      const target = (pe?.targetResourceType || "").toString().toLowerCase();
      const targetId =
        target.includes("sql")     ? sql :
        target.includes("storage") ? st  :
        target.includes("key")     ? kv  : undefined;
      add(pe.id, targetId, "l7");
    });
  
    // Traffic Manager があれば入口として
    if (tm) add(tm, agw || app, "l7");
  
    // L3: ネットワーク経路（ざっくり）
    add(afw, agw || app, "l3");
    if (vpn) {
      add("onprem", vpn, "l3");
      if (afw) add(vpn, afw, "l3");
      add(afw || vpn, agw || app, "l3");
    }
  }

export function normalizeModel(
  m: Model,
  opts?: {
    preferredRegion?: string;
    enforceWaf?: boolean;
    enforceVpn?: boolean;
    enforceFirewall?: boolean;
    enforceBastion?: boolean;
    enforcePE?: { sql?: boolean; storage?: boolean; kv?: boolean };
    // --- DR / multi-region (Option A: approximate) ---
    drRegion?: string;           // e.g. "japanwest"
    trafficManager?: boolean;    // add TM and wire to both regions
  }
): Model {
    const ensureId = ensureIdFactory();

// naive /16 CIDR bump helper: "A.B.0.0/16" -> "A.(B+add).0.0/16"
function bumpCidr16(cidr: string, add = 1): string {
  const m = cidr.match(/^(\d+)\.(\d+)\.\d+\.\d+\/16$/);
  if (!m) return cidr;
  const a = Number(m[1]), b = Math.min(254, Number(m[2]) + add);
  return `${a}.${b}.0.0/16`;
}

function cloneSubnets(subnets: any[], suffix: string) {
    return (subnets || []).map((sn: any) => ({
      ...sn,
      id: `${sn.id || 'sn'}${suffix}`,
      cidr: sn.cidr?.includes('/24')
        ? sn.cidr.replace(
            /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/24$/,
            (_: string, $1: string, $2: string, $3: string) =>
              `${$1}.${Math.min(254, Number($2) + 1)}.${$3}.0/24`
          )
        : sn.cidr
    }));
  }

function cloneVnet(v: any, suffix: string, bump = 1) {
  return {
    ...v,
    id: `${v.id}${suffix}`,
    label: (v.label ? `${v.label}` : v.kind === 'hub' ? 'Hub VNet' : 'Spoke') + ` ${suffix.replace('_','').toUpperCase()}`,
    cidr: bumpCidr16(v.cidr, bump),
    subnets: cloneSubnets(v.subnets, suffix),
  };
}

function cloneResource(r: any, suffix: string, idMap: Record<string,string>) {
  const copy = { ...r, id: `${r.id}${suffix}` };
  if (copy.label) copy.label = `${copy.label} ${suffix.replace('_','').toUpperCase()}`;
  // Private Endpoint: retarget to cloned resource if present
  if (copy.type === 'PrivateEndpoint' && r.targetResourceId) {
    copy.targetResourceId = idMap[r.targetResourceId] || r.targetResourceId;
  }
  return copy;
}

  // --- region ---
  m.region = opts?.preferredRegion ?? m.region ?? "japaneast";
  
    // --- VNet/Subnet ---
    m.hub.id = ensureId(m.hub.id);
    m.hub.subnets?.forEach(sn => (sn.id = ensureId(sn.id)));
    (m.spokes || []).forEach(v => {
      v.id = ensureId(v.id);
      v.subnets?.forEach(sn => (sn.id = ensureId(sn.id)));
    });
  
    // --- Resources: 正規化（型名ゆれ吸収 & ID採番）---
    m.resources ||= [];
    m.resources.forEach((r: any) => {
      r.id = ensureId(r.id);
      r.type = normType(r.type);
    });
  
    // --- 重複整理（type+label が同じものは先勝ち）---
    const seen = new Set<string>();
    m.resources = m.resources.filter((r: any) => {
      const key = `${r.type}::${r.label || ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  
    // --- 便利ヘルパ ---
    const has = (t: Resource["type"]) => m.resources.some((r: any) => r.type === t);
    const idOf = (t: Resource["type"]) => (m.resources.find((r: any) => r.type === t) as any)?.id;
    const addRes = (r: any) => {
      r.id ||= ensureId(r.id);
      m.resources.push(r);
      return r.id as string;
    };
  
    // --- 不足の強制追加（型に沿って完全な形で）---
    // WAFあり → AppGateway 追加（必須: waf）
    if (opts?.enforceWaf && !has("AppGateway")) {
      addRes({
        type: "AppGateway",
        id: "agw",
        label: "App Gateway (WAF_v2)",
        waf: true,
        zoneRedundant: true,
        // pipId: "pip-agw" // 必要なら後で付与
      });
    }
  
    // VPNあり → VpnGateway 追加（必須: sku, activeActive）
    if (opts?.enforceVpn && !has("VpnGateway")) {
      addRes({
        type: "VpnGateway",
        id: "vpngw",
        label: "VPN Gateway",
        sku: "VpnGw2AZ",
        activeActive: true
      });
    }
  
    // Private Endpoint（対象が存在する場合のみ追加）
    const ensurePE = (id: string, targetType: "SqlDb" | "Storage" | "KeyVault") => {
      const targetId = idOf(targetType);
      if (!targetId) return;
      addRes({
        type: "PrivateEndpoint",
        id,
        label: `PE → ${targetType}`,
        targetResourceType: targetType,
        targetResourceId: targetId,
        subnetId: "sn_data"
      });
    };

    if (opts?.enforcePE?.sql && !m.resources.some((r: any) => r.type === "PrivateEndpoint" && /sql/i.test(r.targetResourceType))) {
      ensurePE("pe_sql", "SqlDb");
    }
    if (opts?.enforcePE?.storage && !m.resources.some((r: any) => r.type === "PrivateEndpoint" && /storage/i.test(r.targetResourceType))) {
      ensurePE("pe_st", "Storage");
    }
    if (opts?.enforcePE?.kv && !m.resources.some((r: any) => r.type === "PrivateEndpoint" && /key/i.test(r.targetResourceType))) {
      ensurePE("pe_kv", "KeyVault");
    }

    // --- DR (Option A): approximate second region as cloned VNets/resources ---
    if (opts?.drRegion) {
      // annotate
      m.notes ||= [];
      m.notes.push(`DR across ${m.region} and ${opts.drRegion}.`);

      // clone hub and first spoke as west set
      const suffix = "_west";
      const hubWest = cloneVnet(m.hub, suffix, 2);
      const spokeWest = m.spokes[0] ? cloneVnet(m.spokes[0], suffix, 2) : undefined;

      // append cloned spoke as additional VNet (approximation)
      if (spokeWest) m.spokes.push(spokeWest);

      // build ID map for resource retargeting
      const idMap: Record<string,string> = {};

      // resources to clone on spoke side (app/data/security/pe)
      const typesToClone = new Set([
        "AppGateway","AzureFirewall","AppService","SqlDb","Storage","KeyVault","PrivateEndpoint","NetworkSecurityGroup","RouteTable","PublicIP"
      ]);

      const clonedResources: any[] = [];
      for (const r of m.resources) {
        if (!typesToClone.has((r as any).type)) continue;
        const newId = `${(r as any).id}${suffix}`;
        idMap[(r as any).id] = newId;
        clonedResources.push(cloneResource(r, suffix, idMap));
      }
      m.resources.push(...clonedResources);

      // simple note to indicate west hub (rendered as additional VNet)
      // keep original hub; hubWest is not appended to m.hub (schema has single hub)
      // instead, we add a note so the diagram communicates dual hubs
      m.notes.push(`(approx) Additional hub in ${opts.drRegion} (rendered as extra VNet).`);
    }

    // Traffic Manager: ensure and wire later
    if (opts?.trafficManager && !m.resources.some((r:any) => r.type === 'TrafficManager')) {
      m.resources.push({ type: 'TrafficManager', id: 'tm', label: 'Traffic Manager' } as any);
    }

    // --- edges は LLM由来を捨てて自動配線に寄せる ---
    m.edges = [];
    autoWireEdges(m);

    // Extra wiring for Traffic Manager → AGW (east & west)
    if (opts?.trafficManager) {
      const agwEast = (m.resources.find((r:any) => r.type === 'AppGateway' && !String(r.id).endsWith('_west')) as any)?.id;
      const agwWest = (m.resources.find((r:any) => r.type === 'AppGateway' && String(r.id).endsWith('_west')) as any)?.id;
      const addEdge = (from?: string, to?: string) => {
        if (!from || !to) return;
        if (!m.edges.some(e => e.from === from && e.to === to)) m.edges.push({ from, to, kind: 'l7' });
      };
      addEdge('tm', agwEast);
      addEdge('tm', agwWest);
    }

    // ここでインバリアント適用（不足サブネット・PDZ・UDR・PIP等の追補と警告）
    const res = enforceAzureInvariants(m, {
    waf: opts?.enforceWaf,
    vpn: opts?.enforceVpn,
    firewall: opts?.enforceFirewall,
    bastion: opts?.enforceBastion,
    privateEndpointSql: opts?.enforcePE?.sql,
    privateEndpointStorage: opts?.enforcePE?.storage,
    privateEndpointKeyVault: opts?.enforcePE?.kv,
    });

    // notes に warnings/fixes を追記
    m.notes ||= [];
    res.fixes.forEach(s => m.notes.push(`fix: ${s}`));
    res.warnings.forEach(s => m.notes.push(`warn: ${s}`));
    if (opts?.drRegion) {
      m.notes.push(`Traffic Manager entry configured for failover (if enabled).`);
    }
    return m;
  }