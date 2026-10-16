/**
 * What each node's beacon looks like on the harness's M2b server
 * (`?m2b=1`, design 29 D3 and D12). Plain data by node name, read by the
 * latency plan (dev/latencyFixture.ts), the paths (dev/pathsFixture.ts) and
 * the beacon routes (dev/beaconFixture.ts), so the matrix, the node page and
 * the editors tell one story. Every address, port and time is invented.
 *
 *   [cd]-xuezhang-jp-nat           NAT, listening on its private address, a
 *                                  mapped endpoint, NetGuard; cd-hs-sh admitted,
 *                                  hetzner-fsn uses it but waits (firewall pending)
 *   [Metix]-Aaitr-jp-softbank-NAT  NAT, listening, NetGuard, reached
 *   [cd]-hetzner-hel               listening, open to the internet, its provider
 *                                  drops UDP (reachability filtered)
 *   [Metix]-DMIT-1                 listening, open to the internet, nobody
 *                                  admitted yet (source pending)
 *   [cd]-racknerd-la               listening, NetGuard, cd-hs-sh not admitted
 *   [cd]-gomami-hk-turin-mini      enabled a minute ago: the agent not listening yet,
 *                                  its NetGuard rule still applying (firewall pending)
 *   [cd]-qqpw-vds-cd1              enabled, bind failed (address in use)
 *   [Metix]-qqpw-cd3-VDS           enabled, circuit breaker open
 *   [cd]-Oracle-KIX-arm            enabled, but the node runs -no-beacon
 *   [Metix]-mkcloud-hr-iplc        enabled, agent too old for a responder
 *   [cd]-linode-sgp                off, an enable plan waiting for approval (its port drawn)
 *   [cd]-DMIT-pro-malibu           off, planned once before (its port drawn); not under NetGuard
 *   [cd]-cloudcone-la              off, and the node refuses a beacon
 *   [cd]-volcengine-shanghai       off, agent too old
 *   any other node                 off, its agent ready
 */
import { PARAMS } from "./fleetFixture";

export const M2B = PARAMS.get("m2b") ?? "";

/** Agents older than M2b: no responder and no beacon client (the latency fixture's too-old agents). */
export const BEACON_TOO_OLD = new Set(["[cd]-volcengine-shanghai", "[Metix]-mkcloud-hr-iplc"]);

export interface BeaconShape {
  /** An applied plan enables it. */
  enabled: boolean;
  /** What the agent reports. */
  agent: "listening" | "off" | "bind_failed" | "circuit_open" | "refused" | "none";
  port?: number;
  bind?: string;
  /** host part; the port is the mapped one when set. */
  mappedPort?: number;
  exposure?: "netguard" | "internet";
  /** Approved sources, by node name. */
  approved?: string[];
  reach?: "reachable" | "filtered" | "not_listening" | "no_source" | "pending";
  /** The NetGuard rule of the applied plan has not applied yet: no source may probe. */
  companionPending?: boolean;
  /** The port the server drew for an earlier plan of a beacon that is off now. */
  drawnPort?: number;
  pendingApproval?: boolean;
  epoch?: number;
  error?: string;
}

const SHAPES: Record<string, BeaconShape> = {
  "[cd]-xuezhang-jp-nat": { enabled: true, agent: "listening", port: 47231, bind: "10.0.0.5", mappedPort: 50231, exposure: "netguard", approved: ["cd-hs-sh", "[cd]-DMIT-pro-malibu"], reach: "reachable", epoch: 3 },
  "[Metix]-Aaitr-jp-softbank-NAT": { enabled: true, agent: "listening", port: 44817, bind: "10.10.2.14", mappedPort: 50817, exposure: "netguard", approved: ["cd-hs-sh"], reach: "reachable", epoch: 1 },
  "[cd]-hetzner-hel": { enabled: true, agent: "listening", port: 51388, exposure: "internet", approved: ["cd-hs-sh"], reach: "filtered", epoch: 2 },
  "[Metix]-DMIT-1": { enabled: true, agent: "listening", port: 42006, exposure: "internet", approved: [], reach: "no_source", epoch: 1 },
  "[cd]-racknerd-la": { enabled: true, agent: "listening", port: 49152, exposure: "netguard", approved: [], reach: "no_source", epoch: 1 },
  "[cd]-gomami-hk-turin-mini": { enabled: true, agent: "off", port: 45509, exposure: "netguard", approved: ["cd-hs-sh"], epoch: 1, companionPending: true },
  "[cd]-qqpw-vds-cd1": { enabled: true, agent: "bind_failed", port: 47000, bind: "10.0.1.7", mappedPort: 50170, exposure: "netguard", approved: ["cd-hs-sh"], epoch: 1, error: "listen udp 10.0.1.7:47000: bind: address already in use" },
  "[Metix]-qqpw-cd3-VDS": { enabled: true, agent: "circuit_open", port: 46022, exposure: "internet", approved: ["cd-hs-sh"], epoch: 2, error: "drops above 50000 a second for 60 s; closed for 300 s" },
  "[cd]-Oracle-KIX-arm": { enabled: true, agent: "refused", port: 53111, exposure: "netguard", approved: ["cd-hs-sh"], epoch: 1 },
  "[Metix]-mkcloud-hr-iplc": { enabled: true, agent: "none", port: 41888, exposure: "internet", approved: ["cd-hs-sh"], epoch: 1 },
  "[cd]-linode-sgp": { enabled: false, agent: "off", pendingApproval: true, drawnPort: 55821 },
  "[cd]-DMIT-pro-malibu": { enabled: false, agent: "off", drawnPort: 54869 },
  "[cd]-cloudcone-la": { enabled: false, agent: "refused" },
};

/** The node's beacon on the harness; an agent before M2b reports nothing. */
export function beaconShape(name: string | undefined): BeaconShape {
  const shape = SHAPES[name ?? ""];
  if (shape) return shape;
  return { enabled: false, agent: BEACON_TOO_OLD.has(name ?? "") ? "none" : "off" };
}

/** The agent runs the beacon client: every agent of this release. */
export function runsBeaconClient(name: string | undefined): boolean {
  return !!M2B && !BEACON_TOO_OLD.has(name ?? "");
}

/** The endpoint sources send to: the node's public IPv4 with the mapped port, or the listen port. */
export function beaconEndpoint(shape: BeaconShape, publicIp: string | undefined): string {
  return `${publicIp ?? "203.0.113.1"}:${shape.mappedPort ?? shape.port}`;
}

/** Why no source may use the target's beacon (the server's beaconTargetGate), "" when sources may. */
export function beaconTargetGate(shape: BeaconShape): string {
  if (!shape.enabled) return "beacon_not_enabled";
  if (shape.companionPending) return "firewall_pending";
  if (shape.agent === "refused") return "refused_by_node";
  if (shape.agent === "none") return "beacon_not_listening";
  return "";
}

/** Why one source may not (beaconSourceGate): it is not approved by the applied plan. */
export function beaconSourceGate(shape: BeaconShape, sourceName: string): string {
  if ((shape.approved ?? []).includes(sourceName)) return "";
  return shape.exposure === "netguard" ? "firewall_pending" : "beacon_source_pending";
}

/** The target's agent listens where its plan put it. */
export function beaconListening(shape: BeaconShape): boolean {
  return shape.enabled && shape.agent === "listening";
}
