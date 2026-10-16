/**
 * Monitoring history retention (design 29 D4): how many days of five-minute
 * rollups the store keeps, between the bounds the server sends, and what that
 * costs on disk.
 *
 * The server measures the store and projects the size at the current setting.
 * For a setting the operator is choosing, the console moves that projection
 * by the fine tier's cost per path per day (about 60 KB: 100 paths cost about
 * 6 MB per day of retention), so the figure answers "what if" without a read.
 * Lowering retention frees pages for reuse inside the file; bbolt never
 * shrinks it, and the page says so before the save.
 *
 * Kept free of Vue so `node --test` covers it directly.
 */
import type { MonitorSettings } from "@/lib/api/types";

/** Fine rollup bytes per path per day of retention, on disk (design 29 D4). */
export const FINE_BYTES_PER_PATH_DAY = 60_000;
/** Above this many paths at intervals under 30 s the store grows fast enough to warn. */
export const LARGE_MESH_PATHS = 300;
export const LARGE_MESH_INTERVAL_SEC = 30;

export function retentionBounds(settings: Pick<MonitorSettings, "fine_min_days" | "fine_max_days">): { min: number; max: number } {
  const min = settings.fine_min_days > 0 ? settings.fine_min_days : 3;
  const max = settings.fine_max_days >= min ? settings.fine_max_days : 14;
  return { min, max };
}

export function retentionValid(days: number, settings: Pick<MonitorSettings, "fine_min_days" | "fine_max_days">): boolean {
  const { min, max } = retentionBounds(settings);
  return Number.isInteger(days) && days >= min && days <= max;
}

/** The projected size at `days`, from the server's projection at its current setting. */
export function projectedBytesAt(settings: MonitorSettings, days: number): number {
  const delta = (days - settings.fine_retention_days) * settings.paths * FINE_BYTES_PER_PATH_DAY;
  return Math.max(0, Math.round(settings.projected_bytes + delta));
}

/** A save that lowers retention frees space inside the file, not on the disk. */
export function lowersRetention(settings: Pick<MonitorSettings, "fine_retention_days">, days: number): boolean {
  return days < settings.fine_retention_days;
}

/** The store grows quickly: many paths probed often. */
export function largeMesh(paths: number, shortestIntervalSec: number | undefined): boolean {
  return paths > LARGE_MESH_PATHS && shortestIntervalSec !== undefined && shortestIntervalSec < LARGE_MESH_INTERVAL_SEC;
}
