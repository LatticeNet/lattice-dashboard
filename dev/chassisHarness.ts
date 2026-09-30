/**
 * The chassis gallery (design 23, section 3): every shared component in every
 * state, for wave 2 lanes and the design review.
 *
 *   LATTICE_HARNESS=chassis LATTICE_HARNESS_PORT=5410 pnpm exec vite --config vite.harness.config.ts
 *   open http://127.0.0.1:5410/dev/chassis.html
 *   open http://127.0.0.1:5410/dev/chassis.html?theme=light
 *   open http://127.0.0.1:5410/dev/chassis.html#/?open=node_0f3a91c2   (a reload lands on the open sheet)
 *
 * Hash history, like the Evidence harness: the page is a static file under
 * vite. The node page link in the sheet resolves to a placeholder route.
 */
import { createApp, defineComponent, h } from "vue";
import { createPinia } from "pinia";
import { createRouter, createWebHashHistory, RouterView } from "vue-router";

import { i18n } from "@/i18n";
import { useThemeStore } from "@/stores/theme";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

import ChassisGallery from "./ChassisGallery.vue";

import "@/style/app.css";

const Shell = defineComponent({
  name: "ChassisHarnessShell",
  render: () =>
    h(TooltipProvider, { delayDuration: 200 }, () => [
      h("main", { class: "min-h-full" }, [h("div", { class: "mx-auto w-full max-w-(--content-max)" }, [h(RouterView)])]),
      h(Toaster),
    ]),
});

const placeholder = (name: string) =>
  defineComponent({ name: `Harness${name}`, render: () => h("p", { class: "p-6 font-mono text-sm" }, `${name} (harness placeholder)`) });

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", name: "chassis", component: ChassisGallery },
    { path: "/nodes/:id", name: "node-detail", component: placeholder("Node detail") },
    { path: "/audit", name: "audit", component: placeholder("Audit") },
    { path: "/:rest(.*)", redirect: "/" },
  ],
});

async function main() {
  const app = createApp(Shell);
  app.use(createPinia());
  app.use(i18n);
  useThemeStore().init();
  app.use(router);
  await router.isReady();
  app.mount("#app");
}

void main();
