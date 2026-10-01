/**
 * An in-memory stand-in for `@/lib/api`, wired in by vite.harness.config.ts
 * through a resolve alias so the production config and bundle never see it.
 *
 *   LATTICE_HARNESS=netplat pnpm exec vite --config vite.harness.config.ts
 *   open http://127.0.0.1:5185/dev/netplat-ddns.html
 *
 * The pages of design 23, sections 4.4 to 4.6, that had no harness. Only the
 * calls those pages make are implemented; anything else throws, loudly, so a
 * new call path is noticed rather than silently fed nothing.
 *
 * Fixture switches, on the page's query string:
 *
 *   ?fail=ddns,nodes  the named reads answer 502 (a failed read shows no counts);
 *                     names: nodes, ddns, netpolicy, matrix, groupPolicy, graph, plugins,
 *                     dns, monitors, tunnels, geo, agents, release, artifacts
 *   ?ddns=empty       no DDNS profiles
 *   ?run=fail         a DDNS run answers 502 and records the error
 *   ?slow             every write takes 1.5 s, to see a confirm's pending state
 *   ?readonly         the session holds read scopes only
 *
 * Page fixtures carry their own switches (netplatPolicyFixture,
 * netplatPluginsFixture, ...); each file's header lists them.
 */
import { ApiError } from "@/lib/api/client";
import type { DDNSUpsertRequest, DDNSView, Principal } from "@/lib/api/index";

import { DDNS, runDdns } from "./netplatDdnsFixture";
import { GROUP_POLICIES, NODE_POLICIES, policyGraph, policyMatrix } from "./netplatPolicyFixture";
import { DECLARATIVE_PLUGIN, PLUGIN_INSTALLS, leaseRows, pluginViews } from "./netplatPluginsFixture";
import { AGENT_APPROVALS, AGENT_ARTIFACTS, AGENT_POLICIES, AGENT_RELEASE } from "./netplatAgentFixture";
import { DNS_DEPLOYMENTS, GEO_ROUTINGS, MONITORS, TUNNELS, geoPlan } from "./netplatResolversFixture";
import { NODES, delay, flags, iso } from "./netplatFixture";

export * from "@/lib/api/index";

const FAILING = new Set((flags.get("fail") ?? "").split(",").filter(Boolean));
const WRITE_MS = flags.has("slow") ? 1500 : 200;

function read<T>(name: string, value: () => T): Promise<T> {
  if (FAILING.has(name)) {
    return new Promise((_, reject) =>
      setTimeout(() => reject(new ApiError(502, "bad_gateway", `502 Bad Gateway from lattice.roobli.org (${name})`)), 120),
    );
  }
  return delay(value());
}

const principal: Principal = {
  actor_id: "cdcd",
  username: "cdcd",
  scopes: flags.has("readonly")
    ? ["node:read", "ddns:read", "netpolicy:read", "audit:read", "dns:read", "geo:read", "tunnel:read", "notify:read"]
    : ["*"],
  server_allowlist: [],
  csrf_token: "harness",
};

let seq = 100;

