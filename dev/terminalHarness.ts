/**
 * Mounts TerminalView inside the app's own providers (router, pinia, i18n,
 * theme) against the in-memory API in ./terminalFakeApi.ts.
 *
 *   LATTICE_HARNESS=terminal pnpm exec vite --config vite.harness.config.ts
 *   open http://127.0.0.1:5185/dev/terminal.html
 *
 * The view claims the viewport pane in production, so the harness gives it
 * the same containing block: a main region that does not scroll, sized to
 * the dynamic viewport, with a one-line scenario bar above it. Scenarios:
 *
 *   ?scope=none                       the token lacks terminal:open
 *   ?scope=forbid                     the list itself answers 403
 *   ?session_id=term_other_operator   attach to another operator's session
 *   ?node_id=<id>&connect=1           the Nodes page deep link
 */
import { createApp, defineComponent, h } from "vue";
import { createPinia } from "pinia";
import { createRouter, createWebHistory, RouterView } from "vue-router";

import { i18n } from "@/i18n";
import { useAuthStore } from "@/stores/auth";
import { useThemeStore } from "@/stores/theme";
import { Toaster } from "@/components/ui/sonner";
import TerminalView from "@/views/operations/TerminalView.vue";

import { installFakeWebSocket } from "./terminalFakeApi";

import "@/style/app.css";

installFakeWebSocket();

const SCENARIOS: Array<[label: string, href: string]> = [
  ["default", "/dev/terminal.html"],
  ["no scope", "/dev/terminal.html?scope=none"],
  ["list 403", "/dev/terminal.html?scope=forbid"],
  ["other operator's session", "/dev/terminal.html?session_id=term_other_operator"],
  ["deep link", "/dev/terminal.html?node_id=node_dmit_pro_malibu&connect=1"],
];

const Shell = defineComponent({
  name: "HarnessShell",
  render: () => [
    h(
      "nav",
      { class: "flex h-8 items-center gap-3 border-b border-border bg-muted/40 px-3 font-mono text-[11px] text-muted-foreground" },
      SCENARIOS.map(([label, href]) => h("a", { href, class: "hover:text-foreground" }, label)),
    ),
    h("main", { class: "relative overflow-hidden", style: "height: calc(100dvh - 2rem)" }, [h(RouterView)]),
    h(Toaster),
  ],
});

const Placeholder = defineComponent({
  name: "HarnessPlaceholder",
  render: () => h("p", { class: "p-6 font-mono text-sm" }, "Harness placeholder route"),
});

const router = createRouter({
  history: createWebHistory("/dev/"),
  routes: [
    { path: "/terminal.html", component: TerminalView },
    { path: "/nodes", component: Placeholder },
    { path: "/:rest(.*)", redirect: "/terminal.html" },
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
