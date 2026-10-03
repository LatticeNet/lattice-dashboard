/**
 * What running a node's reconfigure command does to its agent binary.
 *
 * The server renders the Linux reconfigure command against one pinned stable
 * agent release (`agent_version` in its answer), and the installer it runs
 * always installs that binary. A command meant only to change launch flags
 * therefore also moves a node that reports another version, a newer
 * prerelease or an older release, to the pinned one. The manual command
 * installs nothing.
 */
export interface ReconfigureInstall {
  /** The release the command installs, as the server names it. */
  target: string;
  /** The version the node last reported, or "" when it never reported. */
  current: string;
  /** True when the node reports a version other than the target. */
  moves: boolean;
}

function bare(version: string): string {
  return version.trim().replace(/^v/i, "");
}

export function reconfigureInstall(
  agentVersion: string | undefined,
  nodeVersion: string | undefined,
  platform: "linux" | "manual",
): ReconfigureInstall | undefined {
  const target = agentVersion?.trim() ?? "";
  if (!target || platform !== "linux") return undefined;
  const current = nodeVersion?.trim() ?? "";
  return { target, current, moves: !!current && bare(current) !== bare(target) };
}
