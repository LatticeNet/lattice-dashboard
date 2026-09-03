/**
 * Mounts OverviewView or NodesView inside the app's own providers (router,
 * pinia, i18n, theme) against the in-memory API in ./statusFakeApi.ts.
 *
 *   LATTICE_HARNESS=status pnpm exec vite --config vite.harness.config.ts
 *   open http://127.0.0.1:5185/dev/status.html        (Overview)
 *   open http://127.0.0.1:5185/dev/status-nodes.html  (Nodes)
 *   open http://127.0.0.1:5185/dev/status-node.html   (one node's detail page)
 *   open http://127.0.0.1:5185/dev/status-tasks.html  (Tasks, every task state)
 *
 * Node detail and Tasks are here because the status word and the task state
 * are printed on all four surfaces and the point of the harness is comparing
 * them side by side: the node page's queue and the Tasks table have to agree
 * on what colour a stalled target is.
 *
 * Same shell as the other harnesses: the view sits in the app's content
 * measure without the sidebar, and #app pins to the viewport so the main is
 * the only scroller. Named routes the views link to (approvals, audit, groups,
 * security) resolve to placeholders so a RouterLink never throws.
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
import TasksView from "@/views/operations/TasksView.vue";

import "@/style/app.css";

// The tooltip provider is part of the shell, not a detail of it: the status
// pill's explanation is a tooltip now, and without a provider it would be the
// one thing the harness could not show.
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
    name: `Harness${name}`,
    render: () => h("p", { class: "p-6 font-mono text-sm" }, `${name} (harness placeholder)`),
  });
}

const router = createRouter({
  history: createWebHistory("/dev/"),
  routes: [
    { path: "/status.html", name: "overview", component: OverviewView },
    { path: "/status-nodes.html", name: "nodes", component: NodesView },
    { path: "/status-tasks.html", name: "tasks", component: TasksView },
    // NodeDetailView reads route.params.id, which an .html entry point cannot
    // carry, so the entry redirects into the real route. `?id=` picks the node;
    // the default is the one offline since 2026-08-27, with a stalled task
    // against it.
    {
      path: "/status-node.html",
      redirect: (to) => ({ name: "node-detail", params: { id: String(to.query.id ?? "node_005") } }),
    },
    { path: "/nodes/:id", name: "node-detail", component: NodeDetailView },
    { path: "/approvals", name: "approvals", component: placeholder("Approvals") },
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
