// src/lib/types.ts
export type NodeBase = {
  id: string;
  label?: string;
  notes?: string[];
};

// ===== Network =====
export type SubnetPurpose = "public" | "app" | "data" | "infra" | "gateway" | "bastion" | "agw" | "firewall";

export type Subnet = NodeBase & {
  cidr: string;
  purpose: SubnetPurpose;
  // 関連付け（任意）
  nsgId?: string;
  routeTableId?: string;
};

export type VNet = NodeBase & {
  cidr: string;
  kind: "hub" | "spoke";
  subnets: Subnet[];
};

// ピアリング設定（ゲートウェイ伝搬など）
export type Peering = {
  fromVnetId: string; // VNet.id
  toVnetId: string;   // VNet.id
  allowVnetAccess?: boolean;
  allowForwardedTraffic?: boolean;
  allowGatewayTransit?: boolean;
  useRemoteGateways?: boolean;
};

// ===== Security / Network resources =====
export type NsgRule = {
  name: string;
  priority: number;
  direction: "Inbound" | "Outbound";
  access: "Allow" | "Deny";
  protocol: "*" | "Tcp" | "Udp";
  source: string;      // CIDR or tag
  destination: string; // CIDR or tag
  port?: string;       // "80", "443", "8080-8090", "*"
};

export type ResourceNSG = NodeBase & {
  type: "NetworkSecurityGroup";
  rules?: NsgRule[];
};

export type ResourceRouteTable = NodeBase & {
  type: "RouteTable";
  routes: Array<{
    name: string;
    addressPrefix: string;  // CIDR
    nextHopType: "Internet" | "VirtualAppliance" | "VirtualNetworkGateway" | "VnetLocal" | "None";
    nextHopIpAddress?: string; // Firewallなど
  }>;
};

export type ResourcePublicIP = NodeBase & {
  type: "PublicIP";
  sku?: "Basic" | "Standard";
  allocation?: "Static" | "Dynamic";
};

export type ResourceAzureFirewall = NodeBase & {
  type: "AzureFirewall";
  policyId?: string;    // 省略可（Firewall Policy別リソースを作るなら）
  pipId?: string;       // PublicIP を別定義した場合に関連付け
};

export type ResourceBastion = NodeBase & {
  type: "Bastion";
  pipId?: string;
};

export type ResourceVpnGateway = NodeBase & {
  type: "VpnGateway";
  sku?: "VpnGw1" | "VpnGw2" | "VpnGw3" | "VpnGw1AZ" | "VpnGw2AZ" | "VpnGw3AZ";
  activeActive?: boolean;
};

export type ResourceExpressRouteGateway = NodeBase & {
  type: "ExpressRouteGateway";
  sku?: "ErGw1AZ" | "ErGw2AZ" | "ErGw3AZ";
};

export type ResourceAppGateway = NodeBase & {
  type: "AppGateway";
  waf: boolean;
  zoneRedundant?: boolean;
  pipId?: string; // Public IP を外だし管理する場合の参照
};

// ===== PaaS / Data =====
export type ResourceAppService = NodeBase & {
  type: "AppService";
  sku: string;         // 例: "P1v3"
  instances: number;
  planName?: string;   // serverfarm名（Bicep生成時に使うなら）
};

export type ResourceSqlDb = NodeBase & {
  type: "SqlDb";
  tier: "GP" | "BC";
  zoneRedundant?: boolean;
  serverName?: string; // 同一テンプレ内で固定なら省略可
};

export type ResourceStorage = NodeBase & {
  type: "Storage";
  redundancy: "LRS" | "ZRS" | "GZRS";
};

export type ResourceKeyVault = NodeBase & {
  type: "KeyVault";
  privateEndpoint?: boolean;
};

// ===== Private Endpoint / Private DNS =====
export type ResourcePrivateEndpoint = NodeBase & {
  type: "PrivateEndpoint";
  targetResourceType: "SqlDb" | "Storage" | "KeyVault" | "AppService" | string; // 拡張可
  targetResourceId: string; // 上記リソースの id
  subnetId?: string;        // どのサブネットに置くか
};

export type ResourcePrivateDnsZone = NodeBase & {
  type: "PrivateDnsZone";
  zoneName: string;           // 例: "privatelink.database.windows.net"
  links?: { vnetId: string }[];
};

// ===== 既存リソース型の後方互換 Union =====
export type Resource =
  | ResourceAppGateway
  | ResourceAppService
  | ResourceAzureFirewall
  | ResourceVpnGateway
  | ResourceExpressRouteGateway
  | ResourceSqlDb
  | ResourceStorage
  | ResourceKeyVault
  | ResourceBastion
  | ResourcePublicIP
  | ResourceRouteTable
  | ResourceNSG
  | ResourcePrivateEndpoint
  | ResourcePrivateDnsZone;

// ===== Graph edge（視覚化用ヒント） =====
export type Edge = {
  from: string;
  to: string;
  kind?: "l3" | "l7";
  viaSubnetId?: string; // どのサブネット経由か（描画ヒント）
};

// ===== 全体モデル =====
export type Model = {
  region: string;
  // --- New (multi-hub / aggregate) ---
  /** 複数 Hub を許可。従来の `hub` があれば normalize 側で吸い上げる想定 */
  hubs?: VNet[]; 
  /** kind ベースで集約したい場合の全VNet配列（hub/spoke混在可）。任意 */
  vnets?: VNet[];

  // --- Backward compatibility ---
  /** 既存テンプレの単一 Hub。将来的に非推奨予定だが当面は必須互換 */
  hub: VNet;
  /** 既存テンプレの Spoke 群。将来的に `vnets` へ統合予定 */
  spokes: VNet[];

  // VNet間ピアリング（片方向ずつ定義）
  peerings?: Peering[];
  // 視覚化用
  edges: Edge[];
  // すべてのリソース
  resources: Resource[];
  // 設計上の注意メモ
  notes: string[];
};