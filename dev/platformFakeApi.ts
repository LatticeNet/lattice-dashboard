/**
 * An in-memory stand-in for `@/lib/api`, wired in by vite.harness.config.ts
 * through a resolve alias so the production config and bundle never see it.
 *
 *   LATTICE_HARNESS=platform pnpm exec vite --config vite.harness.config.ts
 *   open http://127.0.0.1:5185/dev/platform.html
 *
 * Everything the real barrel exports is re-exported unchanged; only `api` is
 * replaced, and only the calls Publishing and Store make are
 * implemented. Anything else throws, loudly, so a new call path is noticed
 * rather than silently fed nothing. Evidence has its own fake
 * (evidenceFakeApi.ts).
 *
 * The fixture is production's actual shape, because that is the shape the
 * two pages were wrong about:
 *
 * - Publishing holds one reserved subscription share that is serving, which is
 *   exactly what lattice.roobli.org answers with today, plus a static site and
 *   a KV route so the access legend has all three modes to explain.
 * - Store holds the server's line identity map (vpnmeta/lineuuid, 313 entries),
 *   Sub-Store's plugin bucket and one operator bucket, so the page can be
 *   checked for who it says wrote a bucket and which controls it offers.
 */
import { ApiError } from "@/lib/api/client";
import type {
  KVEntry,
  PluginView,
  Principal,
  ProxyUserView,
  SubscriptionShareView,
  PublishingRecord,
  StaticObject,
  StorageBinding,
  StorageBucket,
  StorageBucketInventoryEntry,
  StorageKind,
  StorageTokenView,
} from "@/lib/api/index";

export * from "@/lib/api/index";

/**
 * Fixture switches, so the states that only differ in what the server answered
 * can be checked without editing this file:
 *
 *   ?empty-plane      Publishing answers with no route at all (first run).
 *   ?no-origins       Publishing answers with no origin the caller may see,
 *                     which is what the server returns for an operator holding
 *                     none of kv:admin, kv:read, static:admin, static:read.
 *   ?token-writer     A storage token can write the operator's own bucket.
 *   ?no-admin         The caller holds no kv:admin or static:admin, so the
 *                     console cannot read the token list at all.
 *   ?storage-fail     Deleting a host binding and revoking a storage token
 *                     answer 500 after 1.5 s, so the confirm dialog's pending
 *                     and failure states can be driven. Without it they
 *                     succeed after the same 1.5 s.
 *   ?share-expiring   The cd-self share expires in 5 days (invented).
 *   ?share-expired    ... expired 2 days ago (invented).
 *   ?shares-fail      The share list answers 502.
 *   ?store-fail       Store's bucket read answers 502 (a failed read shows no count).
 *   ?store-empty      Store has no bucket of either kind (first run).
 *
 * Shares: production's one share (cd-self, rendered by Sub-Store from the
 * merge-openjobs record), with its token invented. Proxy users and the
 * Sub-Store record list are the shapes the share form reads.
 */
const flags = new URLSearchParams(location.search);
const EMPTY_PLANE = flags.has("empty-plane");
const NO_ORIGINS = flags.has("no-origins");
const TOKEN_WRITER = flags.has("token-writer");
const NO_ADMIN = flags.has("no-admin");
const STORAGE_FAIL = flags.has("storage-fail");
const SHARE_EXPIRING = flags.has("share-expiring");
const SHARE_EXPIRED = flags.has("share-expired");
const SHARES_FAIL = flags.has("shares-fail");
const STORE_FAIL = flags.has("store-fail");
const STORE_EMPTY = flags.has("store-empty");
const STORAGE_WRITE_MS = 1500;

const NOW = Date.now();
const DAY = 86_400_000;
const LATENCY_MS = 140;

function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function delay<T>(value: T, ms = LATENCY_MS): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

const principal: Principal = {
  actor_id: "cdcd",
  username: "cdcd",
  scopes: [
    "kv:read",
    "kv:write",
    "static:read",
    "static:write",
    "log:read",
    "log:admin",
    "node:read",
    "user:admin",
    // Reading the storage token list needs these, and an operator without them
    // is the case where the console cannot tell who writes a bucket.
    ...(NO_ADMIN ? [] : ["kv:admin", "static:admin"]),
    "proxy:admin",
    "proxy:read",
    "audit:read",
  ],
  server_allowlist: [],
  csrf_token: "harness",
};

