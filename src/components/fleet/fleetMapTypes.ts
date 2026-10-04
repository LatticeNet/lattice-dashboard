/**
 * What the fleet map draws and what its card says, shared by FleetMap,
 * FleetMapCard and the Map page that reads the facts.
 */
import type { NodeStatusInput } from "@/lib/nodeStatus";
import type { ArcReading } from "@/views/fleet/fleetMapModel";

export interface FleetMapNode extends NodeStatusInput {
  id: string;
  name?: string;
  agent_version?: string;
  geo?: {
    lat?: number;
    lon?: number;
    city?: string;
    region?: string;
    country?: string;
    asn?: number;
    as_org?: string;
    provider?: string;
    /** "operator" when someone set it; otherwise a GeoIP lookup. */
    source?: string;
  };
}

/** One target's last hour from the latency source, as the matrix reads it. */
export interface LatencyFact extends ArcReading {
  p50Ms?: number;
  samples?: number;
  expected?: number;
}

/** Where a secondary read stands: read, reading, failed, or not readable with this access. */
export type FactState = "ready" | "loading" | "failed" | "denied";

/** What the page read beside the node list, for the card and the arcs. */
export interface FleetMapFacts {
  /** Open or acknowledged incidents per node id. */
  incidents?: ReadonlyMap<string, number>;
  incidentsState: FactState;
  /**
   * The first configured latency source and its targets' readings, with the
   * loss share from which an arc is dashed (latencyModel.LOSS_ATTENTION,
   * passed in so Home's map does not load the latency model).
   */
  latency?: { sourceId: string; sourceName: string; readings: ReadonlyMap<string, LatencyFact>; lossAttention: number };
  /** nosource: the probes have no source configured. */
  latencyState: FactState | "nosource";
}
