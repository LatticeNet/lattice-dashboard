/**
 * Which control plane you are looking at.
 *
 * An operator runs more than one of these: a laptop instance for trying things
 * and the real one that answers for the fleet. The console looked identical in
 * both, so the only thing distinguishing "I am about to approve a plan" from "I
 * am poking at a copy" was the address bar. That is a thin defence for a
 * console whose buttons reconfigure machines.
 *
 * This derives an identity from what the browser and the server already know.
 * It deliberately does not invent an "environment" setting: a label an operator
 * has to remember to set is a label that will be wrong on the day it matters.
 */

export type ControlPlaneKind = "local" | "remote";

export interface ControlPlaneIdentity {
  /** The host as an operator says it: "lattice.roobli.org", "localhost:5273". */
  host: string;
  kind: ControlPlaneKind;
  /** Server build, when it has been read. Empty until then — never guessed. */
  version: string;
  /** True when the served dashboard is not the one this server was built with. */
  dashboardDrift: boolean;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/** A loopback origin is a copy someone is working on, whatever it is serving. */
export function controlPlaneKind(host: string): ControlPlaneKind {
  const name = host.split(":")[0]?.toLowerCase() ?? "";
  if (LOCAL_HOSTS.has(name)) return "local";
  // A .local or .internal name is a lab box, not the thing the fleet answers to.
  if (name.endsWith(".local") || name.endsWith(".internal")) return "local";
  return "remote";
}

export function buildControlPlaneIdentity(input: {
  host: string;
  serverVersion?: string;
  dashboardRef?: string;
  expectedDashboardRef?: string;
}): ControlPlaneIdentity {
  return {
    host: input.host,
    kind: controlPlaneKind(input.host),
    version: (input.serverVersion ?? "").trim(),
    dashboardDrift:
      !!input.dashboardRef &&
      !!input.expectedDashboardRef &&
      input.dashboardRef !== input.expectedDashboardRef,
  };
}

/**
 * The short form for the collapsed rail: two or three characters an operator
 * can tell apart at a glance, taken from the host rather than invented.
 */
export function controlPlaneInitials(host: string): string {
  const name = host.split(":")[0] ?? "";
  if (controlPlaneKind(host) === "local") return "dev";
  const parts = name.split(".").filter(Boolean);
  const head = parts[0] ?? name;
  return head.slice(0, 3).toLowerCase();
}
