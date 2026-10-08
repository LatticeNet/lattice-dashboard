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
 *                     dns, monitors, tunnels, geo, agents, release, artifacts,
 *                     webhooks, channels, rules, deliveries, sent, users, tokens, oidc,
 *                     version, capabilities, machines, vpnusers, shares, witness
 *   ?ddns=empty       no DDNS profiles
 *   ?run=fail         a DDNS run answers 502 and records the error
 *   ?slow             every write takes 1.5 s, to see a confirm's pending state
 *   ?readonly         the session holds read scopes only
 *   ?scopes=a,b       the session holds exactly these scopes (Access layers by scope)
 *   ?users=slow       the account list answers after 1.5 s
 *   ?system=...       the System page's fixture (dev/systemFixture.ts lists its modes)
 *   ?probe=...        the outbound probe on the System page (same file)
 *
 * Page fixtures carry their own switches (netplatPolicyFixture,
 * netplatPluginsFixture, ...); each file's header lists them.
 */
import { ApiError } from "@/lib/api/client";
import type {
  DDNSUpsertRequest,
  DDNSView,
  NotifyChannelUpsertRequest,
  NotifyDeliveriesQuery,
  NotifyRuleUpsertRequest,
  OIDCProviderUpsertRequest,
  WitnessPlanRequest,
  Principal,
  TokenCreateRequest,
  UserCreateRequest,
  UserUpdateRequest,
} from "@/lib/api/index";

import { DDNS, ddnsSaveWarnings, runDdns } from "./netplatDdnsFixture";
import { GROUP_POLICIES, NODE_POLICIES, policyGraph, policyMatrix } from "./netplatPolicyFixture";
import { DECLARATIVE_PLUGIN, PLUGIN_INSTALLS, leaseRows, pluginViews } from "./netplatPluginsFixture";
import { NOTIFY_CHANNELS, NOTIFY_RULES, WEBHOOKS, deliveriesFor } from "./netplatWebhooksFixture";
import { sentPage, testStoredChannel } from "./netplatSentFixture";
import { planWitness, witnessStatus } from "./netplatWitnessFixture";
import { AGENT_APPROVALS, AGENT_ARTIFACTS, AGENT_POLICIES, AGENT_RELEASE } from "./netplatAgentFixture";
import { DNS_DEPLOYMENTS, GEO_ROUTINGS, MONITORS, TUNNELS, geoPlan } from "./netplatResolversFixture";
import { CAPABILITIES, MACHINES, PROVIDERS, TOKENS, USERS, buildInfo } from "./netplatSettingsFixture";
import { NODES, delay, flags, iso } from "./netplatFixture";
import { SUBSCRIPTION_SHARES, VPN_USERS } from "./netplatPaletteFixture";
import { probeHealth, systemHealth, systemSeries } from "./systemFixture";
import type { MetricsRange } from "@/lib/api/systemTypes";

export * from "@/lib/api/index";

const FAILING = new Set((flags.get("fail") ?? "").split(",").filter(Boolean));
// The agent fixture documents ?release=fail; it is the same switch as ?fail=release.
if (flags.get("release") === "fail") FAILING.add("release");
const WRITE_MS = flags.has("slow") ? 1500 : 200;

/** Reads by name, for a render to prove a read happened or did not (window.__harnessReads). */
const READS: Record<string, number> = ((window as unknown as { __harnessReads?: Record<string, number> }).__harnessReads = {});

function read<T>(name: string, value: () => T): Promise<T> {
  READS[name] = (READS[name] ?? 0) + 1;
  if (FAILING.has(name)) {
    return new Promise((_, reject) =>
      setTimeout(() => reject(new ApiError(502, "bad_gateway", `502 Bad Gateway from lattice.roobli.org (${name})`)), 120),
    );
  }
  return delay(value());
}

const principal: Principal = {
  // The signed-in operator is the fixture's one user, as on production.
  actor_id: USERS[0]?.id ?? "cdcd",
  username: "cdcd",
  scopes: flags.has("scopes")
    ? (flags.get("scopes") ?? "").split(",").filter(Boolean)
    : flags.has("readonly")
      ? ["node:read", "ddns:read", "netpolicy:read", "audit:read", "dns:read", "geo:read", "tunnel:read", "notify:read"]
      : ["*"],
  server_allowlist: [],
  csrf_token: "harness",
};

let seq = 100;

