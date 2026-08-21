// Canonical grantable RBAC scope catalog, kept in sync with the server's
// rbac.KnownScopes. The server is authoritative. It validates every assigned
// scope against this same set and rejects anything not within the caller's own
// grant. So this list is for the UI picker only. The global "*" superuser scope
// is handled separately (a dedicated "full administrator" toggle), not as a grid
// entry.
//
// The catalog is defined as groups rather than a flat list because sixty
// checkbox labels in two columns is not a permission model anyone can reason
// about. Grouping by resource, and saying in one line what each scope grants,
// is what makes it possible to see what a token can do before issuing it.
//
// Each scope carries a `grants` line written from the holder's point of view,
// and, where the resource's scopes do not follow the plain read/admin pair, a
// `note` saying so. Those notes are not decoration: the split is genuinely
// inconsistent across resources and an operator picking scopes needs to know
// where. See SCOPE_MODEL_GAPS below for the collected list.

export type ScopeEntry = {
  scope: string;
  grants: string;
  /** Set when this scope departs from the plain read/admin pair. */
  note?: string;
  /** Set for scopes that are dangerous out of proportion to their name. */
  sensitive?: boolean;
};

export type ScopeGroup = {
  /** Resource key, used for the i18n label and as the group id. */
  id: string;
  label: string;
  summary: string;
  scopes: ScopeEntry[];
};