/* ----------------------------- publishing ------------------------------ */

const records: PublishingRecord[] = [
  {
    id: "bind_kv_1",
    origin: "kv",
    bucket: "edge-config",
    hostname: "config.roobli.org",
    any_host: false,
    path_prefix: "v1",
    enabled: true,
    reserved: false,
    admin_scope: "kv:admin",
  },
  {
    id: "bind_static_1",
    origin: "static",
    bucket: "site",
    hostname: "docs.roobli.org",
    any_host: false,
    enabled: true,
    reserved: false,
    admin_scope: "static:admin",
  },
  // Production's only record: the live cd-self share, reserved by the server
  // because the operator cannot move or delete the mount from this page.
  {
    id: "share_cd_self",
    origin: "plugin",
    bucket: "shr_cd_self",
    share_id: "shr_cd_self",
    hostname: "",
    any_host: true,
    path_prefix: "sub/cd-self",
    enabled: true,
    reserved: true,
    admin_scope: "plugin:latticenet.sub-store",
  },
];

/* -------------------------------- shares ------------------------------- */

const shares: SubscriptionShareView[] = [
  {
    id: "shr_cd_self",
    slug: "cd-self",
    token: "st_9f2c41d07a6e4b8c93d15e0f",
    source: { kind: "plugin", plugin_id: "latticenet.sub-store", subscription_id: "merge-openjobs" },
    default_format: "sing-box",
    enabled: true,
    created_at: iso(-21 * DAY),
    updated_at: iso(-3 * DAY),
    rotated_at: iso(-3 * DAY),
    expires_at: SHARE_EXPIRED ? iso(-2 * DAY) : SHARE_EXPIRING ? iso(5 * DAY) : undefined,
  },
];

const proxyUsers: ProxyUserView[] = [
  { id: "pu_cdcd", name: "cdcd" } as ProxyUserView,
  { id: "pu_family", name: "family" } as ProxyUserView,
];

const subStore: PluginView = {
  id: "latticenet.sub-store",
  name: "Sub-Store companion",
  type: "system",
  version: "0.14.0-alpha.1",
  publisher: "latticenet",
  capabilities: ["rpc:call", "http:egress", "kv:read", "kv:write", "subscription:serve"],
  status: "active",
  active: true,
};

const subStoreRecords = [
  { id: "merge-openjobs", name: "merge-openjobs", display_name: "OpenJobs merged" },
  { id: "cd-home", name: "cd-home", display_name: "Home lines" },
];

/* -------------------------------- store -------------------------------- */

const inventory: Record<StorageKind, StorageBucketInventoryEntry[]> = {
  kv: [
    { name: "default", kind: "kv", entries: 4, registered: true, reserved: false },
    { name: "plugin:latticenet.sub-store", kind: "kv", entries: 118, registered: false, reserved: false },
    { name: "vpnmeta/lineuuid", kind: "kv", entries: 313, registered: false, reserved: false },
    { name: "vpnmeta/lineuuid-owner", kind: "kv", entries: 147, registered: false, reserved: false },
    { name: "line-secrets", kind: "kv", entries: 96, registered: false, reserved: true },
  ],
  static: [
    { name: "site", kind: "static", entries: 12, registered: true, reserved: false },
    { name: "agent-releases", kind: "static", entries: 6, registered: false, reserved: false },
  ],
};

const buckets: Record<StorageKind, StorageBucket[]> = {
  kv: [
    {
      id: "buk_default",
      kind: "kv",
      name: "default",
      display_name: "default",
      created_at: iso(-90 * DAY),
      updated_at: iso(-2 * DAY),
    },
  ],
  static: [
    {
      id: "buk_site",
      kind: "static",
      name: "site",
      display_name: "docs site",
      index_document: "index.html",
      created_at: iso(-64 * DAY),
      updated_at: iso(-6 * DAY),
    },
  ],
};

