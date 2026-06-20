import {
  LayoutDashboard,
  Server,
  FolderTree,
  Globe,
  Boxes,
  Activity,
  ShieldCheck,
  ClipboardList,
  SquareTerminal,
  ScrollText,
  Shield,
  Network,
  Globe2,
  Route,
  RefreshCw,
  Cable,
  Spline,
  DoorOpen,
  Users,
  ServerCog,
  Link,
  Gauge,
  Blocks,
  Cpu,
  Database,
  FolderOpen,
  FileText,
  Bell,
  DownloadCloud,
  KeyRound,
  Fingerprint,
  Ticket,
  Palette,
  Info,
} from "lucide-vue-next";

/** A single navigable destination in the sidebar. */
export type NavItem = {
  name: string;
  title: string;
  path: string;
  icon: any;
  scopes?: string[];
};

/** A labelled group of nav items. */
export type NavSection = {
  id: string;
  title: string;
  items: NavItem[];
};

/**
 * Information architecture for the dashboard. `scopes` is the LEAST privilege
 * that should reveal an item; an empty array (or omitted) means always visible.
 */
export const NAV: NavSection[] = [
  {
    id: "overview",
    title: "Overview",
    items: [
      { name: "overview", title: "Overview", path: "/", icon: LayoutDashboard, scopes: [] },
    ],
  },
  {
    id: "fleet",
    title: "Fleet",
    items: [
      { name: "nodes", title: "Nodes", path: "/nodes", icon: Server, scopes: ["node:read"] },
      { name: "groups", title: "Groups", path: "/groups", icon: FolderTree, scopes: ["group:read"] },
      { name: "map", title: "Map", path: "/map", icon: Globe, scopes: ["node:read"] },
      { name: "inventory", title: "Inventory", path: "/inventory", icon: Boxes, scopes: ["inventory:read"] },
      { name: "monitoring", title: "Monitoring", path: "/monitoring", icon: Activity, scopes: ["monitor:read"] },
    ],
  },
  {
    id: "operations",
    title: "Operations",
    items: [
      { name: "approvals", title: "Approvals", path: "/approvals", icon: ShieldCheck, scopes: ["network:plan"] },
      { name: "tasks", title: "Tasks", path: "/tasks", icon: ClipboardList, scopes: ["task:read"] },
      { name: "terminal", title: "Terminal", path: "/terminal", icon: SquareTerminal, scopes: ["terminal:open"] },
      { name: "audit", title: "Audit", path: "/audit", icon: ScrollText, scopes: ["audit:read"] },
    ],
  },
  {
    id: "networking",
    title: "Networking",
    items: [
      { name: "network-guard", title: "Network Guard", path: "/network/guard", icon: Shield, scopes: ["network:plan"] },
      { name: "network-policy", title: "Network Policy", path: "/network/policy", icon: Network, scopes: ["netpolicy:read"] },
      { name: "network-dns", title: "Self-host DNS", path: "/network/dns", icon: Globe2, scopes: ["dns:admin"] },
      { name: "network-geo-routing", title: "Geo-Routing", path: "/network/geo-routing", icon: Route, scopes: ["geo:read"] },
      { name: "network-ddns", title: "DDNS", path: "/network/ddns", icon: RefreshCw, scopes: ["ddns:admin"] },
      { name: "network-tunnels", title: "Tunnels", path: "/network/tunnels", icon: Cable, scopes: ["tunnel:admin"] },
      { name: "network-wireguard", title: "WireGuard", path: "/network/wireguard", icon: Spline, scopes: ["network:plan"] },
    ],
  },
  {
    id: "proxy",
    title: "Proxy",
    items: [
      { name: "proxy-inbounds", title: "Inbounds", path: "/proxy/inbounds", icon: DoorOpen, scopes: ["proxy:read"] },
      { name: "proxy-users", title: "Users", path: "/proxy/users", icon: Users, scopes: ["proxy:read"] },
      { name: "proxy-profiles", title: "Node Profiles", path: "/proxy/profiles", icon: ServerCog, scopes: ["proxy:read"] },
      { name: "proxy-subscriptions", title: "Subscriptions", path: "/proxy/subscriptions", icon: Link, scopes: ["proxy:read"] },
      { name: "proxy-usage", title: "Usage", path: "/proxy/usage", icon: Gauge, scopes: ["proxy:read"] },
    ],
  },
  {
    id: "platform",
    title: "Platform",
    items: [
      { name: "platform-plugins", title: "Plugins", path: "/platform/plugins", icon: Blocks, scopes: ["audit:read"] },
      { name: "platform-workers", title: "Workers", path: "/platform/workers", icon: Cpu, scopes: ["worker:deploy"] },
      { name: "platform-kv", title: "KV Store", path: "/platform/kv", icon: Database, scopes: ["kv:read"] },
      { name: "platform-static", title: "Static", path: "/platform/static", icon: FolderOpen, scopes: ["static:read"] },
      { name: "platform-logs", title: "Logs", path: "/platform/logs", icon: FileText, scopes: ["log:read"] },
      { name: "platform-notifications", title: "Notifications", path: "/platform/notifications", icon: Bell, scopes: ["notify:send"] },
      { name: "platform-agent-updates", title: "Agent Updates", path: "/platform/agent-updates", icon: DownloadCloud, scopes: ["node:admin"] },
    ],
  },
  {
    id: "settings",
    title: "Settings",
    items: [
      { name: "settings-security", title: "Security & 2FA", path: "/settings/security", icon: KeyRound, scopes: [] },
      { name: "settings-sso", title: "Single Sign-On", path: "/settings/sso", icon: Fingerprint, scopes: ["oidc:admin"] },
      { name: "settings-tokens", title: "Access Tokens", path: "/settings/tokens", icon: Ticket, scopes: ["token:admin"] },
      { name: "settings-appearance", title: "Appearance", path: "/settings/appearance", icon: Palette, scopes: [] },
      { name: "settings-about", title: "About", path: "/settings/about", icon: Info, scopes: [] },
    ],
  },
];
