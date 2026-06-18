import { ref, computed, onScopeDispose, watch, unref, type Ref, type ComputedRef } from "vue";

/**
 * Polling-freshness signal for a socket-less dashboard. Given a `lastUpdated`
 * timestamp (the one `useAsyncData` exposes), it ticks once a second and derives
 * how stale the underlying data is. This is the basis of the "live" feel without
 * a websocket/SSE: the UI watches the age of the last successful poll and flips
 * between live → stale → dead as time passes since the last refresh.
 *
 * It returns STRUCTURED data only — no text and no i18n. A `FreshnessLabel`
 * component formats `state`/`seconds` into user-facing copy; `color` is a status
 * token class (text-success / text-warning / text-destructive) so the label can
 * be tinted without re-deriving the state.
 */
export type LiveState = "live" | "stale" | "dead" | "idle";

export interface UseLiveLabelOptions {
  /** Age (ms) past which data is considered stale. Default ~ one poll interval. */
  staleAfterMs?: number;
  /** Age (ms) past which data is considered dead. Default 3× staleAfterMs. */
  deadAfterMs?: number;
}

export interface LiveLabel {
  state: Ref<LiveState>;
  /** Whole seconds since the last update; 0 when never updated. */
  seconds: Ref<number>;
  /** Status token class matching the state, e.g. "text-warning". */
  color: Ref<string>;
}

const COLOR_BY_STATE: Record<LiveState, string> = {
  live: "text-success",
  stale: "text-warning",
  dead: "text-destructive",
  idle: "text-muted-foreground",
};

function toMillis(value: number | Date | null | undefined): number | undefined {
  if (value == null) return undefined;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? undefined : t;
  }
  return Number.isFinite(value) ? value : undefined;
}

export function useLiveLabel(
  lastUpdated: Ref<number | Date | null | undefined>,
  opts: UseLiveLabelOptions = {},
): LiveLabel {
  const { staleAfterMs = 8000, deadAfterMs = staleAfterMs * 3 } = opts;

  // Drives recomputation: bumped every second so the derived age stays live even
  // when `lastUpdated` itself does not change (e.g. polling has gone quiet).
  const now = ref(Date.now());
  let timer: ReturnType<typeof setInterval> | undefined;

  const ageMs: ComputedRef<number | undefined> = computed(() => {
    const ts = toMillis(unref(lastUpdated));
    if (ts === undefined) return undefined;
    return Math.max(0, now.value - ts);
  });

  const state = computed<LiveState>(() => {
    const age = ageMs.value;
    if (age === undefined) return "idle";
    if (age > deadAfterMs) return "dead";
    if (age >= staleAfterMs) return "stale";
    return "live";
  });

  const seconds = computed(() => {
    const age = ageMs.value;
    return age === undefined ? 0 : Math.floor(age / 1000);
  });

  const color = computed(() => COLOR_BY_STATE[state.value]);

  function tick() {
    now.value = Date.now();
  }

  function start() {
    if (timer) return;
    tick();
    timer = setInterval(tick, 1000);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  // Snap to the new timestamp immediately on a fresh poll rather than waiting
  // for the next tick, so the label turns "live" the instant data arrives.
  watch(lastUpdated, tick);

  start();
  onScopeDispose(stop);

  return { state, seconds, color };
}