const kvEntries: Record<string, KVEntry[]> = {
  default: [
    { bucket: "default", key: "console.motd", value: "maintenance window sat 02:00 UTC", updated_at: iso(-2 * DAY) },
    { bucket: "default", key: "geo.default-pop", value: "legend-sg", updated_at: iso(-9 * DAY) },
    { bucket: "default", key: "probe.interval-seconds", value: "45", updated_at: iso(-21 * DAY) },
    { bucket: "default", key: "sub.footer-note", value: "issued by lattice, do not share", updated_at: iso(-30 * DAY) },
  ],
  "vpnmeta/lineuuid": [
    {
      bucket: "vpnmeta/lineuuid",
      key: "legend-sg/reality-443",
      value: "8f1c0d2a-6b47-4f0e-9a51-2d3c8e5b7a10",
      updated_at: iso(-4 * DAY),
    },
    {
      bucket: "vpnmeta/lineuuid",
      key: "kenji-tokyo/hysteria-8443",
      value: "b2e77c94-1f30-49ab-8d62-0c5741ee9f38",
      updated_at: iso(-4 * DAY),
    },
    {
      bucket: "vpnmeta/lineuuid",
      key: "falcon-fra/vless-2087",
      value: "d40a651e-9c88-4b13-ae57-6f219b0c4d73",
      updated_at: iso(-11 * DAY),
    },
  ],
  "vpnmeta/lineuuid-owner": [
    {
      bucket: "vpnmeta/lineuuid-owner",
      key: "8f1c0d2a-6b47-4f0e-9a51-2d3c8e5b7a10",
      value: "cdcd",
      updated_at: iso(-4 * DAY),
    },
  ],
  "plugin:latticenet.sub-store": [
    {
      bucket: "plugin:latticenet.sub-store",
      key: "subs/cd-self",
      value: '{"name":"cd-self","nodes":41,"updated":"2026-09-01"}',
      updated_at: iso(-3 * DAY),
    },
    {
      bucket: "plugin:latticenet.sub-store",
      key: "subs/kenji-tokyo-mobile",
      value: '{"name":"kenji-tokyo-mobile","nodes":12,"updated":"2026-08-30"}',
      updated_at: iso(-5 * DAY),
    },
  ],
};

const staticObjects: Record<string, StaticObject[]> = {
  site: [
    {
      bucket: "site",
      path: "index.html",
      content: "<!doctype html>\n<title>lattice</title>\n<h1>lattice</h1>\n",
      content_type: "text/html",
      size: 54,
      updated_at: iso(-6 * DAY),
    },
    {
      bucket: "site",
      path: "assets/handbook.css",
      content: ":root { color-scheme: dark light; }\n",
      content_type: "text/css",
      size: 36,
      updated_at: iso(-6 * DAY),
    },
  ],
  "agent-releases": [
    {
      bucket: "agent-releases",
      path: "v0.3.3/lattice-agent-linux-amd64-3f9c1b7e5a2d48c0b6e1f4a97d2c05b83e6417ad9c0fbe25d8a3417c6b90ef21",
      content: "",
      content_type: "application/octet-stream",
      size: 18_412_032,
      updated_at: iso(-17 * DAY),
    },
    {
      bucket: "agent-releases",
      path: "v0.3.3/lattice-agent-linux-arm64-7c1e5a90d4b3286fa15c8e04b7d69f32a0c581e4d97b263fae0518c7d3a94b60",
      content: "",
      content_type: "application/octet-stream",
      size: 17_336_704,
      updated_at: iso(-17 * DAY),
    },
  ],
};

const bindings: Record<StorageKind, StorageBinding[]> = {
  kv: [
    {
      id: "bind_kv_1",
      kind: "kv",
      bucket: "edge-config",
      hostname: "config.roobli.org",
      path_prefix: "v1",
      enabled: true,
      created_at: iso(-40 * DAY),
      updated_at: iso(-40 * DAY),
    },
  ],
  static: [
    {
      id: "bind_static_1",
      kind: "static",
      bucket: "site",
      hostname: "docs.roobli.org",
      enabled: true,
      created_at: iso(-64 * DAY),
      updated_at: iso(-12 * DAY),
    },
  ],
};

