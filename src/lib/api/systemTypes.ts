/**
 * The control plane's self-monitoring reads (lattice-server
 * server_selfmon_api.go), served from its metrics store (metrics.db):
 * GET /api/system/health and /api/system/series for a full administrator,
 * GET /api/nodes/history for anyone who may read the node.
 */

/** The named ranges the server accepts. */
export type MetricsRange = "1h" | "6h" | "24h" | "7d" | "30d" | "90d" | "1y" | "5y";

/** The unit a series is recorded in. */
export type MetricsUnit = "percent" | "bytes" | "bytes_per_second" | "seconds" | "count" | "load" | "";

/**
 * One series, columnar. `t` is each bucket's start in unix seconds; a bucket
 * nothing was recorded in is absent, so two `t` values further apart than
 * the query's step are a gap. For a gauge, avg, min and max are the samples
 * and `n` their count; for an event (a request, a plugin call, a state write)
 * they are durations in seconds, `n` the events, `e` the failures, and p50
 * and p95 the duration quantiles.
 */
export interface MetricsSeries {
  name: string;
  kind: "gauge" | "event";
  unit?: MetricsUnit;
  t: number[];
  avg: number[];
  min: number[];
  max: number[];
  n: number[];
  e?: number[];
  p50?: number[];
  p95?: number[];
}

export interface MetricsQuery {
  owner: string;
  /** The tier the points came from: "1m", "5m", "1h" or "1d". */
  tier: string;
  resolution_seconds: number;
  /** Each bucket's width: the tier's resolution or a multiple of it. */
  step_seconds: number;
  from: string;
  to: string;
  /** The oldest instant the chosen tier still holds. */
  retained_from: string;
  series: MetricsSeries[];
}

export interface SystemSpark {
  step_seconds: number;
  t: number[];
  n: number[];
  e?: number[];
  p95?: number[];
  avg?: number[];
}

/** One store caller, route group or plugin method over the range. */
export interface SystemEventRow {
  /** Set on plugin rows. */
  plugin?: string;
  name: string;
  calls: number;
  errors: number;
  per_minute: number;
  p50_seconds: number;
  p95_seconds: number;
  max_seconds: number;
  avg_seconds: number;
  spark: SystemSpark;
}

export interface SystemFileRow {
  label: string;
  path: string;
  /** Absent until the self-monitor's first write after a start. */
  size_bytes?: number;
  spark: SystemSpark;
}

export interface SystemPluginProcessRow {
  plugin: string;
  processes: number;
  cpu_seconds: number;
  peak_rss_bytes: number;
}

export interface SystemTier {
  name: string;
  resolution_seconds: number;
  retention_seconds: number;
  slots_per_series: number;
  rows: number;
  last_rolled?: number;
}

export interface SystemMetricsStore {
  path: string;
  size_bytes: number;
  series: number;
  max_series: number;
  max_series_per_owner: number;
  owners: number;
  dropped_series: number;
  slots_per_series: number;
  tiers: SystemTier[];
  last_write: {
    at: string;
    points: number;
    rows: number;
    dropped: number;
    rolled: number;
    trimmed: number;
    /** Nanoseconds. */
    duration: number;
  };
  last_write_at?: string;
  last_write_error?: string;
  sample_seconds: number;
}

export interface SystemHealth {
  observed_at: string;
  range: string;
  from: string;
  to: string;
  process: {
    started_at: string;
    uptime_seconds: number;
    version: string;
    commit: string;
    go_version: string;
    cpus: number;
    /** Percent of one CPU; absent until two samples were taken. */
    cpu_percent?: number;
    rss_bytes?: number;
    heap_bytes: number;
    go_total_bytes: number;
    goroutines: number;
    gc_pause_max_seconds: number;
    open_fds?: number;
  };
  /** As the container sees the host; fields absent where the platform cannot read them. */
  host: {
    load1?: number;
    load5?: number;
    load15?: number;
    mem_total_bytes?: number;
    mem_available_bytes?: number;
    data_dir?: string;
    disk_total_bytes?: number;
    disk_free_bytes?: number;
    disk_used_bytes?: number;
  };
  files: SystemFileRow[];
  store: SystemEventRow[];
  http: SystemEventRow[];
  plugins: SystemEventRow[];
  plugin_processes: SystemPluginProcessRow[];
  metrics_store: SystemMetricsStore;
}
