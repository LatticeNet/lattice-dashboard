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
  "settings-security": () => import("@/views/settings/SecurityView.vue"),
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
    return { path: (to.query.redirect as string) || "/" };
  }
});

export default router;
