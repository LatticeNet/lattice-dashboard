/**
 * Mounts the Evidence area inside the app's own providers (router, pinia,
 * i18n, theme) against the in-memory API in ./evidenceFakeApi.ts.
 *
 *   LATTICE_HARNESS=evidence pnpm exec vite --config vite.harness.config.ts
 *   open http://127.0.0.1:5185/dev/evidence.html?fixture=capture#/platform/evidence
 *
 * The retired /platform/logs and /platform/trace routes redirect exactly as
 * the app router does, so old links can be checked here too. Hash history:
 * the page is a static file under vite, and a path history would 404 on
 * reload.
 */
import { createApp, defineComponent, h } from "vue";
import { createPinia } from "pinia";
import { createRouter, createWebHashHistory, RouterLink, RouterView } from "vue-router";

import { i18n } from "@/i18n";
import { useAuthStore } from "@/stores/auth";
import { useThemeStore } from "@/stores/theme";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import EvidenceView from "@/views/platform/EvidenceView.vue";
import { legacyEvidenceQuery } from "@/views/platform/evidenceModel";

import "@/style/app.css";

const FIXTURES = ["empty", "capture", "rawlog", "failing", "storeoff"] as const;

const Shell = defineComponent({
  name: "EvidenceHarnessShell",
  render: () =>
    h(TooltipProvider, { delayDuration: 200 }, () => [
      h("div", { class: "flex min-h-full flex-col" }, [
        h("nav", { class: "flex flex-wrap gap-3 border-b border-border px-4 py-2 text-xs" }, [
          ...FIXTURES.map((name) =>
            h("a", { href: `?fixture=${name}#/platform/evidence`, class: "text-primary hover:underline" }, name),
          ),
          h(RouterLink, { to: "/platform/trace?tab=policy", class: "text-muted-foreground hover:underline" }, () => "old: trace?tab=policy"),
          h(RouterLink, { to: "/platform/logs?node_id=x", class: "text-muted-foreground hover:underline" }, () => "old: logs"),
        ]),
        h("main", { class: "flex-1" }, [
          h("div", { class: "mx-auto w-full max-w-(--content-max)" }, [h(RouterView)]),
        ]),
      ]),
      h(Toaster),
    ]),
});

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/platform/evidence", name: "platform-evidence", component: EvidenceView },
    { path: "/platform/logs", redirect: (to) => ({ path: "/platform/evidence", query: legacyEvidenceQuery("logs", to.query) }) },
    { path: "/platform/trace", redirect: (to) => ({ path: "/platform/evidence", query: legacyEvidenceQuery("trace", to.query) }) },
    { path: "/:rest(.*)", redirect: "/platform/evidence" },
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
