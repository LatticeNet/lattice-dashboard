/**
 * What a design 29 M3 server sends, captured from the real handlers.
 *
 * The six files under ./m3-golden/ are byte for byte the files of
 * lattice-server internal/server/testdata/m3-golden/ at commit
 * f1ba66a6f2310f3440a6514533e4dd426a49a7ae (branch
 * feature/20261016_monitoring-paths-m3), written by TestM3GoldenResponses in
 * internal/server/monitor_degraded_golden_test.go. That test builds a fleet on
 * the production store layout (sources cd-hs-sh, hk-edge and fra-2; targets
 * fra-2, hk-edge and tyo-3; a week of one-minute runs; the clock fixed at
 * 2026-09-14), runs the degraded evaluator minute by minute and records what
 * the handlers serialize. Contract D13 names these files as the only source
 * of the console's M3 fixtures: never edit them by hand. When the server's
 * answers change, regenerate them there (LATTICE_UPDATE_M3_GOLDEN=1) and copy
 * them again, updating the commit above.
 *
 * The constants below type each file through the console's API types, so
 * `pnpm type-check` refuses a golden the types cannot hold, and the model
 * tests (src/views/fleet/__tests__/m3GoldenModel.test.ts) feed them through
 * the console's models. The fleet harness serves them verbatim with
 * `?m3=golden` (dev/pathsFixture.ts).
 */
import type { LatencyProbePlan, MonitorView, NotifyCatalogueEntry, PathSeriesQuery, PathSeriesResponse, PathsResponse } from "@/lib/api/types";

import monitors from "./m3-golden/monitors.json" with { type: "json" };
import catalogueEntries from "./m3-golden/notify-catalogue-path-entries.json" with { type: "json" };
import pathSet from "./m3-golden/path-set.json" with { type: "json" };
import paths1h from "./m3-golden/paths-1h.json" with { type: "json" };
import paths7d from "./m3-golden/paths-7d.json" with { type: "json" };
import series from "./m3-golden/series-degraded-latency-1h-previous.json" with { type: "json" };

/** The lattice-server commit the files were copied from. */
export const GOLDEN_SERVER_COMMIT = "f1ba66a6f2310f3440a6514533e4dd426a49a7ae";

/** The server's clock when it answered: the matrices' observed_at. */
export const GOLDEN_NOW = "2026-09-14T09:47:00Z";

/** GET /api/monitors/paths?window=1h */
export const GOLDEN_PATHS_1H: PathsResponse = paths1h;
/** GET /api/monitors/paths?window=7d */
export const GOLDEN_PATHS_7D: PathsResponse = paths7d;

/** The request GOLDEN_SERIES answers: hk-edge to tyo-3, degraded on latency, with the previous hour. */
export const GOLDEN_SERIES_QUERY: PathSeriesQuery = { source: "node-hk", target_node: "node-jp", window: "1h", compare: "previous" };
/** GET /api/monitors/series?source=node-hk&target_node=node-jp&window=1h&compare=previous */
export const GOLDEN_SERIES: PathSeriesResponse = series;

/** GET /api/monitors: the server answers the array itself, not wrapped in an object. */
export const GOLDEN_MONITORS: MonitorView[] = monitors;

/** GET /api/monitors/latency, the path set read. */
export const GOLDEN_PATH_SET: LatencyProbePlan = pathSet;

/** The path.degraded and path.recovered entries of GET /api/notify/catalogue, byte for byte. */
export const GOLDEN_CATALOGUE_PATH_ENTRIES: NotifyCatalogueEntry[] = catalogueEntries;
