/**
 * The whole console, shell included, against an in-memory API.
 *
 *   pnpm exec vite --config vite.harness.frame.config.ts
 *   open http://127.0.0.1:5186/approvals
 *
 * Every other harness mounts one view in a bare scroller. This one serves the
 * real index.html, the real router and the real AppLayout (sidebar, header,
 * trust banner, command palette), so what is checked here is the frame around
 * a page: where the sidebar meets the top bar, which element scrolls, where a
 * side sheet starts, and how a sandboxed plugin frame sits in the main region.
 *
 * The calls are the union of six existing fakes, later ones winning per
 * method: netplat (the shell's reads, plugins, settings), fleet (Nodes,
 * Groups, Monitoring, Map), evidence (Evidence), platform (Publishing),
 * operations (Tasks) and approvals (Approvals). Anything none
 * of them implements answers 501 instead of throwing, so a page outside that
 * set renders its own failed-read state rather than a blank shell.
 *
 * NetGuard and WireGuard are sandbox plugins here. Their frame loads
 * /api/plugins/assets/<id>/<digest>/ui/index.html, which
 * vite.harness.frame.config.ts serves from a plugin build named in
 * LATTICE_HARNESS_PLUGINS; without one the frame shows the host's own
 * failure state. Their data calls answer 502, which is enough for the page
 * header, the error notice and a side panel opened from the address
 * (NetGuard's ?open=<node>) to render at their real positions.
 */
import { ApiError } from "@/lib/api/client";
import type { PluginView } from "@/lib/api/index";

import { api as netplat } from "./netplatFakeApi";
import { api as fleet } from "./fleetFakeApi";
import { api as evidence } from "./evidenceFakeApi";
import { api as platform } from "./platformFakeApi";
import { api as operations } from "./operationsFakeApi";
import { api as approvals } from "./approvalsFakeApi";

export * from "@/lib/api/index";

type Namespace = Record<string, unknown>;

/** Any 64-hex digest passes the host's entry URL check; the config serves every digest. */
const DIGEST = "0".repeat(64);
const SANDBOX = new Set(["latticenet.netguard", "latticenet.wireguard"]);

function withRuntime(plugin: PluginView): PluginView {
  if (!SANDBOX.has(plugin.id) || !plugin.active) return plugin;
  return {
    ...plugin,
    ui_runtime: {
      mode: "sandbox",
      entry_url: `/api/plugins/assets/${plugin.id}/${DIGEST}/ui/index.html`,
      bridge_version: "1",
      asset_digest: DIGEST,
    },
  };
}

const noBackend = (service: string, method: string) =>
  Promise.reject(new ApiError(502, "bad_gateway", `harness has no plugin backend for ${service}.${method}`));

const plugins = {
  ...(netplat.plugins as Namespace),
  list: () => (netplat.plugins.list() as Promise<PluginView[]>).then((list) => list.map(withRuntime)),
  contributions: () => (netplat.plugins.contributions() as Promise<PluginView[]>).then((list) => list.map(withRuntime)),
  call: (id: string, service: string, method: string, ...rest: unknown[]) =>
    SANDBOX.has(id)
      ? noBackend(service, method)
      : (netplat.plugins.call as (...args: unknown[]) => Promise<unknown>)(id, service, method, ...rest),
};

function merge(...sources: Namespace[]): Record<string, Namespace> {
  const out: Record<string, Namespace> = {};
  for (const source of sources) {
    for (const [name, value] of Object.entries(source)) {
      out[name] = { ...(out[name] ?? {}), ...(value as Namespace) };
    }
  }
  return out;
}

// Three namespaces are taken whole from the fake that owns the page: the
// session from netplat (it holds every scope, "*", which the plugin pages
// need), tasks from operations and approvals from approvals, so each page
// reads one fixture instead of a mix of two.
const merged = merge(netplat as Namespace, fleet as Namespace, evidence as Namespace, platform as Namespace, operations as Namespace, approvals as Namespace);
Object.assign(merged, {
  plugins,
  auth: netplat.auth as Namespace,
  tasks: operations.tasks as Namespace,
  approvals: approvals.approvals as Namespace,
});

/** A namespace or method nobody implements answers 501, so the page shows its failed read. */
function unimplemented(path: string) {
  return () => Promise.reject(new ApiError(501, "not_implemented", `frame harness does not implement api.${path}`));
}

export const api = new Proxy(merged, {
  get(target, namespace: string) {
    const ns = target[namespace] ?? {};
    return new Proxy(ns, {
      get(inner, method: string) {
        return method in inner ? inner[method] : unimplemented(`${namespace}.${method}`);
      },
    });
  },
}) as unknown as typeof netplat;
