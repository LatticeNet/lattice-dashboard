/**
 * Mounts ApprovalsView inside the app's own providers (router, pinia, i18n,
 * theme) against the in-memory API in ./approvalsFakeApi.ts.
 *
 *   LATTICE_HARNESS=approvals pnpm exec vite --config vite.harness.config.ts
 *   open http://127.0.0.1:5185/dev/approvals.html
 *   open http://127.0.0.1:5185/dev/approvals.html?state=empty
 *   open http://127.0.0.1:5185/dev/approvals.html?scope=read
 *
 * Same shell as the other harnesses: the view sits in the app's content
 * measure without the sidebar, and #app pins to the viewport so the main is
 * the only scroller. The node route is real rather than a placeholder because
 * the waiting banner links into it, and a link that throws is not a link.
 */
import { createApp, defineComponent, h } from "vue";
import { createPinia } from "pinia";
import { createRouter, createWebHistory, RouterView } from "vue-router";

import { i18n } from "@/i18n";
import { useAuthStore } from "@/stores/auth";
import { useThemeStore } from "@/stores/theme";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import ApprovalsView from "@/views/operations/ApprovalsView.vue";

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

function placeholder(name: string) {
  return defineComponent({
    name: `Harness${name}`,
    render: () => h("p", { class: "p-6 font-mono text-sm" }, `${name} (harness placeholder)`),
  });
}

const router = createRouter({
  history: createWebHistory("/dev/"),
  routes: [
    { path: "/approvals.html", name: "approvals", component: ApprovalsView },
    { path: "/nodes/:id", name: "node-detail", component: placeholder("Node detail") },
    { path: "/:rest(.*)", redirect: "/approvals.html" },
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