export const api = {
  auth: {
    me: () => delay(principal),
  },
  nodes: {
    list: () => read("nodes", () => ({ nodes: NODES.map((node) => ({ ...node })) })),
  },
  ddns: {
    list: () => read("ddns", () => DDNS.map((profile) => ({ ...profile }))),
    save: async (input: DDNSUpsertRequest) => {
      await delay(undefined, WRITE_MS);
      const existing = DDNS.find((profile) => profile.id === input.id);
      const next: DDNSView = {
        ...(existing ?? {
          id: `ddns_new_${seq++}`,
          has_credential: false,
          created_at: iso(0),
        }),
        name: input.name,
        node_id: input.node_id,
        provider: input.provider,
        domains: input.domains,
        enable_ipv4: input.enable_ipv4,
        enable_ipv6: input.enable_ipv6,
        ttl: input.ttl ?? 60,
        max_retries: input.max_retries ?? 3,
        interval_seconds: input.interval_seconds,
        has_credential: existing?.has_credential || !!input.cf_api_token || !!input.webhook_url,
        webhook_url: input.webhook_url,
        webhook_method: input.webhook_method,
        updated_at: iso(0),
      } as DDNSView;
      if (existing) Object.assign(existing, next);
      else DDNS.push(next);
      return { ...next };
    },
    delete: async (id: string) => {
      await delay(undefined, WRITE_MS);
      const at = DDNS.findIndex((profile) => profile.id === id);
      if (at < 0) throw new ApiError(404, "not_found", "ddns profile not found");
      DDNS.splice(at, 1);
      return { ok: true };
    },
    run: async (id: string) => {
      await delay(undefined, WRITE_MS);
      try {
        return runDdns(id);
      } catch (error) {
        throw new ApiError(502, "bad_gateway", error instanceof Error ? error.message : String(error));
      }
    },
  },
  netpolicy: {
    list: () => read("netpolicy", () => ({ policies: NODE_POLICIES.map((policy) => ({ ...policy })) })),
    matrix: (direction: "egress" | "ingress" = "egress") => read("matrix", () => policyMatrix(direction)),
    graph: () => read("graph", () => policyGraph()),
    plan: async (nodeId: string) => {
      await delay(undefined, WRITE_MS);
      return planApproval("netpolicy", "netpolicy.apply", nodeId);
    },
    upsert: async (input: { target_node_id: string; enabled: boolean; rules: unknown[] }) => {
      await delay(undefined, WRITE_MS);
      const existing = NODE_POLICIES.find((policy) => policy.target_node_id === input.target_node_id);
      if (existing) Object.assign(existing, { enabled: input.enabled, rules: input.rules, updated_at: iso(0) });
      else
        NODE_POLICIES.push({
          id: `np_${input.target_node_id}`,
          target_node_id: input.target_node_id,
          target_node_name: NODES.find((node) => node.id === input.target_node_id)?.name,
          enabled: input.enabled,
          rules: input.rules as never,
          updated_at: iso(0),
        });
      return NODE_POLICIES.find((policy) => policy.target_node_id === input.target_node_id)!;
    },
    delete: async (nodeId: string) => {
      await delay(undefined, WRITE_MS);
      const at = NODE_POLICIES.findIndex((policy) => policy.target_node_id === nodeId);
      if (at < 0) throw new ApiError(404, "not_found", "policy not found");
      NODE_POLICIES.splice(at, 1);
      return { ok: true };
    },
  },
  groupPolicy: {
    list: () => read("groupPolicy", () => ({ policies: GROUP_POLICIES.map((policy) => ({ ...policy })) })),
    upsert: async (input: unknown) => {
      await delay(undefined, WRITE_MS);
      return input;
    },
    plan: async () => {
      await delay(undefined, WRITE_MS);
      return { affected: [], conflicts: [], orphaned: [] };
    },
  },
  dns: {
    deployments: () => read("dns", () => ({ deployments: DNS_DEPLOYMENTS.map((dep) => ({ ...dep })) })),
    upsert: async (input: { id?: string }) => {
      await delay(undefined, WRITE_MS);
      return input;
    },
    delete: async (id: string) => {
      await delay(undefined, WRITE_MS);
      return removeById(DNS_DEPLOYMENTS, id, "deployment");
    },
    plan: async (id: string) => {
      await delay(undefined, WRITE_MS);
      const dep = DNS_DEPLOYMENTS.find((entry) => entry.id === id)!;
      return { approval: planApproval("dns", "dns.apply", dep.node_id), findings: [] };
    },
    publish: async (id: string) => {
      await delay(undefined, WRITE_MS);
      const dep = DNS_DEPLOYMENTS.find((entry) => entry.id === id)!;
      const node = NODES.find((entry) => entry.id === dep.node_id);
      dep.last_published_at = iso(0);
      dep.last_publish_error = undefined;
      return { ipv4: node?.public_ip ?? "", ipv6: node?.public_ipv6 ?? "" };
    },
  },
  monitors: {
    list: () => read("monitors", () => ({ monitors: MONITORS.map((monitor) => ({ ...monitor })) })),
  },
  tunnels: {
    list: () => read("tunnels", () => TUNNELS.map((tunnel) => ({ ...tunnel }))),
    create: async (input: Omit<(typeof TUNNELS)[number], "id" | "created_at" | "updated_at">) => {
      await delay(undefined, WRITE_MS);
      const next = { ...input, id: `tun_${seq++}`, created_at: iso(0), updated_at: iso(0) };
      TUNNELS.push(next);
      return next;
    },
    delete: async (id: string) => {
      await delay(undefined, WRITE_MS);
      return removeById(TUNNELS, id, "tunnel");
    },
    plan: async (id: string) => {
      await delay(undefined, WRITE_MS);
      const tunnel = TUNNELS.find((entry) => entry.id === id)!;
      return { ...planApproval("tunnel", "tunnel.apply", tunnel.node_id), node_id: tunnel.node_id };
    },
  },
  geoRouting: {
    list: () => read("geo", () => ({ geo_routings: GEO_ROUTINGS.map((routing) => ({ ...routing })) })),
    upsert: async (input: { id?: string }) => {
      await delay(undefined, WRITE_MS);
      return input;
    },
    delete: async (id: string) => {
      await delay(undefined, WRITE_MS);
      return removeById(GEO_ROUTINGS, id, "geo routing");
    },
    plan: async (id: string) => {
      await delay(undefined, WRITE_MS);
      return geoPlan(id);
    },
  },
  agentUpdates: {
    list: () => read("agents", () => ({ policies: AGENT_POLICIES.map((policy) => ({ ...policy })) })),
    releases: () => read(flags.get("release") === "fail" ? "release-fail" : "release", () => ({ ...AGENT_RELEASE })),
    artifacts: () => read("artifacts", () => ({ ...AGENT_ARTIFACTS, artifacts: AGENT_ARTIFACTS.artifacts.map((a) => ({ ...a })) })),
    plan: async (nodeId: string) => {
      await delay(undefined, WRITE_MS);
      const node = NODES.find((entry) => entry.id === nodeId);
      if (node?.agent_version === AGENT_RELEASE.latest_version) {
        throw new ApiError(409, "agent_update_noop", `${node.name} already runs ${node.agent_version}`);
      }
      return planApproval("agentupdate", "agent.update", nodeId);
    },
    upsert: async (input: { node_id: string }) => {
      await delay(undefined, WRITE_MS);
      return input;
    },
    delete: async (nodeId: string) => {
      await delay(undefined, WRITE_MS);
      const at = AGENT_POLICIES.findIndex((policy) => policy.node_id === nodeId);
      if (at >= 0) AGENT_POLICIES.splice(at, 1);
      return { ok: true };
    },
    importArtifact: async () => {
      await delay(undefined, WRITE_MS);
      return AGENT_ARTIFACTS.artifacts[0];
    },
    deleteArtifact: async () => {
      await delay(undefined, WRITE_MS);
      return { deleted: true, sha256: "" };
    },
  },
  approvals: {
    list: () => read("approvals", () => ({ approvals: AGENT_APPROVALS.map((approval) => ({ ...approval })) })),
  },
  plugins: {
    list: () => read("plugins", () => pluginViews()),
    contributions: () =>
      read("contributions", () => [
        ...pluginViews().filter((plugin) => plugin.active),
        ...(flags.get("plugins") === "declarative" ? [DECLARATIVE_PLUGIN] : []),
      ]),
    call: (_id: string, _service: string, method: string) => {
      if (method === "list") return read("leases", () => leaseRows());
      return delay({ ok: true }, WRITE_MS);
    },
    trust: () => delay({ non_official: false, publishers: ["latticenet"], allow_unsigned_host_risk: false }),
    lifecycle: () => read("plugins", () => PLUGIN_INSTALLS.map((install) => ({ ...install }))),
    setLifecycle: async (id: string, status: string) => {
      await delay(undefined, WRITE_MS);
      const install = PLUGIN_INSTALLS.find((entry) => entry.id === id);
      if (!install) throw new ApiError(404, "not_found", "plugin not found");
      install.status = status;
      install.updated_at = iso(0);
      if (status === "disabled") {
        install.disabled_at = iso(0);
        install.runtime = { plugin_id: id, state: "stopped", runner: "wasm", stopped_at: iso(0), updated_at: iso(0) };
      } else if (status === "active") {
        install.activated_at = iso(0);
        install.runtime = { plugin_id: id, state: "armed", runner: "wasm", started_at: iso(0), updated_at: iso(0) };
      }
      return { ...install };
    },
  },
};

function removeById<T extends { id: string }>(list: T[], id: string, what: string) {
  const at = list.findIndex((entry) => entry.id === id);
  if (at < 0) throw new ApiError(404, "not_found", `${what} not found`);
  list.splice(at, 1);
  return { ok: true };
}

/** A pending approval shaped like the server's, for the plan dialogs. */
function planApproval(plugin: string, action: string, nodeId: string) {
  const node = NODES.find((entry) => entry.id === nodeId);
  return {
    id: `appr_${seq++}`,
    status: "pending",
    plugin,
    action,
    target_node_ids: [nodeId],
    plan: `# ${action} for ${node?.name ?? nodeId}\ntable inet lattice {\n  chain input { type filter hook input priority 0; policy accept; }\n}\n`,
    created_at: iso(0),
  };
}

