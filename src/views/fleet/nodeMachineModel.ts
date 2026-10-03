/**
 * The machine behind a node, as the node sheet shows it (r1-ux item 19):
 * who provides it, when it renews, and whether a passed renewal explains a
 * node that went quiet.
 *
 * Inventory already reads every machine the principal may see
 * (GET /api/machines answers one row per node with inventory:read, profiled
 * or not), so the sheet reads the same list and picks the open node's row.
 * An offline node whose renewal passed before it stopped reporting is most
 * likely unpaid, and the operator's next step is the provider's console, not
 * the agent.
 *
 * Framework-free so `node --test` covers it.
 */
import type { MachineView } from "@/lib/api/types";
import { renewalDate, renewalSetupIncomplete } from "@/views/fleet/inventoryCostModel";

const DAY_MS = 24 * 60 * 60 * 1000;

export type RenewalState =
  | { kind: "untracked" }
  | { kind: "incomplete" }
  | { kind: "passed"; date: string; days: number }
  | { kind: "today"; date: string }
  | { kind: "upcoming"; date: string; days: number; soon: boolean };

export type NodeMachine =
  /**
   * The list has no row for the node. GET /api/machines answers one row per
   * node the principal holds inventory:read for, so after a read that came
   * after the node enrolled (machinesNeedRead) this is a lack of access.
   */
  | { kind: "unreadable" }
  /** A row without a profile: the node is not in Inventory yet. */
  | { kind: "unprofiled"; machine: MachineView }
  | { kind: "profiled"; machine: MachineView; renewal: RenewalState };

/** Within this many days a renewal reads as soon, as Inventory's own tone does. */
export const RENEWAL_SOON_DAYS = 14;

/** Where the machine's renewal stands, from the server's own day count. */
export function renewalState(machine: MachineView): RenewalState {
  if (renewalSetupIncomplete(machine)) return { kind: "incomplete" };
  const date = renewalDate(machine);
  const days = machine.days_until_renewal;
  if (!date || days === undefined) return { kind: "untracked" };
  if (days < 0) return { kind: "passed", date, days: -days };
  if (days === 0) return { kind: "today", date };
  return { kind: "upcoming", date, days, soon: days <= RENEWAL_SOON_DAYS };
}

/** Renewal dates move by days, so one read serves every node opened within this. */
export const MACHINES_FRESH_MS = 60_000;

/**
 * When the sheet last read the machine list, and the nodes the page listed
 * as that read started. The page's list came from an earlier read, so every
 * node in it existed before the machine read began.
 */
export interface MachinesRead {
  at: number;
  listed: ReadonlySet<string>;
}

/**
 * Whether the sheet reads the machine list again on opening `nodeId`: it was
 * never read, the read is over a minute old, or it has no row for a node the
 * page did not list when the read started. GET /api/machines answers a row
 * for every node the principal may read, so a missing row for a node that
 * existed before the read is a lack of access, and reading again would only
 * say so again (stepping through several such nodes reads nothing). Only a
 * node that enrolled since may be missing for another reason.
 */
export function machinesNeedRead(machines: readonly MachineView[] | undefined, nodeId: string, read: MachinesRead, now: number): boolean {
  if (!machines || now - read.at > MACHINES_FRESH_MS) return true;
  if (machines.some((entry) => entry.node_id === nodeId)) return false;
  return !read.listed.has(nodeId);
}

/**
 * What the Machine row offers for the provider console. The link is sealed
 * on the server and revealed per step-up grant to inventory:admin, as on
 * Inventory; a principal without it learns only that one is stored.
 */
export type ConsoleAction = "reveal" | "stored" | "none";

export function consoleAction(machine: Pick<MachineView, "has_console_url">, canReveal: boolean): ConsoleAction {
  if (!machine.has_console_url) return "none";
  return canReveal ? "reveal" : "stored";
}

export function nodeMachine(machines: readonly MachineView[], nodeId: string): NodeMachine {
  const machine = machines.find((entry) => entry.node_id === nodeId);
  if (!machine) return { kind: "unreadable" };
  if (!machine.id) return { kind: "unprofiled", machine };
  return { kind: "profiled", machine, renewal: renewalState(machine) };
}

/**
 * Whether a passed renewal is a likely reason the node went quiet: it is not
 * reporting, its renewal date passed, and it went quiet on or after the day
 * before that date (a provider suspends on the due day or after it; a node
 * that went quiet a week before its bill fell due stopped for another
 * reason). Without a time it went quiet, a passed renewal is enough.
 */
export function likelyUnpaid(renewal: RenewalState, reporting: boolean, quietSince?: string): boolean {
  if (reporting || renewal.kind !== "passed") return false;
  if (!quietSince) return true;
  const quiet = Date.parse(quietSince);
  const due = Date.parse(`${renewal.date}T00:00:00Z`);
  if (Number.isNaN(quiet) || Number.isNaN(due)) return true;
  return quiet >= due - DAY_MS;
}
