/**
 * Mounts the four views of the observed-DNS story inside the app's own
 * providers (router, pinia, i18n, theme) against the in-memory API in
 * ./dnsFakeApi.ts.
 *
 *   LATTICE_HARNESS=dns pnpm exec vite --config vite.harness.config.ts
 *   open http://127.0.0.1:5185/dev/dns.html          (Self-host DNS)
 *   open http://127.0.0.1:5185/dev/geo-routing.html  (Geo-Routing)
 *   open http://127.0.0.1:5185/dev/tunnels.html      (Tunnels)
 *   open http://127.0.0.1:5185/dev/monitoring.html   (Monitoring)
 *
 * Same shell as the other harnesses: the view sits in the app's content
 * measure without the sidebar, and #app pins to the viewport so the main is
 * the only scroller. The named route the plan dialogs link to (approvals)
 * resolves to a placeholder so a RouterLink never throws.
 */
import { createApp, defineComponent, h } from "vue";
import { createPinia } from "pinia";
import { createRouter, createWebHistory, RouterView } from "vue-router";

import { i18n } from "@/i18n";
import { useAuthStore } from "@/stores/auth";
import { useThemeStore } from "@/stores/theme";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import DnsView from "@/views/networking/DnsView.vue";
import GeoRoutingView from "@/views/networking/GeoRoutingView.vue";
import TunnelsView from "@/views/networking/TunnelsView.vue";
import MonitoringView from "@/views/fleet/MonitoringView.vue";

import "@/style/app.css";

const Shell = defineComponent({
  name: "HarnessShell",
  render: () =>
    h(TooltipProvider, { delayDuration: 200 }, () => [
      h("main", { class: "h-full overflow-y-auto" }, [
        h("div", { class: "mx-auto w-full max-w-(--content-max)" }, [h(RouterView)]),
      ]),
      h(Toaster),
    ]),
});

const Approvals = defineComponent({
  name: "HarnessApprovals",
  render: () => h("p", { class: "p-6 font-mono text-sm" }, "Approvals (harness placeholder)"),
});

const router = createRouter({
  history: createWebHistory("/dev/"),
  routes: [
    { path: "/dns.html", name: "dns", component: DnsView },
    { path: "/geo-routing.html", name: "geo-routing", component: GeoRoutingView },
    { path: "/tunnels.html", name: "tunnels", component: TunnelsView },
    { path: "/monitoring.html", name: "monitoring", component: MonitoringView },
    // MonitoringView keeps the selected monitor in the URL through
    // router.replace({ name: "monitor-detail" }), and vue-router throws
    // synchronously on an unknown name. Without this route that throw escapes
    // the watcher and aborts the update flush, which leaves the definitions
    // list rendering its loading skeleton forever.
    { path: "/monitoring.html/:id", name: "monitor-detail", component: MonitoringView },
    { path: "/approvals", name: "approvals", component: Approvals },
    { path: "/:rest(.*)", redirect: "/dns.html" },
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
