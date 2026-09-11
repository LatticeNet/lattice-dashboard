/**
 * Mounts InventoryView inside the app's own providers (router, pinia, i18n,
 * theme) against the in-memory API in ./inventoryFakeApi.ts.
 *
 *   LATTICE_HARNESS=inventory LATTICE_HARNESS_PORT=5186 pnpm exec vite --config vite.harness.config.ts
 *   open http://127.0.0.1:5186/dev/inventory.html
 *   open http://127.0.0.1:5186/dev/inventory.html?group=renewal
 *   open http://127.0.0.1:5186/dev/inventory.html?node=node_002   (opens that machine's editor)
 *
 * Same shell as the status harness: the view sits in the app's content measure
 * without the sidebar, and the main is the only scroller. Routes the view links
 * to (a node's detail page, Notifications) resolve to placeholders.
 */
import { createApp, defineComponent, h } from "vue";
import { createPinia } from "pinia";
import { createRouter, createWebHistory, RouterView } from "vue-router";

import { i18n } from "@/i18n";
import { useAuthStore } from "@/stores/auth";
import { useThemeStore } from "@/stores/theme";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import InventoryView from "@/views/fleet/InventoryView.vue";

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
    { path: "/inventory.html", name: "inventory", component: InventoryView },
    { path: "/nodes/:id", name: "node-detail", component: placeholder("Node detail") },
    { path: "/platform/notifications", name: "notifications", component: placeholder("Notifications") },
    { path: "/:rest(.*)", redirect: "/inventory.html" },
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
