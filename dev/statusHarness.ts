/**
 * Mounts OverviewView or NodesView inside the app's own providers (router,
 * pinia, i18n, theme) against the in-memory API in ./statusFakeApi.ts.
 *
 *   LATTICE_HARNESS=status pnpm exec vite --config vite.harness.config.ts
 *   open http://127.0.0.1:5185/dev/status.html        (Overview)
 *   open http://127.0.0.1:5185/dev/status-nodes.html  (Nodes)
 *
 * Same shell as the other harnesses: the view sits in the app's content
 * measure without the sidebar, and #app pins to the viewport so the main is
 * the only scroller. Named routes the views link to (node detail, approvals,
 * tasks, audit, groups, security) resolve to placeholders so a RouterLink
 * never throws in the harness.
 */
import { createApp, defineComponent, h } from "vue";
import { createPinia } from "pinia";
import { createRouter, createWebHistory, RouterView } from "vue-router";

import { i18n } from "@/i18n";
import { useAuthStore } from "@/stores/auth";
import { useThemeStore } from "@/stores/theme";
import { Toaster } from "@/components/ui/sonner";
import OverviewView from "@/views/OverviewView.vue";
import NodesView from "@/views/fleet/NodesView.vue";

import "@/style/app.css";

const Shell = defineComponent({
  name: "HarnessShell",
  render: () => [
    h("main", { class: "h-full overflow-y-auto" }, [
      h("div", { class: "mx-auto w-full max-w-(--content-max)" }, [h(RouterView)]),
    ]),
    h(Toaster),
  ],
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
    { path: "/status.html", name: "overview", component: OverviewView },
    { path: "/status-nodes.html", name: "nodes", component: NodesView },
    { path: "/nodes/:id", name: "node-detail", component: placeholder("Node detail") },
    { path: "/approvals", name: "approvals", component: placeholder("Approvals") },
    { path: "/tasks", name: "tasks", component: placeholder("Tasks") },
    { path: "/audit", name: "audit", component: placeholder("Audit") },
    { path: "/groups", name: "groups", component: placeholder("Groups") },
    { path: "/settings/security", name: "settings-security", component: placeholder("Security") },
    { path: "/:rest(.*)", redirect: "/status.html" },
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
