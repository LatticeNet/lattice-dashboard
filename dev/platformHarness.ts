/**
 * Mounts the Publishing and Store pages inside the app's own providers (router,
 * pinia, i18n, theme) against the in-memory API in ./platformFakeApi.ts.
 *
 *   LATTICE_HARNESS=platform pnpm exec vite --config vite.harness.config.ts
 *   open http://127.0.0.1:5185/dev/platform.html#/publishing
 *
 * Two routes rather than two harnesses: Publishing and Store are one plane in
 * the IA and the questions asked of them are comparative (does the access
 * legend say the same thing the badge says, does Store gate the bucket it
 * says the server owns), so they share one fixture and one shell. Evidence
 * has its own harness (dev/evidence.html) with a fixture per collection state.
 *
 * Hash history: the page is served as a static file by vite, so a path history
 * would 404 on reload at every route but the first.
 */
import { createApp, defineComponent, h } from "vue";
import { createPinia } from "pinia";
import { createRouter, createWebHashHistory, RouterLink, RouterView } from "vue-router";

import { i18n } from "@/i18n";
import { useAuthStore } from "@/stores/auth";
import { useThemeStore } from "@/stores/theme";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import PublishingView from "@/views/platform/PublishingView.vue";
import StoreView from "@/views/platform/StoreView.vue";
import PluginStepUpHarness from "./PluginStepUpHarness.vue";

import "@/style/app.css";

const LINKS = [
  ["/publishing", "Publishing"],
  ["/store", "Store"],
  ["/store?kind=kv&bucket=vpnmeta%2Flineuuid", "Store: line identity map"],
  ["/store?kind=kv&bucket=line-secrets", "Store: reserved bucket"],
  ["/plugin-step-up", "Plugin step-up"],
] as const;

const Shell = defineComponent({
  name: "PlatformHarnessShell",
  render: () =>
    h(TooltipProvider, { delayDuration: 200 }, () => [
      h("div", { class: "flex h-full flex-col" }, [
        h(
          "nav",
          { class: "flex flex-wrap gap-3 border-b border-border px-4 py-2 text-xs" },
          LINKS.map(([to, label]) =>
            h(RouterLink, { to, class: "text-primary hover:underline" }, () => label),
          ),
        ),
        h("main", { class: "min-h-0 flex-1 overflow-y-auto" }, [
          h("div", { class: "mx-auto w-full max-w-(--content-max)" }, [h(RouterView)]),
        ]),
      ]),
      h(Toaster),
    ]),
});

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/publishing", name: "publishing", component: PublishingView },
    { path: "/store", name: "store", component: StoreView },
    { path: "/plugin-step-up", name: "plugin-step-up", component: PluginStepUpHarness },
    // Where an identity row leads (vpn-core's Users page), shown as the address it was given.
    {
      path: "/plugins/:plugin/:route",
      name: "plugin-page-stub",
      component: defineComponent({
        name: "PluginPageStub",
        render() {
          return h("p", { class: "p-6 font-mono text-sm", "data-testid": "plugin-page-stub" }, this.$route.fullPath);
        },
      }),
    },
    // The pages link to their app paths; land those on the harness routes.
    { path: "/platform/publishing", redirect: (to) => ({ path: "/publishing", query: to.query }) },
    { path: "/platform/store", redirect: (to) => ({ path: "/store", query: to.query }) },
    { path: "/:rest(.*)", redirect: "/publishing" },
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
