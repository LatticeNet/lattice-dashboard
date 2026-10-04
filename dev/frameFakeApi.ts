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
 * Node ids differ between fixtures, so a namespace a page reads together
 * with others comes whole from one fake: nodes from fleet, users from
 * netplat, and on SSH Guard (vite.harness.frame.config.ts also aliases its
 * reality read) the nodes, approvals and sshGuard of dev/fakeApi.ts, and on
 * Policy the nodes of netplat, by the page's path (PAGE_OWNERS). Policy's
 * node policies are in its dense fixture: open
 * /network/policy?policy=dense&view=policies to reach a policy's Plan and
 * the plan review dialog.
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
import { api as guard } from "./fakeApi";

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

// Some namespaces are taken whole from the fake that owns the page: the
// session from netplat (it holds every scope, "*", which the plugin pages
// need), users from netplat (Access reads their scopes), nodes from fleet,
// tasks from operations and approvals from approvals, so each page reads one
// fixture instead of a mix of two.
const merged = merge(netplat as Namespace, fleet as Namespace, evidence as Namespace, platform as Namespace, operations as Namespace, approvals as Namespace);
Object.assign(merged, {
  plugins,
  auth: netplat.auth as Namespace,
  users: netplat.users as Namespace,
  nodes: fleet.nodes as Namespace,
  tasks: operations.tasks as Namespace,
  approvals: approvals.approvals as Namespace,
});

/** On these pages the named namespaces come from the page's own fake, whose node ids its other reads use. */
const PAGE_OWNERS: { path: RegExp; namespaces: Record<string, Namespace> }[] = [
  {
    path: /^\/network\/ssh-guard(\/|$)/,
    namespaces: { nodes: guard.nodes as Namespace, approvals: guard.approvals as Namespace, sshGuard: guard.sshGuard as Namespace },
  },
  { path: /^\/network\/policy(\/|$)/, namespaces: { nodes: netplat.nodes as Namespace } },
];

function owned(namespace: string): Namespace | undefined {
  const path = typeof location === "undefined" ? "" : location.pathname;
  return PAGE_OWNERS.find((owner) => owner.path.test(path))?.namespaces[namespace];
}

/** A namespace or method nobody implements answers 501, so the page shows its failed read. */
function unimplemented(path: string) {
  return () => Promise.reject(new ApiError(501, "not_implemented", `frame harness does not implement api.${path}`));
}

export const api = new Proxy(merged, {
  get(target, namespace: string) {
    const ns = owned(namespace) ?? target[namespace] ?? {};
    return new Proxy(ns, {
      get(inner, method: string) {
        return method in inner ? inner[method] : unimplemented(`${namespace}.${method}`);
      },
    });
  },
}) as unknown as typeof netplat;
