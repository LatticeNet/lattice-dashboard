/**
 * Line chains for Monitoring's Topology layer in the fleet harness
 * (dev/fleet-monitoring.html?view=topology). Every route below is invented
 * on the fleet fixture's node names; production's chains are not recorded.
 *
 * `?chains=` picks the shape:
 *   some (default)  an IPLC relay in Hebei to Hong Kong, Hong Kong on to Los
 *                   Angeles (a two-hop route), a Tokyo relay that drifted, a
 *                   Shanghai relay still applying, one that failed with an
 *                   error, and one only planned (no exit decided yet)
 *   none            the server answers an empty list
 *
 * `?deny=chains` answers 403 and drops proxy:read; `?fail=chains` answers 502.
 */
import type { LineChainView } from "@/lib/api/index";

import { NODES, PARAMS, nodeByName } from "./fleetFixture";

const id = (name: string) => nodeByName(name)?.id ?? name;
const uuid = (n: number) => `0c1d${String(n).padStart(4, "0")}-6a2b-4f7e-9c1d-3b5a7e9f${String(n).padStart(4, "0")}`;

function chain(n: number, relay: string, exit: string | undefined, status: string, extra: Partial<LineChainView> = {}): LineChainView {
  return {
    source_line_uuid: uuid(n),
    source_node_id: id(relay),
    status,
    current: exit ? { target_line_uuid: uuid(100 + n), target_node_id: id(exit), artifact_digest: `sha256:${String(n).repeat(8)}`, status } : null,
    attempt: null,
    ...extra,
  };
}

export function lineChains(): LineChainView[] {
  if (PARAMS.get("chains") === "none" || NODES.length === 0) return [];
  return [
    chain(1, "[Metix]-mkcloud-hr-iplc", "[cd]-gomami-hk-turin-mini", "converged"),
    chain(2, "[cd]-gomami-hk-turin-mini", "[cd]-DMIT-pro-malibu", "converged"),
    chain(3, "[cd]-xuezhang-jp-nat", "[Metix]-DMIT-1", "drifted", { last_error: "target_line_changed" }),
    chain(4, "[cd]-volcengine-shanghai", "[cd]-linode-sgp", "applying", { attempt: { operation: "set", approval_id: "apr_chain_4", status: "applying" } }),
    chain(5, "[Metix]-Aaitr-jp-softbank-NAT", "[Metix]-VIRCS-ATT-VDS", "failed", {
      attempt: { operation: "replace", approval_id: "apr_chain_5", status: "failed", error_code: "apply_failed", error: "sing-box check: outbound chain-exit: dial 203.0.113.35:443: connection refused" },
      last_error: "sing-box check: outbound chain-exit: dial 203.0.113.35:443: connection refused",
    }),
    chain(6, "[cd]-bandwagon-dc6", undefined, "planned", { attempt: { operation: "set", candidate_target_line_uuid: uuid(206), approval_id: "apr_chain_6", status: "planned" } }),
  ];
}
