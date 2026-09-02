/**
 * Mounts SshGuardView inside the app's own providers (router, pinia, i18n,
 * theme) against the in-memory API in ./fakeApi.ts.
 *
 *   pnpm exec vite --config vite.harness.ssh-guard.config.ts --port 5182
 *   open http://127.0.0.1:5182/dev/ssh-guard.html
 *
 * The view is rendered in the same content measure the app layout gives it,
 * without the sidebar, so 1440 and 375 can be checked against a fixed,
 * realistic fleet instead of whatever the nearest control plane holds. The
 * shell scrolls the way AppLayout's main does: app.css pins #app to the
 * viewport with overflow hidden, so the scroller has to be h-full inside it;
 * a min-h-dvh main would grow past #app and leave the bottom rows unreachable.
 */
import { createApp, defineComponent, h } from "vue";
import { createPinia } from "pinia";
import { createRouter, createWebHistory, RouterView } from "vue-router";

import { i18n } from "@/i18n";
import { useAuthStore } from "@/stores/auth";
import { useThemeStore } from "@/stores/theme";
import { Toaster } from "@/components/ui/sonner";
import SshGuardView from "@/views/networking/SshGuardView.vue";

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

const Approvals = defineComponent({
  name: "HarnessApprovals",
  render: () => h("p", { class: "p-6 font-mono text-sm" }, "Approvals (harness placeholder)"),
});

const router = createRouter({
  history: createWebHistory("/dev/"),
  routes: [
    { path: "/ssh-guard.html", component: SshGuardView },
    { path: "/approvals", component: Approvals },
    { path: "/:rest(.*)", redirect: "/ssh-guard.html" },
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
