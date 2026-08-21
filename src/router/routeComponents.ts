/**
 * Which view answers each NAV destination.
 *
 * This lives apart from the router so it can be checked without booting Vue.
 * NAV is what builds the route table, so a view registered here with no NAV
 * entry is a feature nobody can reach: that is exactly how the agent-updates
 * page sat unreachable while its route, its view, and its translations all
 * existed. The test next door pins the two lists to each other.
 */
export const concreteRoutes: Record<string, () => Promise<unknown>> = {
  overview: () => import("@/views/OverviewView.vue"),
  nodes: () => import("@/views/fleet/NodesView.vue"),
  groups: () => import("@/views/fleet/GroupsView.vue"),
  map: () => import("@/views/fleet/MapView.vue"),
  inventory: () => import("@/views/fleet/InventoryView.vue"),
  monitoring: () => import("@/views/fleet/MonitoringView.vue"),
  approvals: () => import("@/views/operations/ApprovalsView.vue"),
  tasks: () => import("@/views/operations/TasksView.vue"),
  terminal: () => import("@/views/operations/TerminalView.vue"),
  audit: () => import("@/views/operations/AuditView.vue"),
  // Networking
  "network-policy": () => import("@/views/networking/PolicyView.vue"),
  "network-dns": () => import("@/views/networking/DnsView.vue"),
  "network-geo-routing": () => import("@/views/networking/GeoRoutingView.vue"),
  "network-ddns": () => import("@/views/networking/DdnsView.vue"),
  "network-tunnels": () => import("@/views/networking/TunnelsView.vue"),
  "network-subscription-shares": () =>
    import("@/views/networking/SubscriptionSharesView.vue"),
  // Platform
  "platform-plugins": () => import("@/views/platform/PluginsView.vue"),
  "platform-workers": () => import("@/views/platform/WorkersView.vue"),
  "platform-publishing": () => import("@/views/platform/PublishingView.vue"),
  "platform-kv": () => import("@/views/platform/KvView.vue"),
  "platform-static": () => import("@/views/platform/StaticView.vue"),
  "platform-logs": () => import("@/views/platform/LogsView.vue"),
  "platform-notifications": () => import("@/views/platform/NotificationsView.vue"),
  "platform-agent-updates": () => import("@/views/platform/AgentUpdatesView.vue"),
  // Settings
  "settings-security": () => import("@/views/settings/SecurityView.vue"),
  "settings-sso": () => import("@/views/settings/SsoView.vue"),
  "settings-users": () => import("@/views/settings/UsersView.vue"),
  "settings-tokens": () => import("@/views/settings/TokensView.vue"),
  "settings-appearance": () => import("@/views/settings/AppearanceView.vue"),
  "settings-about": () => import("@/views/settings/AboutView.vue"),
};

