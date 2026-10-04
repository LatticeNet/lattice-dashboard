/**
 * Self-monitoring fixtures (Platform > System and the node page's History
 * card), shaped like production on 2026-10-04: hkg has 2 vCPUs and 3.9 GB of
 * memory, lattice-server sits near 930 MB, the 99 GB data volume has 9.7 GB
 * free, state-hot.db is 1.5 GB, the audit WAL 810 MB and state.json 16 MB.
 *
 * Switches, on the page's query string:
 *
 *   ?system=fresh      the metrics store started a minute ago: no write yet,
 *                      no rows, no file sizes
 *   ?system=busy       long method names, failing and slow rows, 60 route
 *                      groups, the series cap nearly full with series dropped,
 *                      and a write that is late
 *   ?system=forbidden  the reads answer 403 (not a full administrator)
 *   ?system=disabled   the reads answer 503 (no data directory)
 *   ?fail=system       the reads answer 502
 *   ?history=empty     the node has no history yet
 *   ?history=disabled  node history answers 503
 *   ?history=gaps      the node went quiet for a stretch
 */
import type { MetricsQuery, MetricsRange, MetricsSeries, SystemEventRow, SystemHealth, SystemSpark } from "@/lib/api/systemTypes";

const SPAN: Record<MetricsRange, number> = {
  "1h": 3600,
  "6h": 6 * 3600,
  "24h": 86400,
  "7d": 7 * 86400,
  "30d": 30 * 86400,
  "90d": 90 * 86400,
  "1y": 365 * 86400,
  "5y": 1826 * 86400,
};

const TIERS = [
  { name: "1m", res: 60, keep: 48 * 3600 },
  { name: "5m", res: 300, keep: 14 * 86400 },
  { name: "1h", res: 3600, keep: 90 * 86400 },
  { name: "1d", res: 86400, keep: 1830 * 86400 },
];

/** The server's tier rule (metricsdb.pickTier) and step merge. */
export function stepFor(range: MetricsRange, points: number): { tier: (typeof TIERS)[number]; step: number } {
  const span = SPAN[range];
  let tier = TIERS[TIERS.length - 1]!;
  for (const t of TIERS) {
    if (span > t.keep) continue;
    if (span / t.res <= 8 * points) {
      tier = t;
      break;
    }
  }
  const buckets = Math.floor(span / tier.res);
  const mult = buckets > points ? Math.ceil(buckets / points) : 1;
  return { tier, step: mult * tier.res };
}

/** A small deterministic generator, so a render looks the same every time. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

interface Shape {
  base: number;
  wave?: number;
  noise?: number;
  drift?: number;
  spikes?: number;
  min?: number;
  max?: number;
}

/** A gauge series: a base, a daily wave, noise, drift over the range and a few spikes. */
function gaugeSeries(name: string, unit: MetricsSeries["unit"], range: MetricsRange, points: number, now: number, shape: Shape, seed: number, gaps: [number, number][] = []): MetricsSeries {
  const { step } = stepFor(range, points);
  const span = SPAN[range];
  const from = Math.floor((now - span) / step) * step;
  const r = rng(seed);
  const out: MetricsSeries = { name, kind: "gauge", unit, t: [], avg: [], min: [], max: [], n: [] };
  for (let t = from; t + step <= now + step; t += step) {
    const frac = (t - from) / span;
    if (gaps.some(([a, b]) => frac >= a && frac < b)) continue;
    const day = Math.sin((t / 86400) * Math.PI * 2);
    let avg = shape.base * (1 + (shape.wave ?? 0) * day + (shape.drift ?? 0) * frac + (shape.noise ?? 0) * (r() - 0.5));
    let max = avg * (1 + (shape.noise ?? 0.05) * r());
    let min = avg * (1 - (shape.noise ?? 0.05) * r());
    if (shape.spikes && r() < shape.spikes) max = avg * (1.4 + r());
    const lo = shape.min ?? 0;
    const hi = shape.max ?? Infinity;
    avg = Math.min(Math.max(avg, lo), hi);
    max = Math.min(Math.max(max, avg), hi);
    min = Math.max(Math.min(min, avg), lo);
    out.t.push(t);
    out.avg.push(avg);
    out.min.push(min);
    out.max.push(max);
    out.n.push(Math.max(1, Math.round((step / 10) * (0.9 + 0.1 * r()))));
  }
  return out;
}