const tokens: Record<StorageKind, StorageTokenView[]> = {
  kv: [
    {
      id: "tok_kv_reader",
      name: "edge-config reader",
      kind: "kv",
      access: "read",
      buckets: ["edge-config"],
      last_used_at: iso(-3 * 3_600_000),
      created_at: iso(-40 * DAY),
      updated_at: iso(-40 * DAY),
    },
    // The case the operator note used to deny: a CI job pushes into a bucket
    // the console called its own.
    ...(TOKEN_WRITER
      ? [
          {
            id: "tok_kv_ci",
            name: "ci push",
            kind: "kv" as StorageKind,
            access: "write",
            buckets: ["default"],
            last_used_at: iso(-40 * 60_000),
            created_at: iso(-12 * DAY),
            updated_at: iso(-12 * DAY),
          } as StorageTokenView,
        ]
      : []),
  ],
  static: [],
};

const unimplemented = new Proxy(
  {},
  {
    get(_target, prop) {
      return () => Promise.reject(new Error(`fake api: ${String(prop)} is not implemented in the harness`));
    },
  },
);

function requireBucket(kind: StorageKind, bucket: string): void {
  const entry = inventory[kind].find((b) => b.name === bucket);
  if (entry?.reserved) throw new ApiError(403, "forbidden", "bucket is reserved");
}

