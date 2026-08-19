// Canonical grantable RBAC scope catalog, kept in sync with the server's
// rbac.KnownScopes. The server is authoritative. It validates every assigned
// scope against this same set and rejects anything not within the caller's own
// grant. So this list is for the UI picker only. The global "*" superuser scope
// is handled separately (a dedicated "full administrator" toggle), not as a grid
// entry.
export const SCOPE_CATALOG = [
  "audit:read",
  "ddns:admin",
  "dns:admin",
  "geo:admin",
  "geo:read",
  "group:admin",
  "group:read",
  "inventory:admin",
  "inventory:read",
  "kv:admin",
  "kv:read",
  "kv:write",
  "log:admin",
  "log:read",
  "log:write",
  "monitor:admin",
  "monitor:read",
  "netguard:admin",
  "netguard:read",
  "netpolicy:admin",
  "netpolicy:read",
  "network:apply",
  "network:plan",
  "node:admin",
  "node:read",
  "notify:send",
  "oidc:admin",
  "plugin:admin",
  "plugin:verify",
  // Legacy grants remain visible while existing proxy-scoped tokens migrate.
  "proxy:admin",
  "proxy:read",
  "substore:admin",
  "substore:read",
  "static:admin",
  "static:read",
  "static:write",
  "task:read",
  "task:run",
  "terminal:open",
  "token:admin",
  "tunnel:admin",
  "user:admin",
  "vpncore:admin",
  "vpncore:read",
  "wireguard:admin",
  "wireguard:read",
  "worker:deploy",
] as const;

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
  if ((SCOPE_CATALOG as readonly string[]).includes(candidate)) return true;
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
