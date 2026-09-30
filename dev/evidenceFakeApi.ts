/**
 * An in-memory stand-in for `@/lib/api` for the Evidence area, wired in by
 * vite.harness.config.ts through a resolve alias so the production config and
 * bundle never see it.
 *
 *   LATTICE_HARNESS=evidence pnpm exec vite --config vite.harness.config.ts
 *   open http://127.0.0.1:5185/dev/evidence.html#/platform/evidence
 *
 * Fixtures, chosen with `?fixture=` on the page URL (before the hash):
 *
 *   empty    (default) Production on 2026-09-29: 34 nodes, trace policy off on
 *            every one, a trace store holding 0 records, encrypted, 2 GiB cap,
 *            and one raw log source (sing-box on legend-sg, 82 lines) whose
 *            node last shipped on 2026-08-27.
 *   capture  A capture running on two nodes with a few hundred connection
 *            records in the last hour, failures among them, plus a finished
 *            capture in the history.
 *   rawlog   Nothing in the trace store, but three raw log sources, one of
 *            them fresh and busy.
 *   failing  Every trace and log endpoint answers 500.
 *   storeoff The server has connection tracing disabled (503 on /api/trace).
 *
 * Add `&readonly` to drop log:admin from the principal. Add `&names=fail` to
 * make the node list answer 500, or `&names=hang` to make it never answer:
 * the Explore field resolves node names against that list. Add `&now=<ms>` to
 * pin the clock the fixture is built from: records keep their keys across a
 * reload, so a reload onto ?conn= finds the same connection.
 */
import { ApiError } from "@/lib/api/client";
import type {
  ConnRecord,
  HopPath,
  LogLine,
  LogSource,
  LogSourceStatsView,
  LogSourceUpsertRequest,
  Principal,
  TraceLine,
  TracePolicy,
  TracePolicyUpsertRequest,
  TraceSession,
  TraceSessionCreateRequest,
  TraceStatsResponse,
} from "@/lib/api/index";

export * from "@/lib/api/index";

const flags = new URLSearchParams(location.search);
const FIXTURE = flags.get("fixture") ?? "empty";
const READONLY = flags.has("readonly");
const NAMES = flags.get("names");

const NOW = Number(flags.get("now")) || Date.now();
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const LATENCY_MS = 160;

function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function delay<T>(value: T, ms = LATENCY_MS): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function fail(status: number, code: string, message: string): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new ApiError(status, code, message)), LATENCY_MS));
}

