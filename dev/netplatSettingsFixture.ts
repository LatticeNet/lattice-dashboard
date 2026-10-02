/**
 * Settings and Notifications fixtures for the netplat harness
 * (dev/netplat-access.html, netplat-about.html, netplat-capabilities.html,
 * netplat-notifications.html).
 *
 * Production on 2026-09-30: 1 user, 0 access tokens, 34 machine profiles of
 * which 8 are free, 2 notify channels and 4 rules (netplatWebhooksFixture).
 * FACTS.md holds no SSO count, so the default has no provider. Whether the
 * one user has two-factor on, the build numbers and the capability counts
 * are invented to production's shape.
 *
 *   ?access=dense     8 users, 9 tokens (3 revoked, 2 confined to nodes) and
 *                     2 providers, all invented
 *   ?access=empty     no users, tokens or providers: the empty states (a real
 *                     server always has at least the operator who signed in)
 *   ?build=mismatch   the server bundles a newer dashboard than this tab runs,
 *                     the state right after a deploy in a tab left open
 *   ?build=unknown    a dev build: neither side carries a commit
 */
import type { BuildInfo, CapabilityImpact, MachineView, OIDCProviderView, TokenView, UserView } from "@/lib/api/index";

import { DAY, NODES, flags, iso, nodeByName } from "./netplatFixture";

const HOME = nodeByName("[cd]-homeserver").id;
const MAC = nodeByName("[cd]-mac-air").id;
const NAS = nodeByName("[cd]-nas-home").id;
const KIX = nodeByName("[cd]-Oracle-KIX-arm");

const ACCESS = flags.get("access") ?? "prod";

const OPERATOR: UserView = {
  id: "usr_01j8cdcd0000000000000000",
  username: "cdcd",
  scopes: ["*"],
  totp_enabled: true,
  has_password: true,
  created_at: iso(-84 * DAY),
};

const DENSE_USERS: UserView[] = [
  OPERATOR,
  { id: "usr_01j9sso00000000000000001", username: "lidonggui@openjobs.ai", scopes: ["node:read", "task:read", "audit:read", "approval:read"], totp_enabled: true, has_password: false, created_at: iso(-40 * DAY) },
  { id: "usr_01j9ops00000000000000002", username: "ops-weekend", scopes: ["node:read", "node:admin", "task:read", "terminal:open"], server_allowlist: [HOME, MAC, NAS], totp_enabled: true, has_password: true, created_at: iso(-21 * DAY) },
  { id: "usr_01j9ro000000000000000003", username: "readonly-viewer", scopes: ["node:read", "audit:read"], totp_enabled: false, has_password: true, created_at: iso(-14 * DAY) },
  { id: "usr_01j9dns00000000000000004", username: "dns-bot-owner", scopes: ["dns:admin", "ddns:admin"], totp_enabled: false, has_password: true, created_at: iso(-9 * DAY) },
  { id: "usr_01j9vpn00000000000000005", username: "vpn-support@openjobs.ai", scopes: ["proxy:read", "proxy:admin"], totp_enabled: true, has_password: false, created_at: iso(-6 * DAY) },
  { id: "usr_01j9inv00000000000000006", username: "billing", scopes: ["inventory:read"], totp_enabled: false, has_password: true, created_at: iso(-3 * DAY) },
  { id: "usr_01j9new00000000000000007", username: "new-hire-2026-10", scopes: [], totp_enabled: false, has_password: true, created_at: iso(-2 * 3600_000) },
];

export const USERS: UserView[] = ACCESS === "empty" ? [] : ACCESS === "dense" ? DENSE_USERS : [OPERATOR];

const DENSE_TOKENS: TokenView[] = [
  { id: "tok_01j9ci000000000000000001", name: "github-actions deploy", actor_id: "cdcd", scopes: ["node:read", "task:read"], server_allowlist: [], created_at: iso(-30 * DAY) },
  { id: "tok_01j9bk000000000000000002", name: "nas backup reporter", actor_id: "cdcd", scopes: ["notify:send"], server_allowlist: [], created_at: iso(-28 * DAY) },
  { id: "tok_01j9mn000000000000000003", name: "grafana read", actor_id: "cdcd", scopes: ["node:read", "monitor:read"], server_allowlist: [], created_at: iso(-20 * DAY) },
  { id: "tok_01j9hm000000000000000004", name: "homeserver cron", actor_id: "ops-weekend", scopes: ["task:read"], server_allowlist: [HOME, NAS], created_at: iso(-12 * DAY) },
  { id: "tok_01j9dd000000000000000005", name: "ddns updater (old laptop)", actor_id: "dns-bot-owner", scopes: ["ddns:admin"], server_allowlist: [MAC, "node_retired_2026_08"], created_at: iso(-9 * DAY) },
  { id: "tok_01j9cl000000000000000006", name: "cli on mac-air", actor_id: "cdcd", scopes: ["*"], server_allowlist: [], created_at: iso(-5 * DAY) },
  { id: "tok_01j8rv000000000000000007", name: "leaked in a screenshot", actor_id: "cdcd", scopes: ["node:read"], server_allowlist: [], created_at: iso(-60 * DAY), revoked_at: iso(-58 * DAY) },
  { id: "tok_01j8rv000000000000000008", name: "old ci runner", actor_id: "cdcd", scopes: ["task:read"], server_allowlist: [], created_at: iso(-50 * DAY), revoked_at: iso(-31 * DAY) },
  { id: "tok_01j8rv000000000000000009", name: "", actor_id: "cdcd", scopes: ["audit:read"], server_allowlist: [], created_at: iso(-45 * DAY), revoked_at: iso(-44 * DAY) },
];

