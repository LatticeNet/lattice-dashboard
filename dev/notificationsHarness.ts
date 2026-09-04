/**
 * Mounts NotificationsView inside the app's own providers (router, pinia,
 * i18n, theme) against the in-memory API in ./notificationsFakeApi.ts.
 *
 *   LATTICE_HARNESS=notifications pnpm exec vite --config vite.harness.config.ts
 *   open http://127.0.0.1:5185/dev/notifications.html
 *
 * Same shell as the status harness: the view sits in the app's content
 * measure without the sidebar, and #app pins to the viewport so the main is
 * the only scroller. The fixture holds a Bark channel saved before the
 * optional fields existed and one saved with all of them, so the edit form
 * can be opened on both.
 */
import { createApp, defineComponent, h } from "vue";
import { createPinia } from "pinia";
import { createRouter, createWebHistory, RouterView } from "vue-router";

import { i18n } from "@/i18n";
import { useAuthStore } from "@/stores/auth";
import { useThemeStore } from "@/stores/theme";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotificationsView from "@/views/platform/NotificationsView.vue";

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

const router = createRouter({
  history: createWebHistory("/dev/"),
  routes: [
    { path: "/notifications.html", name: "notifications", component: NotificationsView },
    { path: "/:rest(.*)", redirect: "/notifications.html" },
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
