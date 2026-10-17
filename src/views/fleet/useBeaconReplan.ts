/**
 * The change plan a node's beacon needs (the server's replan), offered where
 * a path waits on it: the path sheet, the check sheet and the attention list
 * on Monitoring. The page provides it; it reads the node's beacon when asked
 * and opens the node.beacon change plan sheet, pre-filled as the server's
 * request words it (a change that keeps the port, the bind address and the
 * endpoint and re-plans the sources current when it is filed). A component
 * outside the page injects nothing and links to the node's Beacon card.
 */
import { inject, type InjectionKey, type Ref } from "vue";

import type { BeaconReplanItem } from "./beaconModel";

export interface BeaconReplanContext {
  /** The node's re-plan from the page's paths read, if it needs one. */
  replanFor(nodeId: string | undefined): BeaconReplanItem | undefined;
  /** The scopes this session lacks to file it; empty when it may. */
  missing(item: BeaconReplanItem): string[];
  /** A source's name, for the sentences. */
  nameOf(nodeId: string): string | undefined;
  /** Read the node's beacon and open the change plan sheet. */
  open(item: BeaconReplanItem): void;
  /** The node whose beacon is being read for the sheet, so its button says so. */
  opening: Ref<string | undefined>;
}

export const BEACON_REPLAN: InjectionKey<BeaconReplanContext> = Symbol("beaconReplan");

export function useBeaconReplan(): BeaconReplanContext | undefined {
  return inject(BEACON_REPLAN, undefined);
}
