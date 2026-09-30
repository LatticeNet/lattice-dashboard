/**
 * What home's Tasks tile says, from GET /api/tasks/counts (design 23,
 * sections 1 and 5).
 *
 * The tile used to read all 1,771 tasks every 10 s to count the queued ones;
 * each tick aborted the last, so a reply slower than the interval never
 * landed, and one word, "unknown", stood for both "still reading" and "the
 * read failed". The counts read is small, and each state here says what is
 * true: reading, not read, a server too old to have the read, no access, or
 * the counts.
 *
 * Kept free of Vue so `node --test` covers it directly.
 */
import type { TaskCounts } from "@/lib/api/types";

export type TaskTileState = "reading" | "failed" | "unsupported" | "forbidden" | "ready";

export interface TaskTilePart {
  key: "queued" | "running" | "stalled" | "failed_24h";
  n: number;
  tone: "default" | "warning" | "destructive";
}

export interface TaskTile {
  state: TaskTileState;
  /**
   * The counts worth saying, worst first: stalled and failed lead so a
   * narrow tile that truncates keeps them; queued is always said.
   */
  parts: TaskTilePart[];
  /** A refresh failed after a good read; the parts are the last good ones. */
  stale: boolean;
  /** Where the tile drills to: the most urgent status it names. */
  status?: "stalled" | "queued" | "leased";
}

function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | undefined)?.status;
  return typeof status === "number" ? status : undefined;
}

export function taskCountsTile(input: { data?: TaskCounts; error?: unknown }): TaskTile {
  const code = statusOf(input.error);
  // A 404 is an older server: the read does not exist there, whatever was
  // read before (a rolled-back image), so no count is claimed.
  if (code === 404) return { state: "unsupported", parts: [], stale: false };
  const data = input.data;
  if (!data) {
    if (input.error) return { state: code === 403 ? "forbidden" : "failed", parts: [], stale: false };
    return { state: "reading", parts: [], stale: false };
  }
  const parts: TaskTilePart[] = [];
  if (data.stalled > 0) parts.push({ key: "stalled", n: data.stalled, tone: "warning" });
  if (data.failed_24h > 0) parts.push({ key: "failed_24h", n: data.failed_24h, tone: "destructive" });
  parts.push({ key: "queued", n: data.queued, tone: "default" });
  if (data.running > 0) parts.push({ key: "running", n: data.running, tone: "default" });
  const status = data.stalled > 0 ? "stalled" : data.queued > 0 ? "queued" : data.running > 0 ? "leased" : undefined;
  return { state: "ready", parts, stale: !!input.error, status };
}
