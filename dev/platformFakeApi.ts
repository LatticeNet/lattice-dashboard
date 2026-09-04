/**
 * An in-memory stand-in for `@/lib/api`, wired in by vite.harness.config.ts
 * through a resolve alias so the production config and bundle never see it.
 *
 *   LATTICE_HARNESS=platform pnpm exec vite --config vite.harness.config.ts
 *   open http://127.0.0.1:5185/dev/platform.html
 *
 * Everything the real barrel exports is re-exported unchanged; only `api` is
 * replaced, and only the calls Publishing, Store and Evidence make are
 * implemented. Anything else throws, loudly, so a new call path is noticed
 * rather than silently fed nothing.
 *
 * The fixture is production's actual shape, because that is the shape the
 * three pages were wrong about:
 *
 * - Publishing holds one reserved subscription share that is serving, which is
 *   exactly what lattice.roobli.org answers with today, plus a static site and
 *   a KV route so the access legend has all three modes to explain.
 * - Store holds the server's line identity map (vpnmeta/lineuuid, 313 entries),
 *   Sub-Store's plugin bucket and one operator bucket, so the page can be
 *   checked for who it says wrote a bucket and which controls it offers.
 * - Evidence answers with no records, a store that holds 412 of them, and a
 *   newest record eight days older than the default window.
 */
import { ApiError } from "@/lib/api/client";
import type {
  ConnRecord,
  KVEntry,
  Principal,
  PublishingRecord,
  StaticObject,
  StorageBinding,
  StorageBucket,
  StorageBucketInventoryEntry,
  StorageKind,
  StorageTokenView,
  TracePolicy,
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
 *   ?nothing-collected  Evidence answers with a store that holds no record.
 *   ?no-nodes         The caller can see no node, so the trace handler answers
 *                     before it reaches the store and its collected_total is 0.
 *   ?old-server       Evidence answers without the collection fields at all.
 *   ?token-writer     A storage token can write the operator's own bucket.
 *   ?no-admin         The caller holds no kv:admin or static:admin, so the
 *                     console cannot read the token list at all.
 */
const flags = new URLSearchParams(location.search);
const EMPTY_PLANE = flags.has("empty-plane");
const NO_ORIGINS = flags.has("no-origins");
const NOTHING_COLLECTED = flags.has("nothing-collected");
const NO_NODES = flags.has("no-nodes");
const OLD_SERVER = flags.has("old-server");
const TOKEN_WRITER = flags.has("token-writer");
const NO_ADMIN = flags.has("no-admin");

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

/* ------------------------------- evidence ------------------------------- */

const policies: TracePolicy[] = [
  {
    node_id: "nod_legend_sg",
    enabled: true,
    level: "info",
    budget_lines_per_sec: 200,
    updated_at: iso(-8 * DAY),
  },
  { node_id: "nod_kenji_tokyo", enabled: false, level: "info", budget_lines_per_sec: 0 },
  { node_id: "nod_falcon_fra", enabled: false, level: "info", budget_lines_per_sec: 0 },
];

const nodes = [
  { id: "nod_legend_sg", name: "legend-sg", status: "online" },
  { id: "nod_kenji_tokyo", name: "kenji-tokyo", status: "online" },
  { id: "nod_falcon_fra", name: "falcon-fra", status: "online" },
];

const NO_RECORDS: ConnRecord[] = [];

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
      delay({
        buckets: buckets[kind].map((b) => ({ ...b })),
        inventory: inventory[kind].map((b) => ({ ...b })),
      }),
    bindings: (kind: StorageKind) => delay({ bindings: bindings[kind].map((b) => ({ ...b })) }),
    tokens: (kind: StorageKind) => delay({ tokens: tokens[kind].map((t) => ({ ...t })) }),
  },

  kv: {
    list: (bucket?: string) => {
      const name = bucket || "default";
      requireBucket("kv", name);
      return delay((kvEntries[name] ?? []).map((e) => ({ ...e })));
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
      return delay((staticObjects[name] ?? []).map((o) => ({ ...o })));
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

  nodes: {
    list: () => delay({ nodes: NO_NODES ? [] : nodes.map((n) => ({ ...n })) } as never),
  },

  users: {
    list: () => delay({ users: [] } as never),
  },

  trace: {
    // No record matches the window, but the store is not empty: this is the
    // case the empty state used to answer with "widen the time range" and no
    // idea of how far. The newest record is eight days old.
    connections: () => {
      // handleTraceRecords returns before it reaches the store when the caller
      // has no visible node, and collected_total carries no omitempty, so that
      // answer is indistinguishable from a store that collected nothing.
      if (NO_NODES) return delay({ records: NO_RECORDS, collected_total: 0 });
      if (OLD_SERVER) return delay({ records: NO_RECORDS });
      if (NOTHING_COLLECTED) return delay({ records: NO_RECORDS, collected_total: 0 });
      return delay({
        records: NO_RECORDS,
        collected_total: 412,
        collected_newest_at: iso(-8 * DAY),
      });
    },
    sessions: () => delay({ sessions: [] }),
    policy: () => delay({ policies: NO_NODES ? [] : policies.map((p) => ({ ...p })) }),
  },

  approvals: unimplemented,
  security: unimplemented,
  plugins: unimplemented,
};