function eventSpark(range: MetricsRange, now: number, rate: number, p95: number, failEvery: number, seed: number): SystemSpark {
  const { step } = stepFor(range, 48);
  const span = SPAN[range];
  const from = Math.floor((now - span) / step) * step;
  const r = rng(seed);
  const spark: SystemSpark = { step_seconds: step, t: [], n: [], e: [], p95: [] };
  for (let t = from; t + step <= now + step; t += step) {
    const calls = Math.round(rate * (step / 60) * (0.5 + r()));
    if (calls === 0) continue;
    spark.t.push(t);
    spark.n.push(calls);
    spark.e!.push(failEvery > 0 && r() < 1 / failEvery ? 1 + Math.round(r() * 2) : 0);
    spark.p95!.push(p95 * (0.7 + 0.6 * r()) * (r() < 0.05 ? 3 : 1));
  }
  return spark;
}

function eventRow(name: string, range: MetricsRange, now: number, perMinute: number, p50: number, p95: number, errorShare: number, seed: number, plugin?: string): SystemEventRow {
  const minutes = SPAN[range] / 60;
  const calls = Math.max(1, Math.round(perMinute * minutes));
  const spark = eventSpark(range, now, perMinute, p95, errorShare > 0 ? Math.round(1 / Math.max(errorShare * 10, 0.001)) : 0, seed);
  return {
    plugin,
    name,
    calls,
    errors: Math.round(calls * errorShare),
    per_minute: calls / minutes,
    p50_seconds: p50,
    p95_seconds: p95,
    max_seconds: p95 * 2.6,
    avg_seconds: (p50 + p95) / 2.4,
    spark,
  };
}

