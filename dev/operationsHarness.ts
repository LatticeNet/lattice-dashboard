/**
 * Mounts the Operations pages (Approvals, Tasks, Audit) inside the app's own
 * providers against the in-memory API in ./operationsFakeApi.ts.
 *
 *   LATTICE_HARNESS=operations pnpm exec vite --config vite.harness.config.ts --port 5480
 *   open http://127.0.0.1:5480/dev/operations.html#/approvals
 *   open http://127.0.0.1:5480/dev/operations.html#/tasks
 *   open http://127.0.0.1:5480/dev/operations.html#/audit
 *   open http://127.0.0.1:5480/dev/operations.html?fixture=pending#/approvals
 *
 * The routes carry the production paths and names, so links between the
 * three pages (a task's approval, an approval's task, an event's trace) work
 * here as they do in the console. Pages outside Operations resolve to
 * placeholders so a RouterLink never throws. `?theme=light|dark` picks the
 * theme before paint (the stored preference otherwise).
 */
import { createApp, defineComponent, h } from "vue";
import { createPinia } from "pinia";
import { createRouter, createWebHashHistory, RouterView } from "vue-router";

import { i18n } from "@/i18n";
import { useAuthStore } from "@/stores/auth";
import { useThemeStore } from "@/stores/theme";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import ApprovalsView from "@/views/operations/ApprovalsView.vue";
import TasksView from "@/views/operations/TasksView.vue";
import AuditView from "@/views/operations/AuditView.vue";

import "@/style/app.css";

const theme = new URLSearchParams(window.location.search).get("theme");
if (theme === "light" || theme === "dark") {
  try {
    localStorage.setItem("lattice.theme", theme);
  } catch {
    /* ignore storage errors */
  }
}

const Shell = defineComponent({
  name: "OperationsHarnessShell",
  render: () =>
    h(TooltipProvider, { delayDuration: 200 }, () => [
      h("main", { class: "h-full overflow-y-auto" }, [
        h("div", { class: "mx-auto w-full max-w-(--content-max)" }, [
          h(RouterView, null, { default: ({ Component, route }: { Component: unknown; route: { path: string } }) => (Component ? h(Component as never, { key: route.path }) : null) }),
        ]),
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
  history: createWebHashHistory(),
  routes: [
    { path: "/approvals", name: "approvals", component: ApprovalsView },
    { path: "/tasks", name: "tasks", component: TasksView },
    { path: "/audit", name: "audit", component: AuditView },
    { path: "/terminal", name: "terminal", component: placeholder("Terminal") },
    { path: "/nodes", name: "nodes", component: placeholder("Nodes") },
    { path: "/nodes/:id", name: "node-detail", component: placeholder("Node") },
    { path: "/settings/security", name: "settings-security", component: placeholder("Security") },
    { path: "/:rest(.*)", redirect: "/tasks" },
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
