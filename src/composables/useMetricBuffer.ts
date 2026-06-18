import { reactive } from "vue";
import type { Metrics } from "@/lib/api/types";

/**
 * Client-side ring buffer of recent polled node-metric samples. The server has
 * NO history endpoint and exposes NO websocket/SSE — the fleet is polled every
 * ~5s — so node cards/detail synthesize their own short-window sparklines by
 * appending each poll's snapshot here and reading back a fixed-length series.
 *
 * It is generic and dependency-free: per node it keeps a fixed-capacity ring of
 * derived sample points (so memory is bounded regardless of session length),
 * and `series()` projects one channel into a plain `number[]` ready for an
 * inline-SVG / uplot sparkline (no echarts, CSP-safe). Backed by a module-level
 * reactive store so independent components (a card and the detail view) observe
 * the SAME buffer and stay in sync without re-recording.
 */

/** Channels a sparkline can plot. cpu/memory/disk are percent (0–100); netRx/netTx are bytes/sec. */
export type MetricKey = "cpu" | "memory" | "disk" | "netRx" | "netTx";

/** One ring slot: a timestamp plus the derived value for every channel. */
export interface MetricSample {
  /** Epoch ms the sample was recorded (from `collected_at`, else record time). */
  at: number;
  cpu: number;
  memory: number;
  disk: number;
  netRx: number;
  netTx: number;
}

export interface UseMetricBufferOptions {
  /** Max samples retained per node; older ones are evicted. Default 60 (~5min @5s). */
  capacity?: number;
}

export interface MetricBuffer {
  /** Append the latest poll for a node, deriving each channel and evicting overflow. */
  record: (nodeId: string, metrics: Metrics | undefined | null) => void;
  /** Oldest→newest values for one channel; `[]` when the node is unseen. */
  series: (nodeId: string, key: MetricKey) => number[];
  /** Newest sample for a node, or `undefined` when unseen. */
  latest: (nodeId: string) => MetricSample | undefined;
  /** Drop all buffered samples (e.g. on logout / fleet reload). */
  clear: () => void;
}

const DEFAULT_CAPACITY = 60;

/** A bounded, oldest-first append log. Kept reactive so reads track new pushes. */
interface Ring {
  capacity: number;
  samples: MetricSample[];
}

// Module-level shared store: one ring per node id. `reactive` so component reads
// of `series()` recompute when `record()` pushes, without per-call subscriptions.
const store = reactive(new Map<string, Ring>());

function clampCapacity(capacity: number | undefined): number {
  if (capacity === undefined || !Number.isFinite(capacity)) return DEFAULT_CAPACITY;
  return Math.max(1, Math.floor(capacity));
}

/** Coerce a maybe-undefined numeric field to a finite number, else 0. */
function num(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** used/total as a 0–100 percent; 0 when total is missing/zero. */
function percentOf(used: number | undefined, total: number | undefined): number {
  const u = num(used);
  const t = num(total);
  if (t <= 0) return 0;
  return Math.min(100, Math.max(0, (u / t) * 100));
}

function toMillis(collectedAt: string | undefined): number {
  if (collectedAt) {
    const t = Date.parse(collectedAt);
    if (!Number.isNaN(t)) return t;
  }
  return Date.now();
}

function deriveSample(metrics: Metrics): MetricSample {
  return {
    at: toMillis(metrics.collected_at),
    cpu: num(metrics.cpu_percent),
    memory: percentOf(metrics.memory_used, metrics.memory_total),
    disk: percentOf(metrics.disk_used, metrics.disk_total),
    netRx: num(metrics.net_rx_speed),
    netTx: num(metrics.net_tx_speed),
  };
}

/**
 * Access the shared metric ring buffer. All callers share one module-level
 * store, so a node card recording polls and a detail view reading them observe
 * the same data. `capacity` only sizes rings created/grown after this call.
 */
export function useMetricBuffer(opts: UseMetricBufferOptions = {}): MetricBuffer {
  const capacity = clampCapacity(opts.capacity);

  function record(nodeId: string, metrics: Metrics | undefined | null): void {
    if (!nodeId || !metrics) return;
    const sample = deriveSample(metrics);

    let ring = store.get(nodeId);
    if (!ring) {
      ring = { capacity, samples: [] };
      store.set(nodeId, ring);
    } else if (capacity > ring.capacity) {
      // Honor a larger capacity requested by a later consumer.
      ring.capacity = capacity;
    }

    // De-dupe identical timestamps so repeated polls of an unchanged snapshot
    // (same `collected_at`) don't flat-line the sparkline with stale repeats.
    const last = ring.samples[ring.samples.length - 1];
    if (last && last.at === sample.at) {
      ring.samples[ring.samples.length - 1] = sample;
    } else {
      ring.samples.push(sample);
    }

    const overflow = ring.samples.length - ring.capacity;
    if (overflow > 0) ring.samples.splice(0, overflow);
  }

  function series(nodeId: string, key: MetricKey): number[] {
    const ring = store.get(nodeId);
    if (!ring) return [];
    return ring.samples.map((s) => s[key]);
  }

  function latest(nodeId: string): MetricSample | undefined {
    const ring = store.get(nodeId);
    if (!ring || ring.samples.length === 0) return undefined;
    return ring.samples[ring.samples.length - 1];
  }

  function clear(): void {
    store.clear();
  }

  return { record, series, latest, clear };
}
