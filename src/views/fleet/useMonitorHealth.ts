/**
 * Each listed monitor's state, for the Monitoring list and Home
 * (monitorHealthModel). Reads the results of the enabled monitors, up to
 * HEALTH_READ_CAP of them, every 30 s and again whenever the set of enabled
 * monitors changes. One monitor whose read fails is left unread; the read as
 * a whole fails only when every monitor's read failed.
 */
import { computed, ref, watch, type Ref } from "vue";

import { api, unwrap, type MonitorResult, type MonitorView } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { HEALTH_READ_CAP, monitorHealth, type MonitorHealth } from "./monitorHealthModel";

export function useMonitorHealth(
  monitors: Ref<readonly MonitorView[] | undefined>,
  options: { enabled: () => boolean; pollInterval?: number },
) {
  const targets = computed(() => (monitors.value ?? []).filter((monitor) => monitor.enabled));
  const capped = computed(() => Math.max(0, targets.value.length - HEALTH_READ_CAP));

  const query = useAsyncData(
    async (signal) => {
      const read = targets.value.slice(0, HEALTH_READ_CAP);
      const out = new Map<string, MonitorResult[]>();
      if (!options.enabled() || read.length === 0) return out;
      const settled = await Promise.allSettled(
        read.map((monitor) => api.monitors.results(monitor.id, { signal }).then((r) => unwrap(r, "results"))),
      );
      settled.forEach((entry, index) => {
        if (entry.status === "fulfilled") out.set(read[index]!.id, entry.value);
      });
      if (out.size === 0) {
        const failed = settled.find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
        if (failed) throw failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason));
      }
      return out;
    },
    { pollInterval: options.pollInterval ?? 30_000, immediate: false },
  );

  watch(
    () => targets.value.map((monitor) => monitor.id).join(","),
    () => void query.refresh(),
    { immediate: true },
  );

  /** Ticks with each read, so "stale" is judged against the read's own time. */
  const now = ref(Date.now());
  watch(
    () => query.lastUpdated.value,
    (at) => {
      now.value = at ?? Date.now();
    },
  );

  function health(monitor: MonitorView): MonitorHealth {
    return monitorHealth(monitor, query.data.value?.get(monitor.id), now.value);
  }

  return { query, health, capped };
}
