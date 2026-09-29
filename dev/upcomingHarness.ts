/**
 * Mounts the views the Upcoming work touches (home with its Upcoming panel,
 * the full Upcoming list, Inventory, Notifications) inside the app's own
 * providers against the in-memory API in ./upcomingFakeApi.ts.
 *
 *   LATTICE_HARNESS=upcoming LATTICE_HARNESS_PORT=5201 pnpm exec vite --config vite.harness.config.ts
 *   open http://127.0.0.1:5201/dev/upcoming.html
 *   open http://127.0.0.1:5201/dev/upcoming.html?fixture=old#/upcoming?kind=machine_renewal
 *
 * Routes live in the hash so one entry page serves them all and a reload keeps
 * the view; the fixture is picked in the query before the hash (see the fake).
 * The theme follows the browser's colour scheme, so a headless run with a
 * light scheme renders the light theme. Routes the views link to that are not
 * part of this work resolve to placeholders.
 */
import { createApp, defineComponent, h } from "vue";
import { createPinia } from "pinia";
import { createRouter, createWebHashHistory, RouterView } from "vue-router";

import { i18n } from "@/i18n";
import { useAuthStore } from "@/stores/auth";
import { useThemeStore } from "@/stores/theme";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import OverviewView from "@/views/OverviewView.vue";
import UpcomingView from "@/views/fleet/UpcomingView.vue";
import InventoryView from "@/views/fleet/InventoryView.vue";
import NotificationsView from "@/views/platform/NotificationsView.vue";

import "@/style/app.css";

try {
  localStorage.setItem("lattice.theme", "system");
} catch {
  // Storage blocked: the default dark theme still renders.
}
// `?locale=zh-CN` renders the Chinese copy without touching the saved choice.
const locale = new URLSearchParams(window.location.search).get("locale");
if (locale === "en" || locale === "zh-CN") i18n.global.locale.value = locale;

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

function placeholder(name: string) {
  return defineComponent({
    name: `Harness${name.replace(/\W/g, "")}`,
    render: () => h("p", { class: "p-6 font-mono text-sm" }, `${name} (harness placeholder)`),
  });
}

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", name: "overview", component: OverviewView },
    { path: "/upcoming", name: "upcoming", component: UpcomingView },
    { path: "/inventory", name: "inventory", component: InventoryView },
    { path: "/platform/notifications", name: "platform-notifications", component: NotificationsView },
    { path: "/nodes", name: "nodes", component: placeholder("Nodes") },
    { path: "/nodes/:id", name: "node-detail", component: placeholder("Node detail") },
    { path: "/approvals", name: "approvals", component: placeholder("Approvals") },
    { path: "/tasks", name: "tasks", component: placeholder("Tasks") },
    { path: "/audit", name: "audit", component: placeholder("Audit") },
    { path: "/monitoring/:id?", name: "monitoring", component: placeholder("Monitoring") },
    { path: "/platform/publishing", name: "platform-publishing", component: placeholder("Publishing") },
    { path: "/plugins/:rest(.*)", name: "plugin-view", component: placeholder("Plugin view") },
    { path: "/settings/security", name: "settings-security", component: placeholder("Security") },
    { path: "/:rest(.*)", redirect: "/" },
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
