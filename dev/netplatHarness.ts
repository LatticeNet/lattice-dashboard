/**
 * Mounts the Networking, Platform and Settings pages that had no harness
 * (design 23, sections 4.4 to 4.6) inside the app's own providers (router,
 * pinia, i18n, theme) against the in-memory API in ./netplatFakeApi.ts.
 *
 *   LATTICE_HARNESS=netplat pnpm exec vite --config vite.harness.config.ts
 *   open http://127.0.0.1:5185/dev/netplat-ddns.html
 *
 * One entry per page; the fixture switches are listed in netplatFakeApi.ts.
 * `?theme=light` or `?theme=dark` picks the theme before the first paint.
 * Named routes the pages link to (a node's page, approvals) resolve to
 * placeholders so a RouterLink never throws.
 */
import { createApp, defineComponent, h } from "vue";
import { createPinia } from "pinia";
import { createRouter, createWebHistory, RouterView } from "vue-router";

import { i18n } from "@/i18n";
import { useAuthStore } from "@/stores/auth";
import { useThemeStore } from "@/stores/theme";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import DdnsView from "@/views/networking/DdnsView.vue";
import PolicyView from "@/views/networking/PolicyView.vue";
import DnsView from "@/views/networking/DnsView.vue";
import TunnelsView from "@/views/networking/TunnelsView.vue";
import GeoRoutingView from "@/views/networking/GeoRoutingView.vue";

import "@/style/app.css";

const Shell = defineComponent({
  name: "NetplatHarnessShell",
  render: () =>
    h(TooltipProvider, { delayDuration: 200 }, () => [
      h("main", { class: "h-full overflow-y-auto" }, [
        h("div", { class: "mx-auto w-full max-w-(--content-max)" }, [h(RouterView)]),
      ]),
      h(Toaster),
    ]),
});

function placeholder(name: string) {
  return defineComponent({
    name: `Harness${name}`,
    render: () => h("p", { class: "p-6 font-mono text-sm" }, `${name} (harness placeholder)`),
  });
}

const router = createRouter({
  history: createWebHistory("/dev/"),
  routes: [
    { path: "/netplat-ddns.html", name: "network-ddns", component: DdnsView },
    { path: "/netplat-policy.html", name: "network-policy", component: PolicyView },
    { path: "/netplat-dns.html", name: "network-dns", component: DnsView },
    { path: "/netplat-tunnels.html", name: "network-tunnels", component: TunnelsView },
    { path: "/netplat-geo.html", name: "network-geo-routing", component: GeoRoutingView },
    { path: "/nodes/:id", name: "node-detail", component: placeholder("Node") },
    { path: "/approvals", name: "approvals", component: placeholder("Approvals") },
    { path: "/groups", name: "groups", component: placeholder("Groups") },
    { path: "/monitoring", name: "monitoring", component: placeholder("Monitoring") },
    { path: "/monitoring/:id", name: "monitor-detail", component: placeholder("Monitor") },
    { path: "/platform/plugins", name: "platform-plugins", component: placeholder("Plugins") },
    { path: "/plugins/:pluginId/:route(.*)*", name: "plugin-view", component: placeholder("Plugin page") },
    { path: "/:rest(.*)", redirect: "/netplat-ddns.html" },
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
