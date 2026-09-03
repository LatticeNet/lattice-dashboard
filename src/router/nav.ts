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
  Network,
  Globe2,
  Route,
  RefreshCw,
  Cable,
  Link2,
  Blocks,
  Database,
  Waypoints,
  Bell,
  KeyRound,
  Fingerprint,
  Ticket,
  Palette,
  Info,
  UserCog,
  SlidersHorizontal,
  CircleArrowUp,
  Webhook,
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
  /**
   * Rail icon. The collapsed sidebar shows one control per section rather than
   * a flat wall of every destination, so each section needs a mark an operator
   * can aim at.
   */
  icon: any;
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
    icon: LayoutDashboard,
    items: [
      { name: "overview", title: "Overview", path: "/", icon: LayoutDashboard, scopes: [] },
    ],
  },
  {
    id: "fleet",
    title: "Fleet",
    icon: Server,
    items: [
      { name: "nodes", title: "Nodes", path: "/nodes", icon: Server, scopes: ["node:read"] },
      { name: "groups", title: "Groups", path: "/groups", icon: FolderTree, scopes: ["group:read"] },
      { name: "map", title: "Map", path: "/map", icon: Globe, scopes: ["node:read"] },
      { name: "inventory", title: "Inventory", path: "/inventory", icon: Boxes, scopes: ["inventory:read"] },
      { name: "monitoring", title: "Monitoring", path: "/monitoring", icon: Activity, scopes: ["monitor:read", "monitor:admin"] },
    ],
  },
  {
    id: "operations",
    title: "Operations",
    icon: ClipboardList,
    items: [
      {
        name: "approvals",
        title: "Approvals",
        path: "/approvals",
        icon: ShieldCheck,
        scopes: ["network:plan", "netpolicy:admin", "node:admin", "dns:admin", "proxy:read", "tunnel:admin"],
      },
      { name: "tasks", title: "Tasks", path: "/tasks", icon: ClipboardList, scopes: ["task:read"] },
      { name: "terminal", title: "Terminal", path: "/terminal", icon: SquareTerminal, scopes: ["terminal:open"] },
      { name: "audit", title: "Audit", path: "/audit", icon: ScrollText, scopes: ["audit:read"] },
    ],
  },
  {
    id: "networking",
    title: "Networking",
    icon: Network,
    items: [
      { name: "network-policy", title: "Network Policy", path: "/network/policy", icon: Network, scopes: ["netpolicy:read"] },
      { name: "network-dns", title: "Self-host DNS", path: "/network/dns", icon: Globe2, scopes: ["dns:admin"] },
      { name: "network-geo-routing", title: "Geo-Routing", path: "/network/geo-routing", icon: Route, scopes: ["geo:read", "geo:admin"] },
      { name: "network-ddns", title: "DDNS", path: "/network/ddns", icon: RefreshCw, scopes: ["ddns:admin"] },
      { name: "network-tunnels", title: "Tunnels", path: "/network/tunnels", icon: Cable, scopes: ["tunnel:admin"] },
      // Shrinking SSH exposure is a two-approval flow, so the page needs the
      // plan scope as well as the capability's own.
      { name: "network-ssh-guard", title: "SSH Guard", path: "/network/ssh-guard", icon: ShieldCheck, scopes: ["sshguard:admin"] },
      // Shares are the public subscription URLs. proxy:admin is what the
      // server requires on /api/subscription-shares.
      { name: "network-subscription-shares", title: "Subscription Shares", path: "/network/subscription-shares", icon: Link2, scopes: ["proxy:admin"] },
    ],
  },
  {
    id: "platform",
    title: "Platform",
    icon: Blocks,
    items: [
      { name: "platform-plugins", title: "Plugins", path: "/platform/plugins", icon: Blocks, scopes: ["audit:read", "plugin:admin", "plugin:verify"] },
      // One page owns what URL content is visible at and who may read it, for
      // every origin. Each origin still enforces its own admin scope, so this
      // entry lists all of them rather than inventing a publishing scope.
      { name: "platform-publishing", title: "Publishing", path: "/platform/publishing", icon: Globe, scopes: ["kv:read", "static:read", "proxy:admin"] },
      // KV and Static are one kind-parameterised store on the server: one
      // bucket record, one binding, one access-token type, one handler set
      // under /api/storage. The console split was cosmetic, so one entry owns
      // both with the kind in the URL, the way Evidence owns two lenses. Each
      // kind still enforces its own scope, so this lists all four rather than
      // inventing a storage scope. The old paths redirect with their query.
      { name: "platform-store", title: "Store", path: "/platform/store", icon: Database, scopes: ["kv:read", "kv:write", "static:read", "static:write"] },
      // Logs and the connection trace are one evidence surface at two levels
      // of structure: the raw sing-box line tail per source, and the
      // connection records assembled from the same store. One entry, two
      // lenses; the old paths redirect with their query intact.
      { name: "platform-evidence", title: "Evidence", path: "/platform/evidence", icon: Waypoints, scopes: ["log:read", "log:admin"] },
      { name: "platform-notifications", title: "Notifications", path: "/platform/notifications", icon: Bell, scopes: ["notify:send"] },
      // Inbound webhooks are a source of notification events, not a second
      // delivery path, so they sit next to Notifications and share its scope:
      // an operator who can already route any event to any channel does not
      // need a second grant to author a source for one.
      { name: "platform-webhooks", title: "Webhooks", path: "/platform/webhooks", icon: Webhook, scopes: ["notify:send"] },
      // The route and the view have existed since agent rollouts shipped; the
      // nav entry did not, and NAV is what builds the route table, so the whole
      // surface was unreachable in a running console.
      { name: "platform-agent-updates", title: "Agent Updates", path: "/platform/agent-updates", icon: CircleArrowUp, scopes: ["node:admin"] },
    ],
  },
  {
    id: "settings",
    title: "Settings",
    icon: SlidersHorizontal,
    items: [
      { name: "settings-security", title: "Security & 2FA", path: "/settings/security", icon: KeyRound, scopes: [] },
      // Fleet policy: which capabilities may act on nodes at all. node:read to
      // look, node:admin to change, so the entry appears for anyone who can see
      // the fleet and the page itself gates the switches.
      { name: "settings-capabilities", title: "Capability Gates", path: "/settings/capabilities", icon: ShieldCheck, scopes: ["node:read"] },
      { name: "settings-sso", title: "Single Sign-On", path: "/settings/sso", icon: Fingerprint, scopes: ["oidc:admin"] },
      { name: "settings-users", title: "Users", path: "/settings/users", icon: UserCog, scopes: ["user:admin"] },
      { name: "settings-tokens", title: "Access Tokens", path: "/settings/tokens", icon: Ticket, scopes: ["token:admin"] },
      { name: "settings-appearance", title: "Appearance", path: "/settings/appearance", icon: Palette, scopes: [] },
      { name: "settings-about", title: "About", path: "/settings/about", icon: Info, scopes: [] },
    ],
  },
];
