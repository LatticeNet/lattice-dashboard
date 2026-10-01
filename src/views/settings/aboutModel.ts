/**
 * Whether the console in this tab is the build the server serves.
 *
 * A deploy is complete only when About shows the matching pair (the release
 * ritual in the workspace AGENTS.md). Both sides come from the image's
 * DASHBOARD_COMMIT build argument (lattice-server Dockerfile): the bundle bakes
 * it in as VITE_GIT_COMMIT and the server reports it as `dashboard_ref` from
 * LATTICE_DASHBOARD_COMMIT. A tab left open across a deploy keeps the bundle
 * it loaded, so its commit stops matching until the page reloads.
 *
 * `unknown` when either side carries no commit (a dev build, or a server that
 * was not built from the image): the page then claims nothing.
 */
export type BuildMatch = "same" | "different" | "unknown";

const NO_COMMIT = new Set(["", "unknown", "dev"]);

export function buildMatch(tabCommit: string | null | undefined, servedRef: string | null | undefined): BuildMatch {
  const tab = (tabCommit ?? "").trim().toLowerCase();
  const served = (servedRef ?? "").trim().toLowerCase();
  if (NO_COMMIT.has(tab) || NO_COMMIT.has(served)) return "unknown";
  if (tab === served) return "same";
  // One side may carry the short form of the same commit.
  const shorter = Math.min(tab.length, served.length);
  if (shorter >= 7 && (tab.startsWith(served) || served.startsWith(tab))) return "same";
  return "different";
}

/** A commit as the page prints it: the first 12 characters, the way git log --oneline reads. */
export function shortCommit(value: string | null | undefined): string {
  const text = (value ?? "").trim();
  return text.length > 12 ? text.slice(0, 12) : text;
}
