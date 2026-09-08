import {
  createRouter,
  createWebHistory,
  type RouteRecordRaw,
} from "vue-router";
import { useAuthStore } from "@/stores/auth";
import { NAV } from "./nav";
import { concreteRoutes } from "./routeComponents";
import { WORKERS_REDIRECT_TO } from "@/views/platform/publishingModel";

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

/**
 * Manual param routes that can't be derived from NAV (NAV has no params). The
 * meta shape mirrors the NAV-built siblings ({ title, section, scopes }) so the
 * guard's scope check and the breadcrumb logic keep working unchanged.
 */
const manualChildRoutes: RouteRecordRaw[] = [
  {
    path: "nodes/:id",
    name: "node-detail",
    component: () => import("@/views/fleet/NodeDetailView.vue"),
    meta: { title: "Node", section: "Fleet", scopes: ["node:read"] },
  },
  {
    // Deep-linkable single monitor. Reuses MonitoringView, which pre-selects the
    // :id and keeps the URL in sync as the operator switches monitors. The
    // "/monitoring" prefix keeps the Fleet → Monitoring nav item highlighted.
    path: "monitoring/:id",
    name: "monitor-detail",
    component: () => import("@/views/fleet/MonitoringView.vue"),
    meta: { title: "Monitoring", section: "Fleet", scopes: ["monitor:read"] },
  },
  {
    // Logs and Trace became two lenses of one Evidence area. Old links and
    // bookmarks land on the right lens with their query intact.
    path: "platform/logs",
    redirect: (to) => ({ path: "/platform/evidence", query: { ...to.query, lens: "log" } }),
  },
  {
    path: "platform/trace",
    redirect: (to) => ({ path: "/platform/evidence", query: to.query }),
  },
  {
    // KV and Static became one Store page with the kind in the query. Old
    // links keep working and keep the bucket they pointed at; kv is the
    // default kind, so it is the absence of the parameter.
    path: "platform/kv",
    redirect: (to) => ({ path: "/platform/store", query: to.query }),
  },
  {
    path: "platform/static",
    redirect: (to) => ({ path: "/platform/store", query: { ...to.query, kind: "static" } }),
  },
  {
    // Workers is gone: the server slice was deleted in a87 after confirming
    // nothing routed to it, and a scripted origin only comes back once a
    // non-console caller for it is named. The job it was reserved for was
    // "serve this content at a URL", which is Publishing, so that is where an
    // old bookmark lands. The marker in the query is what lets that page say
    // where the feature went instead of silently showing a different one.
    path: "platform/workers",
    redirect: () => ({ path: WORKERS_REDIRECT_TO.path, query: { ...WORKERS_REDIRECT_TO.query } }),
  },
  {
    // Plugin-contributed view (design-10). The route stays open (scopes: []) so a
    // wrong/insufficient scope renders a friendly "no access" panel inside the
    // page rather than a redirect; PluginView enforces the contribution's own
    // scopes (and the server re-checks them on every gateway call).
    path: "plugins/:pluginId/:route(.*)*",
    name: "plugin-view",
    component: () => import("@/views/platform/PluginView.vue"),
    meta: { title: "Plugin", section: "Platform", scopes: [] },
  },
];

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
    children: [...childRoutes, ...manualChildRoutes],
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
  if (!to.meta.public && auth.principal?.mfa_required && to.name !== "settings-security") {
    return { name: "settings-security", query: { mfa: "required" } };
  }
  if (!to.meta.public && auth.isAuthenticated) {
    const required = Array.isArray(to.meta.scopes) ? (to.meta.scopes as string[]) : [];
    if (required.length > 0 && !auth.canAny(required)) {
      return { name: "overview" };
    }
  }
  if (to.name === "login" && auth.isAuthenticated) {
    if (auth.principal?.mfa_required) {
      return { name: "settings-security", query: { mfa: "required" } };
    }
    return { path: safeInternalRedirect(to.query.redirect) };
  }
});

export default router;