export const TOKENS: TokenView[] = ACCESS === "dense" ? DENSE_TOKENS : [];

const DENSE_PROVIDERS: OIDCProviderView[] = [
  { id: "oidc_google_workspace", display_name: "Google Workspace", issuer: "https://accounts.google.com", client_id: "123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com", has_secret: true, scopes: ["openid", "email", "profile"], allowed_domains: ["openjobs.ai"], enabled: true },
  { id: "oidc_authentik_home", display_name: "", issuer: "https://auth.home.example/application/o/lattice/", client_id: "lattice-console", has_secret: false, scopes: ["openid", "email"], allowed_domains: [], enabled: false },
];

export const PROVIDERS: OIDCProviderView[] = ACCESS === "dense" ? DENSE_PROVIDERS : [];

/**
 * The dashboard commit this harness build claims to run. The build reads
 * VITE_GIT_COMMIT, which the harness does not set, so `?build=` swaps the
 * server's answer instead: matching, newer, or unknown on both sides.
 */
export function buildInfo(tabCommit: string | undefined): BuildInfo {
  const mode = flags.get("build");
  if (mode === "unknown") {
    return { server_version: "dev", server_commit: "unknown", server_date: "unknown", dashboard_ref: "unknown" };
  }
  return {
    server_version: "alpha-0.2.2a101",
    server_commit: "ce4e9082b6d1f0a7c35e8d94b2a61f07c8d5e3a1",
    server_date: iso(-20 * 3600_000),
    dashboard_ref: mode === "mismatch" ? "0f50eba7c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6" : (tabCommit ?? "3da5b3a9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3"),
    dashboard_built: iso(-20 * 3600_000),
  };
}

/** Capability gates: production has 17 kinds; which are enforced is invented. */
export const CAPABILITIES: CapabilityImpact[] = [
  { capability: "terminal", enforced: true, mutates: true, derived: false, allow_count: 30, refuse_count: 4, refused: [{ node_id: KIX.id, name: KIX.name, reason: "excluded" }] },
  { capability: "netguard", enforced: true, mutates: true, derived: true, allow_count: 34, refuse_count: 0 },
  { capability: "sshguard", enforced: false, mutates: true, derived: true, allow_count: 34, refuse_count: 0 },
  { capability: "vpn-core", enforced: false, mutates: true, derived: true, allow_count: 24, refuse_count: 10 },
  { capability: "dns", enforced: false, mutates: true, derived: false, allow_count: 0, refuse_count: 34 },
  { capability: "tunnel", enforced: false, mutates: true, derived: false, allow_count: 0, refuse_count: 34 },
  { capability: "evidence", enforced: false, mutates: false, derived: true, allow_count: 34, refuse_count: 0 },
];

/**
 * Machine profiles: one per node (34), 8 of them free with no renewal date,
 * the rest monthly with reminders 3 and 1 days before, two with reminders
 * off. Renewal days are invented and spread over the month.
 */
export const MACHINES: MachineView[] = NODES.map((node, index) => {
  const free = index % 4 === 3 && index < 32;
  const base: MachineView = { id: `mach_${node.id}`, node_id: node.id, node_name: node.name, online: node.online ?? true, created_at: iso(-80 * DAY) };
  if (free) return base;
  const inDays = (index * 7) % 30;
  return {
    ...base,
    price_cents: 500 + (index % 6) * 300,
    currency: index % 3 === 0 ? "USD" : "CNY",
    renewal_cycle: "monthly",
    next_renewal: iso(inDays * DAY).slice(0, 10),
    days_until_renewal: inDays,
    remind_days_before: [3, 1],
    reminders_enabled: index !== 5 && index !== 11,
  };
});
