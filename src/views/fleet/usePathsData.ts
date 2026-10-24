/**
 * Monitoring's path reads, shared by Overview, Paths, Checks and Topology.
 *
 * The matrix comes from GET /api/monitors/paths for the page's window. A
 * server from before design 29 answers 404 (or 405); the read then builds the
 * same matrix from the latency plan and rollups and remembers that this
 * server is a legacy one, so the next poll goes straight there and the window
 * control offers the three windows it can answer. A missing route is never an
 * error and never a toast. The retention settings are read the same way: a
 * missing route hides retention and the 14 day window.
 */
import { computed, ref, watch, type ComputedRef, type Ref } from "vue";

import { api, type LatencyProbePlan, type MonitorSettings, type MonitorWindow, type PathsResponse } from "@/lib/api";
import { useAsyncData, type AsyncData } from "@/composables/useAsyncData";

import {
  availableWindows,
  buildPathsMatrix,
  effectiveWindow,
  isMissingRoute,
  looksLikePaths,
  pathsFromLatency,
  type PathsMatrix,
  type PathsSource,
} from "./pathsModel";
import { triangulate, type Triangulation } from "./triangulationModel";

export interface PathsData {
  /** Which server answered. */
  source: Ref<PathsSource>;
  /** The windows the page offers on this server. */
  offered: ComputedRef<MonitorWindow[]>;
  /** The window the reads use (the asked one, or the nearest offered). */
  window: ComputedRef<MonitorWindow>;
  pathsQuery: AsyncData<PathsResponse | undefined>;
  matrix: ComputedRef<PathsMatrix | undefined>;
  /** Where each down or degraded path's cause most likely sits (design 29 D13), worked out once for every layer. */
  triangulation: ComputedRef<Triangulation | undefined>;
  /** Retention settings; null when the server has no such route. */
  settingsQuery: AsyncData<MonitorSettings | null | undefined>;
  settings: ComputedRef<MonitorSettings | undefined>;
  /** The latency probe plan: the path set's configuration, for its editor and for pausing a generated path. */
  planQuery: AsyncData<LatencyProbePlan | undefined>;
  refresh: () => void;
}

export interface PathsDataOptions {
  requested: Ref<MonitorWindow>;
  canRead: Ref<boolean>;
  checkName: (monitorId: string) => string | undefined;
  /** A check definition's name: a definition's paths are named by it (design 32 R1). */
  definitionName?: (definitionId: string) => string | undefined;
  nodeName: (nodeId: string) => string | undefined;
  controlPlane: () => string;
  /**
   * Read the retention settings and the path set plan too (Monitoring's
   * editors need them). The node page's Paths card reads the matrix only.
   */
  extras?: boolean;
}

export function usePathsData(options: PathsDataOptions): PathsData {
  const source = ref<PathsSource>("unknown");

  const settingsQuery = useAsyncData<MonitorSettings | null | undefined>(
    async (signal) => {
      if (!options.canRead.value || source.value === "legacy" || options.extras === false) return null;
      try {
        const body = await api.monitors.settings.get({ signal });
        // Anything but the settings object (an HTML fallback) is a server without them.
        return body && typeof body === "object" && typeof body.fine_retention_days === "number" ? body : null;
      } catch (error) {
        // An older server has no settings; a reader without the scope sees none. Neither is an error here.
        if (isMissingRoute(error) || (error as { status?: number }).status === 403) return null;
        throw error;
      }
    },
    { pollInterval: 120000, immediate: options.canRead.value },
  );
  const settings = computed(() => settingsQuery.data.value ?? undefined);

  const offered = computed(() => availableWindows(source.value, settings.value?.fine_retention_days));
  const window = computed(() => effectiveWindow(options.requested.value, offered.value));

  const pathsQuery = useAsyncData<PathsResponse | undefined>(
    async (signal) => {
      if (!options.canRead.value) return undefined;
      const w = window.value;
      if (source.value !== "legacy") {
        try {
          const body = await api.monitors.paths(w, { signal });
          if (looksLikePaths(body)) {
            source.value = "paths";
            return body;
          }
        } catch (error) {
          if (!isMissingRoute(error)) throw error;
        }
        source.value = "legacy";
      }
      const [plan, rollups] = await Promise.all([api.monitors.latency.plan({ signal }), api.monitors.latency.rollups({ signal })]);
      return pathsFromLatency(plan, rollups, w, Date.now());
    },
    { pollInterval: 30000, immediate: options.canRead.value },
  );

  watch(window, (next, previous) => {
    if (next !== previous) void pathsQuery.refresh();
  });

  const planQuery = useAsyncData<LatencyProbePlan | undefined>(
    (signal) => (options.canRead.value && options.extras !== false ? api.monitors.latency.plan({ signal }) : Promise.resolve(undefined)),
    { pollInterval: 30000, immediate: options.canRead.value },
  );

  const matrix = computed(() => {
    const data = pathsQuery.data.value;
    return data ? buildPathsMatrix(data, { checkName: options.checkName, definitionName: options.definitionName, nodeName: options.nodeName, controlPlane: options.controlPlane() }) : undefined;
  });

  const triangulation = computed(() => (matrix.value ? triangulate(matrix.value) : undefined));

  function refresh(): void {
    if (!options.canRead.value) return;
    void pathsQuery.refresh();
    void settingsQuery.refresh();
    void planQuery.refresh();
  }

  return { source, offered, window, pathsQuery, matrix, triangulation, settingsQuery, settings, planQuery, refresh };
}