function fileSpark(range: MetricsRange, now: number, size: number, growth: number, seed: number): SystemSpark {
  const { step } = stepFor(range, 48);
  const span = SPAN[range];
  const from = Math.floor((now - span) / step) * step;
  const r = rng(seed);
  const spark: SystemSpark = { step_seconds: step, t: [], n: [], avg: [] };
  for (let t = from; t + step <= now + step; t += step) {
    const frac = (t - from) / span;
    spark.t.push(t);
    spark.n.push(1);
    spark.avg!.push(size - growth * (1 - frac) + growth * 0.02 * (r() - 0.5));
  }
  return spark;
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;

export function systemHealth(range: MetricsRange, mode: string | null, nowMs = Date.now()): SystemHealth {
  const now = Math.floor(nowMs / 1000);
  const span = SPAN[range];
  const fresh = mode === "fresh";
  const busy = mode === "busy";
  const iso = (s: number) => new Date(s * 1000).toISOString();
  const plugins: SystemEventRow[] = fresh
    ? []
    : [
        eventRow("subscription/fetch", range, now, 0.8, 0.31, 1.42, busy ? 0.06 : 0.004, 11, "latticenet.vpn-core"),
        eventRow("subscription/render", range, now, 2.4, 0.045, 0.18, 0, 12, "latticenet.vpn-core"),
        eventRow("lines/list", range, now, 0.6, 0.012, 0.041, 0, 13, "latticenet.vpn-core"),
        eventRow("users/list", range, now, 0.3, 0.009, 0.033, 0, 14, "latticenet.vpn-core"),
        eventRow("execute", range, now, 0.002, 2.1, 4.8, 0, 15, "latticenet.vpn-core"),
        eventRow("subscription/convert", range, now, 0.4, 0.21, 0.66, 0.01, 21, "latticenet.sub-store"),
        eventRow("subscription/preview", range, now, 0.05, 0.38, 0.92, 0, 22, "latticenet.sub-store"),
        eventRow("zones/list", range, now, 0.2, 0.004, 0.011, 0, 31, "latticenet.netguard"),
        eventRow("bindings/plan", range, now, 0.01, 0.09, 0.24, 0, 32, "latticenet.netguard"),
        eventRow("networks/list", range, now, 0.1, 0.006, 0.02, 0, 41, "latticenet.wireguard"),
      ];
  if (busy) {
    plugins.push(
      eventRow(
        "subscription/import-provider-with-a-rather-long-method-name-that-wraps",
        range,
        now,
        0.03,
        3.2,
        9.4,
        0.12,
        16,
        "latticenet.vpn-core",
      ),
    );
  }
  const routeNames = [
    ["/api/agent/metrics", 6.8, 0.004, 0.019],
    ["/api/agent/tasks", 6.8, 0.006, 0.031],
    ["/api/agent/monitor-results", 23, 0.005, 0.022],
    ["/api/agent/guard-reality", 1.1, 0.03, 0.42],
    ["/api/agent/singbox-inventory", 0.6, 0.02, 0.11],
    ["/api/agent/config", 2.3, 0.003, 0.012],
    ["/api/agent/logs", 3.4, 0.008, 0.06],
    ["/api/nodes", 1.4, 0.011, 0.052],
    ["/api/monitors", 0.9, 0.021, 0.09],
    ["/api/plugins", 1.8, 0.33, 1.6],
    ["/api/network", 0.4, 0.016, 0.08],
    ["/api/incidents", 0.6, 0.006, 0.02],
    ["/api/tasks", 0.3, 0.012, 0.07],
    ["/api/audit", 0.05, 0.24, 0.81],
    ["/api/system", 0.2, 0.018, 0.06],
    ["/sub", 0.7, 0.09, 0.31],
    ["/", 0.4, 0.002, 0.009],
  ] as const;
  const http: SystemEventRow[] = fresh
    ? []
    : routeNames.map(([name, rate, p50, p95], i) => eventRow(name, range, now, rate, p50, p95, name === "/api/plugins" ? 0.012 : 0, 100 + i));
  if (busy) {
    for (let i = 0; i < 43; i++) http.push(eventRow(`/api/area-${String(i).padStart(2, "0")}`, range, now, 0.01 * (i + 1), 0.01, 0.04 + i * 0.01, 0, 200 + i));
    http.push(eventRow("/api (unmatched)", range, now, 0.3, 0.001, 0.003, 0, 299));
  }
  const store: SystemEventRow[] = fresh
    ? []
    : [
        eventRow("UpsertGuardRealitySnapshot", range, now, 0.33, 0.21, 0.48, 0, 301),
        eventRow("UpdateMetrics", range, now, 0.17, 0.19, 0.41, 0, 302),
        eventRow("MarkStaleNodesOffline", range, now, 0.02, 0.2, 0.37, 0, 303),
        eventRow("UpsertPluginInstallation", range, now, 0.001, 0.22, 0.3, 0, 304),
        eventRow("TouchNodeToken", range, now, 0.003, 0.18, 0.28, busy ? 0.25 : 0, 305),
      ];
  const files = [
    { label: "state.json", path: "/var/lib/lattice/state.json", size: 16 * MB, growth: 0.4 * MB },
    { label: "audit-wal", path: "/var/lib/lattice/state.json.audit-wal", size: 810 * MB, growth: 38 * MB },
    { label: "logs.db", path: "/var/lib/lattice/logs.db", size: 212 * MB, growth: 6 * MB },
    { label: "trace.db", path: "/var/lib/lattice/trace.db", size: 96 * MB, growth: 11 * MB },
    { label: "state-hot.db", path: "/var/lib/lattice/state-hot.db", size: 1.5 * GB, growth: 120 * MB },
    { label: "metrics.db", path: "/var/lib/lattice/metrics.db", size: fresh ? 32 * 1024 : 61 * MB, growth: 4 * MB },
  ].map((f, i) => ({
    label: f.label,
    path: f.path,
    size_bytes: fresh ? undefined : f.size,
    spark: fresh ? { step_seconds: 1800, t: [], n: [], avg: [] } : fileSpark(range, now, f.size, f.growth * (span / (30 * 86400)), 400 + i),
  }));
  const lastWrite = fresh ? undefined : busy ? now - 260 : now - 25;
  return {
    observed_at: iso(now),
    range,
    from: iso(now - span),
    to: iso(now),
    process: {
      started_at: iso(fresh ? now - 70 : now - 3 * 3600 - 1260),
      uptime_seconds: fresh ? 70 : 3 * 3600 + 1260,
      version: "alpha-0.2.2a116",
      commit: "7c97fc2",
      go_version: "go1.26.6",
      cpus: 2,
      cpu_percent: fresh ? undefined : 11.8,
      rss_bytes: 931 * MB,
      heap_bytes: 412 * MB,
      go_total_bytes: 690 * MB,
      goroutines: 1204,
      gc_pause_max_seconds: 0.0012,
      open_fds: 187,
    },
    host: {
      load1: 0.42,
      load5: 0.51,
      load15: 0.47,
      mem_total_bytes: 3.9 * GB,
      mem_available_bytes: busy ? 0.32 * GB : 0.96 * GB,
      data_dir: "/var/lib/lattice",
      disk_total_bytes: 99 * GB,
      disk_free_bytes: 9.7 * GB,
      disk_used_bytes: 89.3 * GB,
    },
    files,
    store,
    http,
    plugins,
    plugin_processes: fresh
      ? []
      : [
          { plugin: "latticenet.vpn-core", processes: Math.round(span / 600), cpu_seconds: span / 220, peak_rss_bytes: 61 * MB },
          { plugin: "latticenet.sub-store", processes: Math.round(span / 1800), cpu_seconds: span / 900, peak_rss_bytes: 88 * MB },
        ],
    metrics_store: {
      path: "/var/lib/lattice/metrics.db",
      size_bytes: fresh ? 32 * 1024 : 61 * MB,
      series: fresh ? 0 : busy ? 1009 : 371,
      max_series: 1024,
      max_series_per_owner: 256,
      owners: fresh ? 0 : busy ? 140 : 42,
      dropped_series: busy ? 23 : 0,
      slots_per_series: 10902,
      tiers: TIERS.map((t) => ({
        name: t.name,
        resolution_seconds: t.res,
        retention_seconds: t.keep,
        slots_per_series: t.keep / t.res,
        rows: fresh ? 0 : Math.round(Math.min(t.keep, 9 * 86400) / t.res) * 42,
        last_rolled: fresh ? undefined : Math.floor(now / t.res) * t.res - t.res,
      })),
      last_write: {
        at: iso(lastWrite ? Math.floor(lastWrite / 60) * 60 - 60 : 0),
        points: fresh ? 0 : 333,
        rows: fresh ? 0 : 41,
        dropped: 0,
        rolled: 1,
        trimmed: 41,
        duration: 7_400_000,
      },
      last_write_at: lastWrite ? iso(lastWrite) : undefined,
      last_write_error: undefined,
      sample_seconds: 10,
    },
  };
}

export function systemSeries(owner: string, names: string[], range: MetricsRange, points: number, mode: string | null, nowMs = Date.now()): MetricsQuery {
  const now = Math.floor(nowMs / 1000);
  const { tier, step } = stepFor(range, points);
  const iso = (s: number) => new Date(s * 1000).toISOString();
  const fresh = mode === "fresh";
  const shapes: Record<string, { unit: MetricsSeries["unit"]; shape: Shape }> = {
    "host.mem_used": { unit: "bytes", shape: { base: 2.9 * GB, wave: 0.04, noise: 0.05, drift: 0.03, spikes: 0.01, max: 3.9 * GB } },
    "host.mem_total": { unit: "bytes", shape: { base: 3.9 * GB } },
    "host.load1": { unit: "load", shape: { base: 0.45, wave: 0.3, noise: 0.5, spikes: 0.03 } },
    "proc.rss": { unit: "bytes", shape: { base: 900 * MB, wave: 0.02, noise: 0.04, drift: 0.05, spikes: 0.01 } },
    "proc.heap": { unit: "bytes", shape: { base: 400 * MB, wave: 0.05, noise: 0.12 } },
    "proc.cpu": { unit: "percent", shape: { base: 11, wave: 0.3, noise: 0.6, spikes: 0.04 } },
    "host.disk_used": { unit: "bytes", shape: { base: 89 * GB, noise: 0.002, drift: 0.004 } },
    "host.disk_total": { unit: "bytes", shape: { base: 99 * GB } },
  };
  const series = fresh
    ? []
    : names.filter((n) => shapes[n]).map((n, i) => gaugeSeries(n, shapes[n]!.unit, range, points, now, shapes[n]!.shape, 900 + i));
  return {
    owner,
    tier: tier.name,
    resolution_seconds: tier.res,
    step_seconds: step,
    from: iso(Math.floor((now - SPAN[range]) / step) * step),
    to: iso(now),
    retained_from: iso(now - tier.keep),
    series,
  };
}

export function nodeHistory(nodeId: string, range: MetricsRange, mode: string | null, nowMs = Date.now()): MetricsQuery {
  const now = Math.floor(nowMs / 1000);
  const points = 360;
  const { tier, step } = stepFor(range, points);
  const iso = (s: number) => new Date(s * 1000).toISOString();
  const seed = [...nodeId].reduce((a, c) => a + c.charCodeAt(0), 0);
  const gaps: [number, number][] = mode === "gaps" ? [[0.55, 0.62], [0.9, 0.905]] : [];
  const g = (name: string, unit: MetricsSeries["unit"], shape: Shape, k: number) => gaugeSeries(name, unit, range, points, now, shape, seed * 7 + k, gaps);
  const series =
    mode === "empty"
      ? ["cpu", "mem", "disk", "load1", "net_rx", "net_tx", "beat_gap"].map((name) => ({ name, kind: "gauge" as const, unit: "" as const, t: [], avg: [], min: [], max: [], n: [] }))
      : [
          g("beat_gap", "seconds", { base: 10, noise: 0.08, spikes: 0.015 }, 1),
          g("cpu", "percent", { base: 18, wave: 0.4, noise: 0.5, spikes: 0.05, max: 100 }, 2),
          g("disk", "percent", { base: 61, noise: 0.004, drift: 0.05, max: 100 }, 3),
          g("load1", "load", { base: 0.3, wave: 0.5, noise: 0.6, spikes: 0.03 }, 4),
          g("mem", "percent", { base: 54, wave: 0.05, noise: 0.06, drift: 0.04, max: 100 }, 5),
          g("net_rx", "bytes_per_second", { base: 1.8 * MB, wave: 0.6, noise: 0.5, spikes: 0.04 }, 6),
          g("net_tx", "bytes_per_second", { base: 0.9 * MB, wave: 0.6, noise: 0.5, spikes: 0.04 }, 7),
        ];
  return {
    owner: `node/${nodeId}`,
    tier: tier.name,
    resolution_seconds: tier.res,
    step_seconds: step,
    from: iso(Math.floor((now - SPAN[range]) / step) * step),
    to: iso(now),
    retained_from: iso(now - tier.keep),
    series,
  };
}