export const api = {
  auth: {
    me: () => delay(principal),
  },

  publishing: {
    records: () =>
      delay({
        records: EMPTY_PLANE || NO_ORIGINS ? [] : records.map((r) => ({ ...r })),
        // No origin the caller may look at. The server answers this way for an
        // operator holding none of the storage scopes, and the record list is
        // empty for the same reason rather than because nothing is published.
        origins: NO_ORIGINS ? [] : ["kv", "static", "plugin"],
      }),
  },

  storage: {
    buckets: (kind: StorageKind) =>
      STORE_FAIL
        ? delay(undefined).then(() => {
            throw new ApiError(502, "bad_gateway", "502 Bad Gateway from lattice.roobli.org (storage buckets)");
          })
        : delay({
            buckets: STORE_EMPTY ? [] : buckets[kind].map((b) => ({ ...b })),
            inventory: STORE_EMPTY ? [] : inventory[kind].map((b) => ({ ...b })),
          }),
    bindings: (kind: StorageKind) => delay({ bindings: bindings[kind].map((b) => ({ ...b })) }),
    tokens: (kind: StorageKind) => delay({ tokens: tokens[kind].map((t) => ({ ...t })) }),
    upsertBucket: async (kind: StorageKind, input: { name: string; display_name?: string; description?: string }) => {
      await delay(undefined);
      const next = { id: `bkt_${input.name}`, kind, name: input.name, display_name: input.display_name, description: input.description, created_at: iso(0), updated_at: iso(0) } as StorageBucket;
      buckets[kind].push(next);
      return next;
    },
    upsertBinding: async (kind: StorageKind, input: { bucket: string; hostname: string; path_prefix?: string; enabled: boolean }) => {
      await delay(undefined);
      const next: StorageBinding = { id: `bind_${kind}_${Date.now().toString(36)}`, kind, bucket: input.bucket, hostname: input.hostname, path_prefix: input.path_prefix, enabled: input.enabled, created_at: iso(0), updated_at: iso(0) };
      bindings[kind].push(next);
      records.push({ id: next.id, origin: kind, bucket: next.bucket, hostname: next.hostname, any_host: false, path_prefix: next.path_prefix, enabled: next.enabled, reserved: false, admin_scope: `${kind}:admin` });
      return next;
    },
    createToken: async (kind: StorageKind, input: { name: string; access: string; buckets: string[] }) => {
      await delay(undefined);
      const view = { id: `tok_${kind}_${Date.now().toString(36)}`, name: input.name, kind, access: input.access, buckets: input.buckets, created_at: iso(0), updated_at: iso(0) } as StorageTokenView;
      tokens[kind].push(view);
      return { ...view, token: "lst_harness_7c1e2f9a0b3d4e5f" };
    },
    deleteBinding: async (kind: StorageKind, id: string) => {
      await delay(undefined, STORAGE_WRITE_MS);
      if (STORAGE_FAIL) throw new ApiError(500, "internal", "storage: delete binding: database is locked");
      bindings[kind] = bindings[kind].filter((b) => b.id !== id);
      const at = records.findIndex((r) => r.id === id);
      if (at >= 0) records.splice(at, 1);
      return {};
    },
    revokeToken: async (kind: StorageKind, id: string) => {
      await delay(undefined, STORAGE_WRITE_MS);
      if (STORAGE_FAIL) throw new ApiError(500, "internal", "storage: revoke token: database is locked");
      tokens[kind] = tokens[kind].filter((t) => t.id !== id);
      return {};
    },
  },

  kv: {
    list: (bucket?: string) => {
      const name = bucket || "default";
      requireBucket("kv", name);
      return delay(STORE_EMPTY ? [] : (kvEntries[name] ?? []).map((e) => ({ ...e })));
    },
    put: async (input: { bucket?: string; key: string; value: string }) => {
      const name = input.bucket || "default";
      requireBucket("kv", name);
      await delay(undefined);
      const rows = (kvEntries[name] ??= []);
      const existing = rows.find((e) => e.key === input.key);
      const next: KVEntry = { bucket: name, key: input.key, value: input.value, updated_at: iso(0) };
      if (existing) Object.assign(existing, next);
      else rows.push(next);
      return { ...next };
    },
  },

  static: {
    list: (bucket?: string) => {
      const name = bucket || "site";
      requireBucket("static", name);
      return delay(STORE_EMPTY ? [] : (staticObjects[name] ?? []).map((o) => ({ ...o })));
    },
    put: async (input: { bucket?: string; path: string; content: string; content_type: string }) => {
      const name = input.bucket || "site";
      requireBucket("static", name);
      await delay(undefined);
      const rows = (staticObjects[name] ??= []);
      const existing = rows.find((o) => o.path === input.path);
      const next: StaticObject = {
        bucket: name,
        path: input.path,
        content: input.content,
        content_type: input.content_type,
        size: input.content.length,
        updated_at: iso(0),
      };
      if (existing) Object.assign(existing, next);
      else rows.push(next);
      return { ...next };
    },
  },

  subscriptionShares: {
    list: () =>
      SHARES_FAIL
        ? new Promise((_, reject) => setTimeout(() => reject(new ApiError(502, "bad_gateway", "502 Bad Gateway from lattice.roobli.org (shares)")), 120))
        : delay(shares.map((share) => ({ ...share }))),
    create: async (body: { slug: string; source: SubscriptionShareView["source"]; default_format?: string; expires_at?: string }) => {
      await delay(undefined);
      const next: SubscriptionShareView = {
        id: `shr_${body.slug}`,
        slug: body.slug,
        token: "st_new_harness_token",
        source: body.source,
        default_format: body.default_format,
        enabled: true,
        created_at: iso(0),
        updated_at: iso(0),
        expires_at: body.expires_at,
      };
      shares.push(next);
      return { ...next };
    },
    update: async (id: string, body: { expires_at?: string; clear_expiry?: boolean }) => {
      await delay(undefined);
      const share = shares.find((entry) => entry.id === id)!;
      if (body.clear_expiry) share.expires_at = undefined;
      else if (body.expires_at) share.expires_at = body.expires_at;
      return { ...share };
    },
    rotate: async (id: string) => {
      await delay(undefined);
      const share = shares.find((entry) => entry.id === id)!;
      share.token = `st_rotated_${Date.now().toString(36)}`;
      share.rotated_at = iso(0);
      return { ...share };
    },
    refresh: () => delay({ ok: true }),
    remove: async (id: string) => {
      await delay(undefined);
      const at = shares.findIndex((entry) => entry.id === id);
      if (at >= 0) shares.splice(at, 1);
    },
  },

  proxy: {
    users: () => delay({ users: proxyUsers.map((user) => ({ ...user })) }),
  },

  plugins: {
    list: () => delay([{ ...subStore }]),
    contributions: () => delay([{ ...subStore }]),
    call: () => delay({ subscriptions: subStoreRecords.map((record) => ({ ...record })) }),
  },

  approvals: unimplemented,
  security: unimplemented,
};