export const SCOPE_GROUPS: readonly ScopeGroup[] = [
  {
    id: "node",
    label: "Nodes",
    summary: "The servers themselves: enrollment, identity, lifecycle.",
    scopes: [
      { scope: "node:read", grants: "List nodes and read their status, addresses and duplicate report." },
      {
        scope: "node:admin",
        grants: "Enroll, rename, disable, rotate tokens for and delete nodes.",
        sensitive: true,
        note: "Also appends a node into a group at enroll time, which group:admin otherwise governs.",
      },
      { scope: "inventory:read", grants: "Read the machine inventory: vendor, cost, renewal dates." },
      { scope: "inventory:admin", grants: "Edit machines and vendors, run renewal reminders, reveal purchase links." },
    ],
  },
  {
    id: "network",
    label: "Network planning",
    summary:
      "The verb axis. These pair with a resource scope: planning a firewall needs network:plan and netpolicy:admin both.",
    scopes: [
      {
        scope: "network:plan",
        grants: "Compile a plan and file it for review. Nothing reaches a node.",
        note: "A verb, not a resource. It crosses every network resource rather than naming one.",
      },
      {
        scope: "network:apply",
        grants: "Approve a reviewed plan and queue it onto the node.",
        sensitive: true,
        note: "This is the scope that changes a live server. network:plan alone cannot.",
      },
    ],
  },
  {
    id: "netpolicy",
    label: "Network policy",
    summary: "Node-to-node reachability rules, and the group policies that expand into them.",
    scopes: [
      { scope: "netpolicy:read", grants: "Read policies, the reachability matrix and the policy graph." },
      { scope: "netpolicy:admin", grants: "Author node and group policies, and plan them." },
    ],
  },
  {
    id: "netguard",
    label: "NetGuard firewall",
    summary: "Zones, security groups and the per-node firewall binding.",
    scopes: [
      { scope: "netguard:read", grants: "Read zones, groups, bindings and the compiled review for a node." },
      {
        scope: "netguard:admin",
        grants: "Edit zones and groups, adopt nodes, and plan a node's firewall.",
        sensitive: true,
        note: "Zones and groups are fleet-wide, so these actions require an unrestricted node allowlist.",
      },
    ],
  },
  {
    id: "wireguard",
    label: "WireGuard mesh",
    summary: "The overlay between nodes.",
    scopes: [
      { scope: "wireguard:read", grants: "Read each node's mesh address, public key and endpoint." },
      {
        scope: "wireguard:admin",
        grants: "Plan a node's mesh configuration.",
        note: "Planning also requires wireguard:read on every other member, because the config names them all.",
      },
    ],
  },
  {
    id: "proxy",
    label: "Proxy and lines",
    summary:
      "Inbounds, VPN users, subscription delivery and the sing-box lines behind them. Fleet-wide objects, so most of this requires an unrestricted node allowlist.",
    scopes: [
      { scope: "proxy:read", grants: "Read inbounds, profiles, VPN users and usage." },
      {
        scope: "proxy:admin",
        grants: "Edit inbounds and users, reveal credentials, and manage subscription shares.",
        sensitive: true,
        note: "Reveals plaintext credentials and share tokens. Requires an unrestricted node allowlist.",
      },
      { scope: "vpncore:read", grants: "Read through the vpn-core plugin. Interchangeable with proxy:read." },
      { scope: "vpncore:admin", grants: "Administer through the vpn-core plugin. Interchangeable with proxy:admin." },
      {
        scope: "substore:read",
        grants: "Read sub-store subscriptions and shares.",
        note: "A proxy:read grant satisfies this too, during the migration. The reverse does not hold.",
      },
      { scope: "substore:admin", grants: "Administer sub-store subscriptions, scripts and shares.", sensitive: true },
    ],
  },
  {
    id: "dns",
    label: "DNS and routing",
    summary: "Names pointing at nodes: dynamic DNS, self-hosted zones, and geo steering.",
    scopes: [
      {
        scope: "ddns:admin",
        grants: "Manage dynamic DNS profiles, including their provider credentials, and run them.",
        sensitive: true,
        note: "No ddns:read exists, so seeing the profile list requires the scope that can change it.",
      },
      {
        scope: "dns:admin",
        grants: "Manage self-hosted DNS deployments, plan and publish zones.",
        note: "No dns:read exists, so seeing deployments requires the scope that can publish them.",
      },
      { scope: "geo:read", grants: "Read geo-routing records and plan one." },
      { scope: "geo:admin", grants: "Create, edit and delete geo-routing records." },
      {
        scope: "tunnel:admin",
        grants: "Manage Cloudflare tunnel profiles and plan them.",
        note: "No tunnel:read exists.",
      },
    ],
  },
  {
    id: "ops",
    label: "Operations",
    summary: "Running things on nodes and watching what happens.",
    scopes: [
      { scope: "task:read", grants: "Read task history and results." },
      {
        scope: "task:run",
        grants: "Queue, cancel and rerun tasks on a node.",
        sensitive: true,
        note: "Tasks execute a script on the node. Treat this as close to shell access.",
      },
      {
        scope: "terminal:open",
        grants: "Open an interactive terminal session on a node.",
        sensitive: true,
        note: "This is shell access. There is no read-only variant.",
      },
      { scope: "monitor:read", grants: "Read monitors and their results." },
      { scope: "monitor:admin", grants: "Create, edit and delete monitors." },
      { scope: "log:read", grants: "Query logs and log statistics." },
      { scope: "log:write", grants: "Ship log lines into the server." },
      {
        scope: "log:admin",
        grants: "Manage log sources, including deleting them.",
        note: "Three levels here (read, write, admin) where most resources have two.",
      },
      { scope: "worker:deploy", grants: "Deploy and run edge workers.", note: "No worker:read exists." },
      { scope: "notify:send", grants: "Manage notification channels and rules, and send test notifications.", note: "Named for a verb, but it governs channel and rule administration too." },
    ],
  },
  {
    id: "storage",
    label: "Storage",
    summary: "The key-value and static object stores, and the tokens that reach them.",
    scopes: [
      { scope: "kv:read", grants: "Read key-value entries." },
      { scope: "kv:write", grants: "Write and delete key-value entries." },
      {
        scope: "kv:admin",
        grants: "Manage buckets, bindings and storage tokens.",
        note: "Three levels here (read, write, admin) where most resources have two.",
      },
      { scope: "static:read", grants: "Read static objects." },
      { scope: "static:write", grants: "Upload and delete static objects." },
      { scope: "static:admin", grants: "Manage static buckets, bindings and storage tokens." },
    ],
  },
  {
    id: "platform",
    label: "Platform and access",
    summary: "Who can reach the console, what runs inside it, and what it recorded.",
    scopes: [
      {
        scope: "user:admin",
        grants: "Create, edit and delete operator accounts and their scopes.",
        sensitive: true,
        note: "A user account carries no node allowlist, so this requires an unrestricted one. No user:read exists.",
      },
      {
        scope: "token:admin",
        grants: "Create, revoke and delete API tokens.",
        sensitive: true,
        note: "A token may only be issued with scopes and an allowlist the issuer already holds. No token:read exists.",
      },
      { scope: "oidc:admin", grants: "Configure SSO providers.", sensitive: true, note: "No oidc:read exists." },
      { scope: "group:read", grants: "Read groups and preview a selector against the fleet." },
      {
        scope: "group:admin",
        grants: "Create groups and move nodes in and out of them.",
        note: "Membership drives group policy, so this changes which firewall applies to a node.",
      },
      { scope: "plugin:admin", grants: "Install, enable, disable and invoke plugins.", sensitive: true },
      { scope: "plugin:verify", grants: "Verify a plugin bundle's signature without installing it." },
      {
        scope: "audit:read",
        grants: "Read the audit log, verify its chain, and list installed plugins.",
        note: "There is no audit:admin, by design: the log is append-only. It also gates the plugin listing, which belongs with plugin.",
      },
    ],
  },
] as const;

