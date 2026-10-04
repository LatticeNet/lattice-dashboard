/**
 * Mounts the Home and Fleet pages inside the app's own providers (router,
 * pinia, i18n, theme) against the in-memory API in ./fleetFakeApi.ts, with
 * the production-shaped fleet in ./fleetFixture.ts.
 *
 *   LATTICE_HARNESS=fleet LATTICE_HARNESS_PORT=5471 pnpm exec vite --config vite.harness.config.ts
 *   open http://127.0.0.1:5471/dev/fleet.html                   (Home)
 *   open http://127.0.0.1:5471/dev/fleet-nodes.html             (Nodes)
 *   open http://127.0.0.1:5471/dev/fleet-node.html?id=node_020  (DMIT-4, offline 6d, a stalled task)
 *   open http://127.0.0.1:5471/dev/fleet-machines.html          (Machines)
 *   open http://127.0.0.1:5471/dev/fleet-map.html               (Map; ?geo=six&latency=one&layer=latency for a spread and the probe arcs)
 *   open http://127.0.0.1:5471/dev/fleet-monitoring.html        (Monitoring, 0 monitors; ?monitors=some)
 *   open http://127.0.0.1:5471/dev/fleet-groups.html            (Groups)
 *   open http://127.0.0.1:5471/dev/fleet-capabilities.html      (Capability Gates with trust posture)
 *
 * Every page takes `?fleet=prod|dense|empty`, `?fail=<reads>` and
 * `?theme=light|dark` (see fleetFakeApi.ts). Same shell as the other
 * harnesses: the view sits in the app's content measure without the sidebar
 * and the main is the only scroller. Routes the pages link to but this
 * harness does not render resolve to placeholders, so a link never throws.
 */
import { createApp, defineComponent, h } from "vue";
import { createPinia } from "pinia";
import { createRouter, createWebHistory, RouterView } from "vue-router";

import { i18n } from "@/i18n";
import { useAuthStore } from "@/stores/auth";
import { useThemeStore } from "@/stores/theme";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import OverviewView from "@/views/OverviewView.vue";
import NodesView from "@/views/fleet/NodesView.vue";
import NodeDetailView from "@/views/fleet/NodeDetailView.vue";
import InventoryView from "@/views/fleet/InventoryView.vue";
import MapView from "@/views/fleet/MapView.vue";
import MonitoringView from "@/views/fleet/MonitoringView.vue";
import GroupsView from "@/views/fleet/GroupsView.vue";
import CapabilitiesView from "@/views/settings/CapabilitiesView.vue";
import AppHeader from "@/layout/components/AppHeader.vue";

import "@/style/app.css";

const withHeader = new URLSearchParams(window.location.search).get("header") === "1";

const Shell = defineComponent({
  name: "HarnessShell",
  render: () =>
    h(TooltipProvider, { delayDuration: 200 }, () => [
      withHeader ? h(AppHeader, { mobileOpen: false }) : null,
      h("main", { class: "h-full overflow-y-auto" }, [
        h("div", { class: "mx-auto w-full max-w-(--content-max)" }, [h(RouterView)]),
      ]),
      h(Toaster),
    ]),
});

function placeholder(name: string) {
  return defineComponent({
    name: `Harness${name.replace(/\W/g, "")}`,
    render: () => h("p", { class: "p-6 font-mono text-sm" }, `${name} (harness placeholder)`),
  });
}

const router = createRouter({
  history: createWebHistory("/dev/"),
  routes: [
    { path: "/fleet.html", name: "overview", component: OverviewView },
    { path: "/fleet-nodes.html", name: "nodes", component: NodesView },
    { path: "/fleet-machines.html", name: "inventory", component: InventoryView },
    { path: "/fleet-map.html", name: "map", component: MapView },
    { path: "/fleet-monitoring.html", name: "monitoring", component: MonitoringView },
    { path: "/monitoring/:id", name: "monitor-detail", component: MonitoringView },
    { path: "/fleet-groups.html", name: "groups", component: GroupsView },
    { path: "/fleet-capabilities.html", name: "settings-capabilities", component: CapabilitiesView },
    // NodeDetailView reads route.params.id, which an .html entry cannot carry.
    {
      path: "/fleet-node.html",
      redirect: (to) => ({ name: "node-detail", params: { id: String(to.query.id ?? "node_020") }, query: { ...to.query, id: undefined } }),
    },
    { path: "/nodes/:id", name: "node-detail", component: NodeDetailView },
    ...[
      ["upcoming", "/upcoming"],
      ["approvals", "/approvals"],
      ["tasks", "/tasks"],
      ["audit", "/audit"],
      ["terminal", "/terminal"],
      ["network-ddns", "/network/ddns"],
      ["network-ssh-guard", "/network/ssh-guard"],
      ["platform-evidence", "/platform/evidence"],
      ["platform-notifications", "/platform/notifications"],
      ["platform-agent-updates", "/platform/agent-updates"],
      ["settings-security", "/settings/security"],
    ].map(([name, path]) => ({ path: path!, name: name!, component: placeholder(name!) })),
    { path: "/:rest(.*)", redirect: "/fleet.html" },
  ],
});

async function main() {
  const app = createApp(Shell);
  app.use(createPinia());
  app.use(i18n);
  useThemeStore().init();
  await useAuthStore().bootstrap();
  app.use(router);
  await router.isReady();
  app.mount("#app");
}

void main();
