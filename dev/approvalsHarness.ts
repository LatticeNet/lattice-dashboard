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

/**
 * First paint of the inbox, for the before/after measurement: the time from
 * navigation start until the first inbox row (an event card or a table row)
 * is in the DOM, and the bytes the fake had answered by then. Read it from
 * the console as window.__approvalsFirstPaint; window.__approvalsRequests is
 * the full request log.
 *
 * A MutationObserver rather than requestAnimationFrame: rAF is throttled to a
 * standstill in a background tab, so a driven browser that is not the frontmost
 * window would silently never record a measurement.
 */
const INBOX_PAINTED = "[data-event-card], [data-history-note], [data-inbox-empty], table tbody tr";

function watchFirstPaint() {
  const started = performance.now();
  const record = () => {
    if (!document.querySelector(INBOX_PAINTED)) return false;
    const log = (window as unknown as { __approvalsRequests?: Array<{ bytes: number; ms: number; url: string }> }).__approvalsRequests ?? [];
    (window as unknown as { __approvalsFirstPaint?: unknown }).__approvalsFirstPaint = {
      ms: Math.round(performance.now()),
      sinceMountMs: Math.round(performance.now() - started),
      bytes: log.reduce((sum, r) => sum + r.bytes, 0),
      requests: log.map((r) => ({ url: r.url, bytes: r.bytes, ms: Math.round(r.ms) })),
    };
    return true;
  };
  if (record()) return;
  const observer = new MutationObserver(() => {
    if (record()) observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

async function main() {
  const app = createApp(Shell);
  // A render error in a view mounted this bare leaves an empty #app and an
  // otherwise quiet console, which reads as "the harness is broken" rather
  // than "the page throws". Keep the last one where a driven browser can read
  // it, and still log it.
  app.config.errorHandler = (err) => {
    (window as unknown as { __vueError?: string }).__vueError = String((err as Error)?.stack ?? err);
    console.error(err);
  };
  app.use(createPinia());
  app.use(i18n);
  useThemeStore().init();
  await useAuthStore().bootstrap();
  app.use(router);
  await router.isReady();
  app.mount("#app");
  watchFirstPaint();
}

void main();