/**
 * Where the read/admin split is not consistent, collected so the picker can say
 * so rather than leaving each operator to discover it. Every entry here is a
 * property of the server's scope model, not of this file.
 */
export const SCOPE_MODEL_GAPS = [
  "ddns, dns, tunnel, token, user and oidc have an admin scope with no read counterpart, so seeing those lists requires the scope that can change them.",
  "kv, log and static have three levels (read, write, admin) where every other resource has two.",
  "network:plan and network:apply are verbs that cross resources rather than naming one, so a network action needs a verb scope and a resource scope together.",
  "notify:send is named for a verb but governs channel and rule administration.",
  "audit:read gates the installed plugin listing, which belongs with plugin rather than audit.",
  "terminal:open and task:run are effectively shell access on a node and have no read-only variant.",
  "A proxy grant satisfies vpncore and substore during the migration; the reverse does not hold.",
] as const;

export const SCOPE_CATALOG = SCOPE_GROUPS.flatMap((group) => group.scopes.map((entry) => entry.scope));

/** Lookup from scope string to its catalog entry. */
export const SCOPE_INDEX: ReadonlyMap<string, ScopeEntry & { groupId: string; groupLabel: string }> = new Map(
  SCOPE_GROUPS.flatMap((group) =>
    group.scopes.map(
      (entry) => [entry.scope, { ...entry, groupId: group.id, groupLabel: group.label }] as const,
    ),
  ),
);

function directlyAllowsScope(grantedScopes: readonly string[], required: string): boolean {
  return grantedScopes.some((scope) =>
    scope === "*" ||
    scope === required ||
    (scope.endsWith(":*") && required.startsWith(scope.slice(0, -1))),
  );
}

/**
 * Runtime authorization compatibility for the proxy scope migration. This must
 * stay aligned with server rbac.scopeAllowed: legacy proxy grants reach both
 * migrated plugins, while only vpn-core bridges back to native proxy APIs.
 */
export function allowsRuntimeScope(grantedScopes: readonly string[], required: string): boolean {
  if (directlyAllowsScope(grantedScopes, required)) return true;

  switch (required) {
    case "proxy:read":
      return directlyAllowsScope(grantedScopes, "vpncore:read");
    case "proxy:admin":
      return directlyAllowsScope(grantedScopes, "vpncore:admin");
    case "vpncore:read":
    case "substore:read":
      return directlyAllowsScope(grantedScopes, "proxy:read");
    case "vpncore:admin":
    case "substore:admin":
      return directlyAllowsScope(grantedScopes, "proxy:admin");
    default:
      return false;
  }
}

function isGrantableScopeCandidate(candidate: string): boolean {
  if (SCOPE_CATALOG.includes(candidate)) return true;
  if (!candidate.endsWith(":*")) return false;
  const prefix = candidate.slice(0, -1);
  return SCOPE_CATALOG.some((scope) => scope.startsWith(prefix));
}

/**
 * Directed delegation for the proxy scope migration. Legacy proxy grants may
 * mint equal-strength canonical scopes, but canonical domains cannot delegate
 * proxy scopes or each other. The global "*" candidate is handled separately
 * by the full-admin UI.
 */
export function allowsScopeGrant(grantedScopes: readonly string[], candidate: string): boolean {
  if (!isGrantableScopeCandidate(candidate)) return false;
  if (directlyAllowsScope(grantedScopes, candidate)) return true;

  switch (candidate) {
    case "vpncore:read":
    case "substore:read":
      return directlyAllowsScope(grantedScopes, "proxy:read");
    case "vpncore:admin":
    case "substore:admin":
      return directlyAllowsScope(grantedScopes, "proxy:admin");
    case "vpncore:*":
    case "substore:*":
      return directlyAllowsScope(grantedScopes, "proxy:*");
    default:
      return false;
  }
}
