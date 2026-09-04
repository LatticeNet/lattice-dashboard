/**
 * Demo objects on a control plane that drives real nodes.
 *
 * A page with nothing in it teaches nothing, and a page with fake rows lies.
 * The compromise the operator asked for is one honest record per feature that
 * can be exercised end to end without touching a node, created through the
 * ordinary API and deletable through it, and named so nobody mistakes it for
 * production. The name is the whole contract: `demo-` in front, and the
 * console marks the row and explains what it is.
 */
export const DEMO_PREFIX = "demo-";

/** Whether a record was created as a demo, by the naming contract above. */
export function isDemoObject(name: string | undefined): boolean {
  return (name ?? "").trim().toLowerCase().startsWith(DEMO_PREFIX);
}

/**
 * The first-run state: the feature has been tried with a demo and nothing
 * else. That is when the page owes the reader an explanation of what a real
 * object needs, and it stops owing it the moment a real one exists.
 */
export function onlyDemos(names: (string | undefined)[]): boolean {
  return names.length > 0 && names.every(isDemoObject);
}