/** Deterministic noise, so every screenshot of a fixture shows the same rows. */
let seed = 20260929;
function rand(): number {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
function pick<T>(list: readonly T[]): T {
  return list[Math.floor(rand() * list.length)]!;
}

const principal: Principal = {
  actor_id: "cdcd",
  username: "cdcd",
  scopes: ["log:read", "node:read", "user:admin", ...(READONLY ? [] : ["log:admin"])],
  server_allowlist: [],
  csrf_token: "harness",
};

/* -------------------------------- nodes -------------------------------- */

const NODE_NAMES = [
  "[Metix]-DMIT-1",
  "[Metix]-VIRCS-ATT-VDS",
  "[Metix]-qqpw-cd2-VDS",
  "[Metix]-DMIT-eb-wee",
  "hk-turin-mini",
  "mkcloud-hr-iplc",
  "legend-sg",
  "kenji-tokyo",
  "falcon-fra",
  "openjobs-vpn-dmit-1",
  "openjobs-vpn-dmit-2",
  "cd-xuezhang-jp-nat",
  "bwg-la-cn2",
  "racknerd-sj",
  "vultr-tokyo-hp",
  "vultr-seoul",
  "oracle-osaka-arm",
  "oracle-sg-arm",
  "aws-lightsail-sg",
  "gcp-tw-e2",
  "hetzner-fsn-cx22",
  "hetzner-hel-cx22",
  "netcup-nue",
  "ovh-gra-kimsufi",
  "colo-hk-bgp",
  "yxvm-hk-cmi",
  "dmit-lax-pro",
  "greencloud-sg",
  "akile-hk-hkt",
  "misaka-hk",
  "claw-jp",
  "ccs-us-sjc",
  "home-shenzhen",
  "home-guangzhou",
];

const nodes = NODE_NAMES.map((name, index) => ({
  id: `node_${name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 14)}${index.toString(36)}`,
  name,
  status: "online",
}));
const nodeByName = (name: string) => nodes.find((node) => node.name === name)!.id;

const DMIT = nodeByName("[Metix]-DMIT-1");
const TURIN = nodeByName("hk-turin-mini");
const VIRCS = nodeByName("[Metix]-VIRCS-ATT-VDS");
const LEGEND = nodeByName("legend-sg");
const KENJI = nodeByName("kenji-tokyo");

/* ------------------------------ policies ------------------------------- */

const policies: TracePolicy[] = nodes.map((node) => ({
  node_id: node.id,
  enabled: false,
  level: "debug",
  budget_lines_per_sec: 500,
}));

/* ------------------------------ sessions ------------------------------- */

const sessions: TraceSession[] = [];

if (FIXTURE === "capture") {
  sessions.push(
    {
      id: "trace_k2m9q4c1",
      name: "capture [Metix]-DMIT-1, hk-turin-mini 2026-09-29 07:20Z",
      filter: { node_ids: [DMIT, TURIN] },
      level: "debug",
      started_at: iso(-52 * MIN),
      expires_at: iso(68 * MIN),
      state: "running",
      started_by: "cdcd",
      lines: 1841,
      records: 312,
      dropped: 0,
    },
    {
      id: "trace_p7x3v8n2",
      name: "user alice slow uploads",
      filter: { node_ids: [VIRCS], user_ids: ["usr_alice"] },
      level: "trace",
      started_at: iso(-20 * MIN),
      expires_at: iso(10 * MIN),
      state: "running",
      started_by: "cdcd",
      lines: 402,
      records: 0,
      dropped: 37,
    },
    {
      id: "trace_a1b2c3d4",
      name: "capture legend-sg 2026-09-27 13:02Z",
      filter: { node_ids: [LEGEND] },
      level: "debug",
      started_at: iso(-2 * DAY),
      expires_at: iso(-2 * DAY + HOUR),
      ended_at: iso(-2 * DAY + HOUR),
      state: "expired",
      started_by: "cdcd",
      lines: 0,
      records: 0,
      dropped: 0,
    },
  );
}

/* ------------------------------ records -------------------------------- */

const DESTINATIONS = [
  ["www.google.com", 443],
  ["www.google.com", 443],
  ["api.openai.com", 443],
  ["github.com", 443],
  ["github.com", 22],
  ["gateway.icloud.com", 443],
  ["cdn.jsdelivr.net", 443],
  ["graph.facebook.com", 443],
  ["i.ytimg.com", 443],
  ["time.apple.com", 123],
  ["registry.npmjs.org", 443],
  ["login.microsoftonline.com", 443],
] as const;

const REASONS = [
  ...Array(34).fill("eof"),
  ...Array(4).fill("canceled"),
  ...Array(4).fill("timeout"),
  ...Array(3).fill("dial_failed"),
  ...Array(2).fill("reset"),
  "handshake_failed",
  "udp_idle",
  "auth_failed",
] as string[];

const USERS = [
  { user_kind: "managed", user_id: "usr_alice", user_name: "u_7a3f19c2" },
  { user_kind: "managed", user_id: "usr_bob", user_name: "u_2c90e4d1" },
  { user_kind: "managed", user_id: "usr_kenji", user_name: "u_91b0aa37" },
  { user_kind: "discovered", user_name: "iphone-cdcd" },
  { user_kind: "legacy", user_name: "openjobs-shenzhen" },
  { user_kind: "unnamed" },
] as const;

const LINES = ["8f1c0d2a-6b47-4f0e-9a51-2d3c8e5b7a10", "b2e77c94-1f30-49ab-8d62-0c5741ee9f38", "d40a651e-9c88-4b13-ae57-6f219b0c4d73"];

const records: ConnRecord[] = [];

if (FIXTURE === "capture") {
  for (let i = 0; i < 312; i++) {
    const node = rand() < 0.68 ? DMIT : TURIN;
    const [host, port] = pick(DESTINATIONS);
    const user = pick(USERS);
    const open = rand() < 0.03;
    const reason = open ? undefined : pick(REASONS);
    const started = NOW - Math.floor(rand() * 58 * MIN) - 30_000;
    const durationMs = Math.floor(rand() < 0.2 ? rand() * 900 : rand() * 180_000);
    const bytesKnown = rand() < 0.8;
    const failed = reason === "dial_failed" || reason === "handshake_failed" || reason === "auth_failed";
    records.push({
      node_id: node,
      line_uuid: pick(LINES),
      inbound_tag: node === DMIT ? "vless-in-17893" : "trojan-in-8443",
      inbound_type: node === DMIT ? "vless" : "trojan",
      ...user,
      log_id: 400000 + i * 7,
      network: port === 123 ? "udp" : "tcp",
      src_ip: `203.0.113.${Math.floor(rand() * 200) + 10}`,
      src_port: 40000 + Math.floor(rand() * 20000),
      dst_host: host,
      dst_port: port,
      sniffed_protocol: port === 443 ? "tls" : undefined,
      sniffed_domain: port === 443 ? host : undefined,
      rule_index: 3,
      rule_text: "rule_set=geosite-openai => exit-vircs",
      outbound_tag: host.includes("openai") ? "exit-vircs" : "direct",
      outbound_type: host.includes("openai") ? "vless" : "direct",
      started_at: new Date(started).toISOString(),
      ended_at: open ? undefined : new Date(started + durationMs).toISOString(),
      duration_ms: open ? undefined : durationMs,
      open,
      upload: bytesKnown && !failed ? Math.floor(rand() * 400_000) : undefined,
      download: bytesKnown && !failed ? Math.floor(rand() * 9_000_000) : undefined,
      bytes_known: failed ? true : bytesKnown,
      close_reason: reason,
      close_error: reason === "dial_failed" ? `dial tcp ${host}:${port}: i/o timeout` : undefined,
      stalled_at: !open && rand() < 0.02 ? new Date(started + 20_000).toISOString() : undefined,
      core_generation: 3,
      session_ids: ["trace_k2m9q4c1"],
    });
  }
  // The same destination fails repeatedly from one node: the pattern a
  // failure breakdown should make obvious.
  for (let i = 0; i < 9; i++) {
    const started = NOW - (i * 5 + 2) * MIN;
    records.push({
      node_id: TURIN,
      line_uuid: LINES[1],
      inbound_tag: "trojan-in-8443",
      user_kind: "managed",
      user_id: "usr_kenji",
      user_name: "u_91b0aa37",
      log_id: 900000 + i,
      network: "tcp",
      dst_host: "api.telegram.org",
      dst_port: 443,
      outbound_tag: "exit-vircs",
      started_at: new Date(started).toISOString(),
      ended_at: new Date(started + 10_000).toISOString(),
      duration_ms: 10_000,
      bytes_known: true,
      upload: 0,
      download: 0,
      close_reason: "dial_failed",
      close_error: "dial tcp 149.154.167.220:443: connect: connection refused",
      core_generation: 3,
      session_ids: ["trace_k2m9q4c1"],
    });
  }
  records.sort((a, b) => b.started_at.localeCompare(a.started_at));
}

/* ------------------------------ raw log -------------------------------- */

const sources: LogSource[] = [];
const sourceLines = new Map<string, LogLine[]>();
const sourceIngest = new Map<string, string>();

function addSource(source: LogSource, count: number, newestOffset: number, spacingMs: number, lastIngestOffset: number): void {
  sources.push(source);
  const lines: LogLine[] = [];
  for (let i = 0; i < count; i++) {
    const at = NOW + newestOffset - (count - 1 - i) * spacingMs;
    const [host, port] = pick(DESTINATIONS);
    const id = 1_000_000 + i * 13;
    const text = pick([
      `INFO [${id} 0ms] inbound/vless[vless-in-17893]: inbound connection from 203.0.113.${i % 200}:${40000 + i}`,
      `INFO [${id} 2ms] inbound/vless[vless-in-17893]: [u_7a3f19c2] inbound connection to ${host}:${port}`,
      `INFO [${id} 3ms] outbound/direct[direct]: outbound connection to ${host}:${port}`,
      `DEBUG [${id} 1.2s] connection: connection download finished`,
      `ERROR [${id} 10s] connection: open outbound connection: dial tcp ${host}:${port}: i/o timeout`,
    ]);
    lines.push({
      source_id: source.id,
      node_id: source.node_id,
      path: source.path,
      seq: i + 1,
      offset: i * 120,
      at: new Date(at).toISOString(),
      line: `${new Date(at).toISOString()} ${text}`,
    });
  }
  sourceLines.set(source.id, lines);
  sourceIngest.set(source.id, count ? iso(lastIngestOffset) : "0001-01-01T00:00:00Z");
}

function managedSource(id: string, name: string, node: string, path: string): LogSource {
  return {
    id,
    name,
    node_id: node,
    path,
    enabled: true,
    max_line_bytes: 8192,
    max_batch_lines: 500,
    created_at: iso(-60 * DAY),
    updated_at: iso(-60 * DAY),
    managed: true,
  };
}

if (FIXTURE === "empty" || FIXTURE === "capture") {
  // Production: the one source, a month stale (last ingest 2026-08-27).
  addSource(managedSource("logsrc_singbox_legend", `sing-box - legend-sg`, LEGEND, `singbox://${LEGEND}`), 82, -33 * DAY, 40_000, -33 * DAY);
}
if (FIXTURE === "rawlog") {
  addSource(managedSource("logsrc_singbox_legend", `sing-box - legend-sg`, LEGEND, `singbox://${LEGEND}`), 1480, -2 * MIN, 9_000, -1 * MIN);
  addSource(managedSource("logsrc_singbox_kenji", `sing-box - kenji-tokyo`, KENJI, `singbox://${KENJI}`), 82, -33 * DAY, 40_000, -33 * DAY);
  addSource(
    {
      id: "logsrc_nginx_dmit",
      name: "nginx-access",
      node_id: DMIT,
      path: "/var/log/nginx/access.log",
      enabled: false,
      max_line_bytes: 16384,
      max_batch_lines: 500,
      created_at: iso(-20 * DAY),
      updated_at: iso(-3 * DAY),
    },
    0,
    0,
    0,
    0,
  );
}

function statsFor(source: LogSource): LogSourceStatsView {
  const lines = sourceLines.get(source.id) ?? [];
  return {
    source_id: source.id,
    node_id: source.node_id,
    name: source.name,
    path: source.path,
    enabled: source.enabled,
    lines: lines.length,
    bytes: lines.reduce((sum, line) => sum + line.line.length, 0),
    first_at: lines[0]?.at ?? "0001-01-01T00:00:00Z",
    last_at: lines[lines.length - 1]?.at ?? "0001-01-01T00:00:00Z",
    last_ingest_at: sourceIngest.get(source.id) ?? "0001-01-01T00:00:00Z",
  };
}

/* ------------------------------ failure modes -------------------------- */

const FAILING = FIXTURE === "failing";
const STORE_OFF = FIXTURE === "storeoff";

function traceGuard(): Promise<never> | undefined {
  if (FAILING) return fail(500, "internal", "tracestore: database is locked");
  if (STORE_OFF) return fail(503, "internal", "connection tracing is not enabled on this server");
  return undefined;
}
function logGuard(): Promise<never> | undefined {
  if (FAILING) return fail(500, "internal", "logstore: read stats: disk I/O error");
  return undefined;
}

/* ------------------------------ connections ---------------------------- */

function csv(value: unknown): string[] {
  return typeof value === "string" && value ? value.split(",").map((part) => part.trim()).filter(Boolean) : [];
}

function queryConnections(params: Record<string, string | number>) {
  const since = params.since ? Date.parse(String(params.since)) : -Infinity;
  const until = params.until ? Date.parse(String(params.until)) : Infinity;
  const nodeIds = csv(params.node_id);
  const users = csv(params.user_id);
  const lines = csv(params.line_uuid);
  const sessionIds = csv(params.session_id);
  const reasons = csv(params.close_reason);
  const kinds = csv(params.user_kind);
  const dst = String(params.dst ?? "").toLowerCase();
  const includeOpen = params.include_open === "true";
  const stalled = params.stalled === "true";
  const matched = records.filter((r) => {
    const at = Date.parse(r.started_at);
    if (at < since || at > until) return false;
    if (nodeIds.length && !nodeIds.includes(r.node_id)) return false;
    if (users.length && !users.includes(r.user_id ?? "")) return false;
    if (lines.length && !lines.includes(r.line_uuid ?? "")) return false;
    if (sessionIds.length && !(r.session_ids ?? []).some((id) => sessionIds.includes(id))) return false;
    if (reasons.length && !reasons.includes(r.close_reason ?? "unknown")) return false;
    if (kinds.length && !kinds.includes(r.user_kind ?? "")) return false;
    if (dst && !(r.dst_host ?? "").toLowerCase().includes(dst)) return false;
    if (!includeOpen && r.open) return false;
    if (stalled && !r.stalled_at) return false;
    return true;
  });
  const limit = Math.min(Number(params.limit) || 200, 1000);
  const offset = Number(params.cursor || 0);
  const page = matched.slice(offset, offset + limit);
  const next = offset + limit < matched.length ? String(offset + limit) : undefined;
  return {
    records: page.map((r) => ({ ...r })),
    next_cursor: next,
    collected_total: records.length,
    collected_newest_at: records[0]?.started_at,
  };
}

function sessionLines(sessionId: string): TraceLine[] {
  const out: TraceLine[] = [];
  let seq = 0;
  for (const r of [...records].reverse()) {
    if (!(r.session_ids ?? []).includes(sessionId)) continue;
    out.push({
      session_id: sessionId,
      node_id: r.node_id,
      seq: ++seq,
      at: r.started_at,
      level: "info",
      log_id: r.log_id,
      tag: r.inbound_tag,
      message: `inbound connection to ${r.dst_host}:${r.dst_port}`,
      raw: `INFO [${r.log_id} 0ms] inbound/${r.inbound_type ?? "vless"}[${r.inbound_tag}]: [${r.user_name ?? ""}] inbound connection to ${r.dst_host}:${r.dst_port}`,
    });
    if (!r.open) {
      out.push({
        session_id: sessionId,
        node_id: r.node_id,
        seq: ++seq,
        at: r.ended_at ?? r.started_at,
        level: r.close_error ? "error" : "debug",
        log_id: r.log_id,
        message: r.close_error ?? "connection download finished",
        raw: r.close_error
          ? `ERROR [${r.log_id} ${r.duration_ms}ms] connection: open outbound connection: ${r.close_error}`
          : `DEBUG [${r.log_id} ${r.duration_ms}ms] connection: connection download finished`,
      });
    }
  }
  return out;
}

/* ------------------------------ the fake ------------------------------- */

const unimplemented = new Proxy(
  {},
  {
    get(_target, prop) {
      return () => Promise.reject(new Error(`fake api: ${String(prop)} is not implemented in the evidence harness`));
    },
  },
);

export const api = {
  auth: {
    me: () => delay(principal),
  },

  nodes: {
    list: () => {
      if (NAMES === "fail") return fail(500, "internal", "store: list nodes: database is locked");
      if (NAMES === "hang") return new Promise<never>(() => {});
      return delay({ nodes: nodes.map((n) => ({ ...n })) } as never);
    },
  },

  users: {
    list: () =>
      delay({
        users: [
          { id: "usr_alice", username: "alice" },
          { id: "usr_bob", username: "bob" },
          { id: "usr_kenji", username: "kenji" },
        ],
      } as never),
  },

  plugins: {
    contributions: () => delay([]),
  },

  trace: {
    connections: (params: Record<string, string | number>) => traceGuard() ?? delay(queryConnections(params)),
    sessions: () => traceGuard() ?? delay({ sessions: sessions.map((s) => ({ ...s })) }),
    startSession: async (input: TraceSessionCreateRequest) => {
      const guard = traceGuard();
      if (guard) return guard;
      if (READONLY) return fail(403, "forbidden", "log:admin is required");
      await delay(undefined, 400);
      const session: TraceSession = {
        id: `trace_${Math.floor(rand() * 1e8).toString(36)}`,
        name: input.name,
        filter: input.filter,
        level: input.level,
        started_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + input.ttl_seconds * 1000).toISOString(),
        state: "running",
        started_by: "cdcd",
        lines: 0,
        records: 0,
        dropped: 0,
      };
      sessions.unshift(session);
      return { ...session };
    },
    stopSession: async (id: string) => {
      await delay(undefined);
      const session = sessions.find((s) => s.id === id);
      if (!session) return fail(404, "not_found", "trace session not found");
      session.state = "stopped";
      session.ended_at = new Date().toISOString();
      return { ...session };
    },
    lines: (params: { session_id: string; after_seq?: number; limit?: number }) => {
      const guard = traceGuard();
      if (guard) return guard;
      const all = sessionLines(params.session_id).filter((line) => line.seq > (params.after_seq ?? 0));
      const page = all.slice(0, params.limit ?? 500);
      return delay({ lines: page, next_seq: page[page.length - 1]?.seq ?? params.after_seq ?? 0 });
    },
    policy: () => traceGuard() ?? delay({ policies: policies.map((p) => ({ ...p })) }),
    setPolicy: async (input: TracePolicyUpsertRequest) => {
      await delay(undefined);
      const policy = policies.find((p) => p.node_id === input.node_id);
      if (!policy) return fail(404, "not_found", "node not found");
      if (input.enabled !== undefined) policy.enabled = input.enabled;
      if (input.level) policy.level = input.level;
      if (input.budget_lines_per_sec) policy.budget_lines_per_sec = input.budget_lines_per_sec;
      policy.updated_at = new Date().toISOString();
      return { ...policy };
    },
    hops: (params: { node_id: string; core_generation: number; log_id: number; started_at?: string }) => {
      const guard = traceGuard();
      if (guard) return guard;
      const record = records.find(
        (r) => r.node_id === params.node_id && r.log_id === params.log_id && (!params.started_at || r.started_at === params.started_at),
      );
      if (!record) return fail(404, "not_found", "connection record not found");
      const exit: ConnRecord = {
        ...record,
        node_id: VIRCS,
        log_id: record.log_id + 3,
        inbound_tag: "vless-relay-in",
        outbound_tag: "direct",
        session_ids: [],
      };
      const path: HopPath = {
        id: `hop_${record.log_id}`,
        confidence: record.outbound_tag === "exit-vircs" ? "inferred" : "exact",
        record_keys:
          record.outbound_tag === "exit-vircs"
            ? [
                { node_id: record.node_id, core_generation: 3, log_id: record.log_id },
                { node_id: VIRCS, core_generation: 3, log_id: exit.log_id },
              ]
            : [{ node_id: record.node_id, core_generation: 3, log_id: record.log_id }],
      };
      return delay({ path, records: record.outbound_tag === "exit-vircs" ? [{ ...record }, exit] : [{ ...record }] });
    },
    stats: (): Promise<TraceStatsResponse> =>
      traceGuard() ??
      delay({
        schema_version: 4,
        records: records.length,
        open_records: records.filter((r) => r.open).length,
        lines: records.length * 2,
        size_bytes: 4096 + records.length * 900,
        max_bytes: 2 * 1024 ** 3,
        cipher_enabled: true,
        newest_record_at: records[0]?.started_at,
        oldest_record_at: records[records.length - 1]?.started_at,
      }),
  },

  logs: {
    sources: () => logGuard() ?? delay({ sources: sources.map((s) => ({ ...s })) }),
    stats: () => logGuard() ?? delay({ stats: sources.map(statsFor) }),
    query: (params: { source_id: string; q?: string; since?: string; until?: string; limit?: number; before_seq?: number }) => {
      const guard = logGuard();
      if (guard) return guard;
      const since = params.since ? Date.parse(params.since) : -Infinity;
      const until = params.until ? Date.parse(params.until) : Infinity;
      const needle = (params.q ?? "").toLowerCase();
      const all = (sourceLines.get(params.source_id) ?? []).filter((line) => {
        const at = Date.parse(line.at);
        if (at < since || at > until) return false;
        if (params.before_seq !== undefined && line.seq >= params.before_seq) return false;
        return !needle || line.line.toLowerCase().includes(needle);
      });
      const limit = params.limit ?? 200;
      const page = all.slice(-limit);
      return delay({
        lines: page.map((line) => ({ ...line })),
        truncated: false,
        next_before_seq: all.length > limit ? page[0]?.seq : undefined,
      });
    },
    upsertSource: async (input: LogSourceUpsertRequest) => {
      await delay(undefined);
      const existing = sources.find((s) => s.id === input.id);
      const next: LogSource = {
        id: input.id ?? `logsrc_${Math.floor(rand() * 1e8).toString(36)}`,
        name: input.name,
        node_id: input.node_id,
        path: input.path,
        enabled: input.enabled ?? true,
        max_line_bytes: input.max_line_bytes ?? 16384,
        max_batch_lines: input.max_batch_lines ?? 500,
        created_at: existing?.created_at ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      if (existing) Object.assign(existing, next);
      else {
        sources.push(next);
        sourceLines.set(next.id, []);
      }
      return { ...next };
    },
    deleteSource: async (id: string) => {
      await delay(undefined);
      const at = sources.findIndex((s) => s.id === id);
      if (at >= 0) sources.splice(at, 1);
      return { ok: true };
    },
  },

  approvals: unimplemented,
  security: unimplemented,
};
