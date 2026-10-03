/**
 * VPN identities and subscription shares for the command palette in the
 * netplat harness (index.html served under vite.harness.config.ts with
 * LATTICE_HARNESS=netplat).
 *
 * The identities are vpn-core's users/list answer as lattice-server writes
 * it (vpnUserUsageView): credentials reduced to has_secret, bindings, quota
 * and usage, and an unset expiry written as Go's year-1 time. The shares are
 * the /api/subscription-shares list, tokens included, because the server
 * sends them; the palette must drop both the extra identity fields and the
 * tokens on receipt. Addresses use example.com and example.net.
 *
 * Switches: `?fail=vpnusers` and `?fail=shares` make those reads answer 502.
 */
import { DAY, iso } from "./netplatFixture";

const NO_EXPIRY = "0001-01-01T00:00:00Z";

function identity(id: string, email: string, extra: { name?: string; enabled?: boolean; expires?: string; group?: string } = {}) {
  return {
    id,
    email,
    name: extra.name,
    enabled: extra.enabled ?? true,
    credentials: [
      { protocol: "vless", flow: "xtls-rprx-vision", has_secret: true },
      { protocol: "hysteria2", has_secret: true },
    ],
    bindings: [{ line_hash_id: "line_hk_reality", enabled: true }],
    quota_bytes: 200 * 1024 ** 3,
    quota_period: "monthly",
    expires_at: extra.expires ?? NO_EXPIRY,
    group: extra.group,
    migrated: false,
    created_at: iso(-120 * DAY),
    updated_at: iso(-3 * DAY),
    used_bytes: 41 * 1024 ** 3,
  };
}

export const VPN_USERS = [
  identity("vpnuser_01j8cdcd0a1", "cdcd@example.com", { name: "cdcd phone", group: "own" }),
  identity("vpnuser_01j8cdcd0a2", "cdcd-laptop@example.com", { name: "cdcd laptop", group: "own" }),
  identity("vpnuser_01j8cdcd0a3", "cdcd-router@example.com", { name: "home router", group: "own" }),
  identity("vpnuser_01j8cdcd0a4", "alice@example.net", { name: "Alice", group: "family", expires: iso(40 * DAY) }),
  identity("vpnuser_01j8cdcd0a5", "bob@example.net", { name: "Bob", group: "family", expires: iso(-2 * DAY) }),
  identity("vpnuser_01j8cdcd0a6", "travel-ipad@example.com", { name: "travel iPad", enabled: false }),
  identity("vpnuser_01j8cdcd0a7", "metix-ops@example.com", { group: "metix" }),
  identity("vpnuser_01j8cdcd0a8", "metix-ci@example.com", { group: "metix", expires: iso(9 * DAY) }),
];

export const SUBSCRIPTION_SHARES = [
  { id: "share_01j8family", slug: "family-clash", token: "tok_harness_9f2c1a7e", source: { kind: "proxy_user", proxy_user_id: "pu_family" }, enabled: true, created_at: iso(-60 * DAY), updated_at: iso(-1 * DAY) },
  { id: "share_01j8travel", slug: "travel", token: "tok_harness_51be09d4", source: { kind: "plugin", plugin_id: "latticenet.sub-store", subscription_id: "sub_travel" }, enabled: false, created_at: iso(-30 * DAY), updated_at: iso(-30 * DAY) },
  { id: "share_01j8openjobs", slug: "merge-openjobs", token: "tok_harness_c3d4e5f6", source: { kind: "plugin", plugin_id: "latticenet.sub-store", subscription_id: "sub_merge_openjobs" }, enabled: true, created_at: iso(-20 * DAY), updated_at: iso(-2 * DAY), expires_at: iso(-1 * DAY) },
  { id: "share_01j8cdcdall", slug: "cdcd-all", token: "tok_harness_0a1b2c3d", source: { kind: "core", core_source: "vpn-core" }, enabled: true, created_at: iso(-90 * DAY), updated_at: iso(-5 * DAY) },
];