/** ?system=forbidden, disabled and unavailable answer the self-monitoring reads 403 and 503. */
function systemRead<T>(value: () => T): Promise<T> {
  const mode = flags.get("system");
  if (mode === "forbidden" || mode === "disabled" || mode === "unavailable") {
    READS.system = (READS.system ?? 0) + 1;
    return delay(undefined, 120).then(() => {
      // The server scrubs 5xx messages; the code is what tells the cases apart.
      throw mode === "forbidden"
        ? new ApiError(403, "capability_denied", "control-plane internals need a full administrator (scope *, no node restriction)")
        : new ApiError(503, mode === "disabled" ? "metrics_disabled" : "metrics_unavailable", "internal server error");
    });
  }
  return read("system", value);
}

export const api = {
  auth: {
    me: () => delay(principal),
  },
  system: {
    health: (range: MetricsRange) =>
      systemRead(() => ({ ...systemHealth(range, flags.get("system")), probe: probeHealth(flags.get("probe")) })),
    series: (owner: string, series: string[], range: MetricsRange, points = 360) =>
      systemRead(() => systemSeries(owner, series, range, points, flags.get("system"))),
  },
  nodes: {
    list: () => read("nodes", () => ({ nodes: NODES.map((node) => ({ ...node })) })),
  },
  /* Settings: Access (users, tokens, SSO), About, Capability Gates. */
  users: {
    // ?users=slow holds the account list for 1.5 s, to see the SSO delete confirm wait for it.
    list: () =>
      flags.get("users") === "slow"
        ? delay(undefined, 1500).then(() => read("users", () => ({ users: USERS.map((user) => ({ ...user })) })))
        : read("users", () => ({ users: USERS.map((user) => ({ ...user })) })),
    create: async (input: UserCreateRequest) => {
      await delay(undefined, WRITE_MS);
      const user = { id: `usr_new_${seq++}`, username: input.username, scopes: input.scopes, server_allowlist: input.server_allowlist, totp_enabled: false, has_password: !!input.password, created_at: iso(0) };
      USERS.push(user);
      return { ...user };
    },
    update: async (input: UserUpdateRequest) => {
      await delay(undefined, WRITE_MS);
      const user = USERS.find((entry) => entry.id === input.id);
      if (!user) throw new ApiError(404, "not_found", "user not found");
      user.scopes = input.scopes;
      if (input.server_allowlist) user.server_allowlist = input.server_allowlist;
      return { ...user };
    },
    delete: async (id: string) => {
      await delay(undefined, WRITE_MS);
      return removeById(USERS, id, "user");
    },
  },
  tokens: {
    list: () => read("tokens", () => TOKENS.map((token) => ({ ...token }))),
    create: async (input: TokenCreateRequest) => {
      await delay(undefined, WRITE_MS);
      const view = { id: `tok_new_${seq++}`, name: input.name, actor_id: "cdcd", scopes: input.scopes, server_allowlist: input.server_allowlist ?? [], created_at: iso(0) };
      TOKENS.unshift(view);
      return { id: view.id, token: "lat_pat_harness_0000000000000000000000000000", view: { ...view } };
    },
    revoke: async (id: string) => {
      await delay(undefined, WRITE_MS);
      const token = TOKENS.find((entry) => entry.id === id);
      if (!token) throw new ApiError(404, "not_found", "token not found");
      token.revoked_at = iso(0);
      return { ...token };
    },
    delete: async (id: string) => {
      await delay(undefined, WRITE_MS);
      return removeById(TOKENS, id, "token");
    },
  },
  oidc: {
    providers: () => read("oidc", () => ({ providers: PROVIDERS.map((provider) => ({ ...provider })) })),
    upsertProvider: async (input: OIDCProviderUpsertRequest) => {
      await delay(undefined, WRITE_MS);
      const existing = PROVIDERS.find((entry) => entry.id === input.id);
      const next = { id: existing?.id ?? `oidc_new_${seq++}`, display_name: input.display_name ?? "", issuer: input.issuer, client_id: input.client_id, has_secret: !!input.client_secret || !!existing?.has_secret, scopes: input.scopes, allowed_domains: input.allowed_domains, enabled: input.enabled ?? true };
      if (existing) Object.assign(existing, next);
      else PROVIDERS.push(next);
      return { ...next };
    },
    deleteProvider: async (id: string) => {
      await delay(undefined, WRITE_MS);
      removeById(PROVIDERS, id, "provider");
      return { status: "deleted" };
    },
    testProvider: async (issuer: string) => {
      await delay(undefined, 600);
      return issuer.includes("home.example")
        ? { ok: false, issuer, error: "GET https://auth.home.example/.well-known/openid-configuration: dial tcp: i/o timeout" }
        : { ok: true, issuer, authorization_endpoint: `${issuer}/o/oauth2/v2/auth`, token_endpoint: `${issuer}/token` };
    },
  },
  version: () => read("version", () => buildInfo(import.meta.env.VITE_GIT_COMMIT)),
  capabilities: {
    list: () => read("capabilities", () => ({ capabilities: CAPABILITIES.map((capability) => ({ ...capability })) })),
    setEnforced: async (capability: string, enforced: boolean) => {
      await delay(undefined, WRITE_MS);
      const entry = CAPABILITIES.find((item) => item.capability === capability);
      if (entry) entry.enforced = enforced;
      return { ok: true };
    },
  },
  machines: {
    list: () => read("machines", () => ({ machines: MACHINES.map((machine) => ({ ...machine })) })),
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
        comment_mode: input.comment_mode,
        record_comment: input.record_comment || undefined,
        record_type: input.record_type,
        cname_target: input.record_type === "cname" ? (input.cname_target ?? "").toLowerCase().replace(/\.$/, "") : input.cname_target || undefined,
        // Each record type keeps only its own status, as the server does.
        last_target: input.record_type === "cname" ? existing?.last_target : undefined,
        last_ipv4: input.record_type === "cname" ? undefined : existing?.last_ipv4,
        last_ipv6: input.record_type === "cname" ? undefined : existing?.last_ipv6,
        has_credential: existing?.has_credential || !!input.cf_api_token || !!input.webhook_url,
        webhook_url: input.webhook_url,
        webhook_method: input.webhook_method,
        updated_at: iso(0),
      } as DDNSView;
      if (existing) Object.assign(existing, next);
      else DDNS.push(next);
      const warnings = ddnsSaveWarnings(input);
      return warnings.length ? { ...next, warnings } : { ...next };
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
    releases: () => read("release", () => ({ ...AGENT_RELEASE })),
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
  notify: {
    webhooks: () => read("webhooks", () => ({ webhooks: WEBHOOKS.map((hook) => ({ ...hook })) })),
    channels: () => read("channels", () => NOTIFY_CHANNELS.map((channel) => ({ ...channel }))),
    rules: () => read("rules", () => ({ rules: NOTIFY_RULES.map((rule) => ({ ...rule })) })),
    upsertChannel: async (input: NotifyChannelUpsertRequest) => {
      await delay(undefined, WRITE_MS);
      const existing = NOTIFY_CHANNELS.find((channel) => channel.id === input.id);
      // As the server: an absent fallback keeps the channel's, "" clears it, and the channel itself is refused.
      const fallback = input.fallback_channel_id === undefined ? existing?.fallback_channel_id : input.fallback_channel_id || undefined;
      if (fallback && fallback === input.id) throw new ApiError(400, "bad_request", "a channel cannot be its own fallback");
      const next = { id: existing?.id ?? `ch_new_${seq++}`, name: input.name, kind: input.kind, config_keys: Object.keys(input.config), enabled: input.enabled ?? true, created_at: existing?.created_at ?? iso(0), updated_at: iso(0), health: existing?.health ?? { state: "unknown", consecutive_failures: 0 }, fallback_channel_id: fallback, critical_event_types: ["node.offline", "service.down", "ssh.compromise_suspected"] };
      if (existing) Object.assign(existing, next);
      else NOTIFY_CHANNELS.push(next);
      return { ...next };
    },
    deleteChannel: async (id: string) => {
      await delay(undefined, WRITE_MS);
      return removeById(NOTIFY_CHANNELS, id, "channel");
    },
    test: async () => delay({ ok: true }, 400),
    testChannel: async (id: string) => {
      await delay(undefined, flags.has("slow") ? 1500 : 500);
      if (!NOTIFY_CHANNELS.some((channel) => channel.id === id)) throw new ApiError(404, "not_found", "notification channel not found");
      return testStoredChannel(id);
    },
    witness: () => read("witness", () => witnessStatus()),
    planWitness: async (input: WitnessPlanRequest) => {
      await delay(undefined, WRITE_MS);
      return planWitness(input);
    },
    deliveries: (query: NotifyDeliveriesQuery) =>
      flags.get("sent") === "slow"
        ? delay(undefined, 4000).then(() => read("sent", () => sentPage(query)))
        : read("sent", () => sentPage(query)),
    upsertRule: async (input: NotifyRuleUpsertRequest) => {
      await delay(undefined, WRITE_MS);
      const existing = NOTIFY_RULES.find((rule) => rule.id === input.id);
      // As the server: an absent fallback keeps the rule's, "" clears it, and one of the rule's own channels is refused.
      const fallback = input.fallback_channel_id === undefined ? existing?.fallback_channel_id : input.fallback_channel_id || undefined;
      if (fallback && input.channel_ids?.includes(fallback)) throw new ApiError(400, "bad_request", "the fallback channel must differ from the rule's own channels");
      // Escalation and quiet hours: absent keeps, quiet_hours null clears (applyNotifyRuleOptions).
      const options = {
        escalation_off: input.escalation_off ?? existing?.escalation_off ?? false,
        escalate_after_minutes: input.escalate_after_minutes ?? existing?.escalate_after_minutes ?? 30,
        escalation_bark_level: input.escalation_bark_level ?? existing?.escalation_bark_level ?? "critical",
        quiet_hours: input.quiet_hours !== undefined ? input.quiet_hours : (existing?.quiet_hours ?? null),
      };
      (window as unknown as { __lastRuleRequest?: unknown }).__lastRuleRequest = input;
      const next = { id: existing?.id ?? `rule_new_${seq++}`, name: input.name, event_types: input.event_types, channel_ids: input.channel_ids, title_template: input.title_template, body_template: input.body_template, enabled: input.enabled ?? true, created_at: existing?.created_at ?? iso(0), updated_at: iso(0), fallback_channel_id: fallback, ...options };
      if (existing) Object.assign(existing, next);
      else NOTIFY_RULES.push(next);
      return { ...next };
    },
    deleteRule: async (id: string) => {
      await delay(undefined, WRITE_MS);
      return removeById(NOTIFY_RULES, id, "rule");
    },
    webhookDeliveries: (id: string) => read("deliveries", () => ({ deliveries: deliveriesFor(id) })),
    upsertWebhook: async (input: { id?: string; name: string; event_type: string; title_template: string; body_template?: string; enabled: boolean }) => {
      await delay(undefined, WRITE_MS);
      const id = input.id ?? `wh_${seq++}`;
      const existing = WEBHOOKS.find((hook) => hook.id === id);
      const next = { ...(existing ?? { created_at: iso(0), path: `/hooks/${id}` }), ...input, id, updated_at: iso(0) } as (typeof WEBHOOKS)[number];
      if (existing) Object.assign(existing, next);
      else WEBHOOKS.push(next);
      return { ...next, secret: input.id ? undefined : "whsec_harness_4f2a9c" };
    },
    deleteWebhook: async (id: string) => {
      await delay(undefined, WRITE_MS);
      return removeById(WEBHOOKS, id, "webhook");
    },
    rotateWebhookSecret: async (id: string) => {
      await delay(undefined, WRITE_MS);
      return { ...WEBHOOKS.find((hook) => hook.id === id)!, secret: "whsec_rotated_9b1e" };
    },
    testWebhook: async (id: string) => {
      await delay(undefined, WRITE_MS);
      return { id: `dl_test_${seq++}`, webhook_id: id, outcome: "accepted", test: true, fields: 0, bytes: 0, channels: 1, delivered: 1, created_at: iso(0) };
    },
  },
  approvals: {
    list: () => read("approvals", () => ({ approvals: AGENT_APPROVALS.map((approval) => ({ ...approval })) })),
  },
  /* The share list, read by the command palette (tokens included, as the server sends them). */
  subscriptionShares: {
    list: () => read("shares", () => SUBSCRIPTION_SHARES.map((share) => ({ ...share }))),
  },
  plugins: {
    list: () => read("plugins", () => pluginViews()),
    contributions: () =>
      read("contributions", () => [
        ...pluginViews().filter((plugin) => plugin.active),
        ...(flags.get("plugins") === "declarative" ? [DECLARATIVE_PLUGIN] : []),
      ]),
    call: (_id: string, service: string, method: string) => {
      // vpn-core's users/list, which the command palette reads for identities.
      if (service === "latticenet.vpn-core/users" && method === "list") {
        return read("vpnusers", () => ({ users: VPN_USERS.map((user) => ({ ...user })), count: VPN_USERS.length }));
      }
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

