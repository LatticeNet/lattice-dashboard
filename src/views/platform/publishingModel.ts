import type { PublishingRecord } from "@/lib/api";

/**
 * The publishing plane answers one question for the whole console: what URL is
 * this content visible at, and who may read it. A route decides the URL, an
 * origin decides where the bytes come from.
 *
 * These are pure so the rules that decide whether a route is actually serving
 * live in one place and can be tested without rendering a page.
 */

/** Display order. It matches the server's, so the table does not reshuffle. */
export const PUBLISHING_ORIGINS = ["kv", "static", "plugin"] as const;

export type PublishingState = "serving" | "disabled" | "expired";

/**
 * Whether a route is answering right now.
 *
 * Expiry is reported separately from disabled because they are different
 * operator problems: one was turned off on purpose, the other ran out while
 * nobody was looking.
 */
export function publishingState(record: PublishingRecord, now: Date = new Date()): PublishingState {
  if (!record.enabled) return "disabled";
  if (record.expires_at && new Date(record.expires_at).getTime() <= now.getTime()) {
    return "expired";
  }
  return "serving";
}

export function isServing(record: PublishingRecord, now: Date = new Date()): boolean {
  return publishingState(record, now) === "serving";
}

/** The path a route answers on, always rooted and without a trailing slash. */
export function routePath(record: PublishingRecord): string {
  const prefix = (record.path_prefix ?? "").replace(/^\/+|\/+$/g, "");
  return prefix ? `/${prefix}` : "/";
}

/**
 * The route as one readable string. A route with no hostname answers on every
 * host, which has to read as a deliberate fact rather than as missing data.
 */
export function routeLabel(record: PublishingRecord, anyHostLabel = "*"): string {
  const host = record.any_host || !record.hostname ? anyHostLabel : record.hostname;
  const path = routePath(record);
  return path === "/" ? host : `${host}${path}`;
}

/**
 * What the origin points at. For kv and static that is a bucket; for a plugin
 * route it is the share that owns it, and the bucket field carries the share id
 * rather than a bucket name.
 */
export function originTarget(record: PublishingRecord): string {
  return record.origin === "plugin" ? (record.share_id ?? record.bucket) : record.bucket;
}

/** Sort: origin first in display order, then host, then path. */
export function sortRecords(records: PublishingRecord[]): PublishingRecord[] {
  const rank = (origin: string) => {
    const index = (PUBLISHING_ORIGINS as readonly string[]).indexOf(origin);
    return index === -1 ? PUBLISHING_ORIGINS.length : index;
  };
  return [...records].sort((a, b) => {
    if (rank(a.origin) !== rank(b.origin)) return rank(a.origin) - rank(b.origin);
    if (a.hostname !== b.hostname) return a.hostname.localeCompare(b.hostname);
    return routePath(a).localeCompare(routePath(b));
  });
}

/**
 * The routes belonging to one share.
 *
 * The subscription page uses this so the URL it shows comes from the publishing
 * plane rather than from a second private idea of where a share lives.
 */
export function recordsForShare(records: PublishingRecord[], shareId: string): PublishingRecord[] {
  return records.filter((record) => record.origin === "plugin" && record.share_id === shareId);
}
