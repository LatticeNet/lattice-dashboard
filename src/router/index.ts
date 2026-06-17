import {
  createRouter,
  createWebHistory,
  type RouteRecordRaw,
} from "vue-router";
import { useAuthStore } from "@/stores/auth";
import { NAV } from "./nav";

const concreteRoutes: Record<string, () => Promise<unknown>> = {
  overview: () => import("@/views/OverviewView.vue"),
  nodes: () => import("@/views/fleet/NodesView.vue"),
  map: () => import("@/views/fleet/MapView.vue"),
  inventory: () => import("@/views/fleet/InventoryView.vue"),
  monitoring: () => import("@/views/fleet/MonitoringView.vue"),
  approvals: () => import("@/views/operations/ApprovalsView.vue"),
  tasks: () => import("@/views/operations/TasksView.vue"),
  audit: () => import("@/views/operations/AuditView.vue"),
  // Networking
  "network-guard": () => import("@/views/networking/GuardView.vue"),
  "network-policy": () => import("@/views/networking/PolicyView.vue"),
  "network-dns": () => import("@/views/networking/DnsView.vue"),
  "network-geo-routing": () => import("@/views/networking/GeoRoutingView.vue"),
  "network-ddns": () => import("@/views/networking/DdnsView.vue"),
  "network-tunnels": () => import("@/views/networking/TunnelsView.vue"),
  "network-wireguard": () => import("@/views/networking/WireGuardView.vue"),
  // Proxy (flagship)
  "proxy-inbounds": () => import("@/views/proxy/InboundsView.vue"),
  "proxy-users": () => import("@/views/proxy/UsersView.vue"),
  "proxy-profiles": () => import("@/views/proxy/ProfilesView.vue"),
  "proxy-subscriptions": () => import("@/views/proxy/SubscriptionsView.vue"),
  "proxy-usage": () => import("@/views/proxy/UsageView.vue"),
  // Platform
  "platform-plugins": () => import("@/views/platform/PluginsView.vue"),
  "platform-workers": () => import("@/views/platform/WorkersView.vue"),
  "platform-kv": () => import("@/views/platform/KvView.vue"),
  "platform-static": () => import("@/views/platform/StaticView.vue"),
  "platform-logs": () => import("@/views/platform/LogsView.vue"),
  "platform-notifications": () => import("@/views/platform/NotificationsView.vue"),
  "platform-agent-updates": () => import("@/views/platform/AgentUpdatesView.vue"),
  // Settings
  "settings-security": () => import("@/views/settings/SecurityView.vue"),
  "settings-sso": () => import("@/views/settings/SsoView.vue"),
  "settings-tokens": () => import("@/views/settings/TokensView.vue"),
  "settings-appearance": () => import("@/views/settings/AppearanceView.vue"),
  "settings-about": () => import("@/views/settings/AboutView.vue"),
};

/**
 * Build the authenticated child routes from the nav IA so every NAV item has a
 * destination. "/" renders the real Overview; every other path renders the
 * shared PlaceholderView, receiving its title + section via route meta.
 */
const childRoutes: RouteRecordRaw[] = NAV.flatMap((section) =>
  section.items.map<RouteRecordRaw>((item) => {
    const component = concreteRoutes[item.name] ?? (() => import("@/views/PlaceholderView.vue"));
    if (item.path === "/") {
      return {
        path: "",
        name: item.name,
        component,
        meta: { title: item.title, section: section.title, scopes: item.scopes ?? [] },
      };
    }
    return {
      path: item.path.replace(/^\//, ""),
      name: item.name,
      component,
      meta: { title: item.title, section: section.title, scopes: item.scopes ?? [] },
    };
  }),
);

const routes: RouteRecordRaw[] = [
  {
    path: "/login",
    name: "login",
    component: () => import("@/views/auth/LoginView.vue"),
    meta: { public: true },
  },
  {
    path: "/",
    component: () => import("@/layout/AppLayout.vue"),
    children: childRoutes,
  },
  { path: "/:pathMatch(.*)*", redirect: "/" },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior() {
    return { top: 0 };
  },
});

const chunkReloadKey = "lattice:chunk-reload-attempted";
let chunkReloadAttempted = false;

function isDynamicImportFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return [
    "Failed to fetch dynamically imported module",
    "Importing a module script failed",
    "error loading dynamically imported module",
    "Unable to preload CSS",
  ].some((needle) => message.includes(needle)) || /Loading chunk \d+ failed/i.test(message);
}

function safeInternalRedirect(value: unknown): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
    ? value
    : "/";
}

router.onError((error) => {
  if (!isDynamicImportFailure(error) || typeof window === "undefined") return;
  try {
    if (window.sessionStorage.getItem(chunkReloadKey) === "1") {
      window.sessionStorage.removeItem(chunkReloadKey);
      return;
    }
    window.sessionStorage.setItem(chunkReloadKey, "1");
  } catch {
    if (chunkReloadAttempted) return;
    chunkReloadAttempted = true;
  }
  window.location.reload();
});

router.afterEach(() => {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(chunkReloadKey);
  } catch {
    // Ignore storage errors.
  }
  chunkReloadAttempted = false;
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  if (!auth.ready) await auth.bootstrap();
  if (!to.meta.public && !auth.isAuthenticated) {
    return { name: "login", query: { redirect: to.fullPath } };
  }
  if (!to.meta.public && auth.isAuthenticated) {
    const required = Array.isArray(to.meta.scopes) ? (to.meta.scopes as string[]) : [];
    if (required.length > 0 && !auth.canAny(required)) {
      return { name: "overview" };
    }
  }
  if (to.name === "login" && auth.isAuthenticated) {
    return { path: safeInternalRedirect(to.query.redirect) };
  }
});

export default router;
