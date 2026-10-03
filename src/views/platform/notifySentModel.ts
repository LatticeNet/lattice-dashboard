import type { NotifyAttempt, NotifyDeliveriesQuery, NotifyDelivery } from "@/lib/api";

import { failureCause, type FailureCause } from "@/views/platform/notificationsModel";

/**
 * The Sent log: the server's notification outbox, one row per message to one
 * channel. Kept free of Vue so `node --test` covers it directly.
 *
 * Every word on a row is composed here from structured fields (outcome,
 * attempts, role, redriven), so a zh-CN console never shows the server's
 * English reason. The server's fixed reason strings are matched to keys; one
 * the console does not know yet is shown as it came.
 */

/** How many rows the log asks for; the outbox holds up to 1000. */
export const SENT_LIMIT = 500;

export type SentState = "sent" | "failed" | "retrying" | "queued" | "not_routed";

export function sentState(delivery: Pick<NotifyDelivery, "outcome" | "attempts">): SentState {
  switch (delivery.outcome) {
    case "sent":
      return "sent";
    case "failed":
      return "failed";
    case "no_route":
      return "not_routed";
    default:
      return (delivery.attempts?.length ?? 0) > 0 ? "retrying" : "queued";
  }
}

/**
 * A sent row stays quiet text: most of the log is deliveries that worked, and
 * a column of green badges would bury the failures it exists to show.
 */
export type SentTone = "quiet" | "destructive" | "warning" | "secondary";

export function sentTone(state: SentState): SentTone {
  switch (state) {
    case "failed":
      return "destructive";
    case "retrying":
    case "queued":
      return "warning";
    case "not_routed":
      return "secondary";
    default:
      return "quiet";
  }
}

/** The latest failed attempt, which is what the row's cause names. */
export function lastFailedAttempt(delivery: Pick<NotifyDelivery, "attempts">): NotifyAttempt | undefined {
  const attempts = delivery.attempts ?? [];
  for (let i = attempts.length - 1; i >= 0; i -= 1) {
    if (!attempts[i]?.ok) return attempts[i];
  }
  return undefined;
}

/** Why a failed or retrying row has not delivered, from its receipts. */
export function sentCause(delivery: Pick<NotifyDelivery, "attempts">): FailureCause | undefined {
  const attempt = lastFailedAttempt(delivery);
  return attempt ? failureCause(attempt.kind, attempt.status) : undefined;
}

export type SentNoteKey =
  | "noRule"
  | "noChannel"
  | "noOtherChannel"
  | "redriven"
  | "interrupted"
  | "channelDeleted"
  | "channelDisabled";

/** A note under the row: a key the console words, or the server's text when the key is unknown. */
export type SentNote = { key: SentNoteKey } | { raw: string };

// The server's fixed reason strings (lattice-server notify_outbox.go). A
// failure sentence ("upstream status 401 after 4 attempts") is not here: the
// row composes that from its receipts.
const KNOWN_REASONS: Record<string, SentNoteKey> = {
  "no enabled rule routes this event type": "noRule",
  "no enabled channel": "noChannel",
  "no other enabled channel": "noOtherChannel",
  "redriven after restart": "redriven",
  "interrupted by restart, not retried": "interrupted",
  "channel deleted before delivery": "channelDeleted",
  "channel disabled before delivery": "channelDisabled",
};

const FAILURE_SENTENCE = /^(upstream status \d+|timed out|network error|channel config refused|send failed)( after \d+ attempts)?(, retrying)?$/;

export function sentNote(delivery: Pick<NotifyDelivery, "reason" | "redriven">): SentNote | undefined {
  const reason = (delivery.reason ?? "").trim();
  const known = KNOWN_REASONS[reason];
  if (known) return { key: known };
  if (delivery.redriven) return { key: "redriven" };
  if (!reason || FAILURE_SENTENCE.test(reason)) return undefined;
  return { raw: reason };
}

/**
 * A not-routed row stands for every repeat of its event within the hour
 * (the server folds them so a chatty unrouted type keeps one row): how many
 * times it happened and when last, or nothing for a row that happened once.
 */
export function sentOccurrences(
  delivery: Pick<NotifyDelivery, "repeats" | "last_seen_at" | "created_at">,
): { count: number; last: string } | undefined {
  const repeats = delivery.repeats ?? 0;
  if (repeats < 1) return undefined;
  return { count: repeats + 1, last: delivery.last_seen_at || delivery.created_at };
}

/** Filters the log offers. "planned" covers both retrying and queued rows. */
export const SENT_OUTCOMES = ["all", "failed", "planned", "no_route", "sent"] as const;
export type SentOutcomeFilter = (typeof SENT_OUTCOMES)[number];

export function parseSentOutcome(raw: unknown): SentOutcomeFilter {
  return SENT_OUTCOMES.includes(raw as SentOutcomeFilter) ? (raw as SentOutcomeFilter) : "all";
}

export interface SentFilters {
  outcome: SentOutcomeFilter;
  channel: string;
  event: string;
}

/** The server query for the filters: the server filters the whole outbox, then limits. */
export function sentQuery(filters: SentFilters, limit = SENT_LIMIT): NotifyDeliveriesQuery {
  const query: NotifyDeliveriesQuery = { limit };
  if (filters.outcome !== "all") query.outcome = filters.outcome;
  if (filters.channel) query.channel_id = filters.channel;
  if (filters.event) query.event_type = filters.event;
  return query;
}

/**
 * Event types for the filter: the ones the console knows the server sends,
 * plus any the loaded rows carry, so a webhook's or a plugin's type is
 * reachable once it has been seen, plus the one the address asks for, which
 * a filtered empty page would otherwise leave the select unable to show.
 */
export function sentEventChoices(
  known: readonly string[],
  rows: readonly Pick<NotifyDelivery, "event_type">[],
  current = "",
): string[] {
  const all = new Set(known.filter((type) => type !== "*"));
  for (const row of rows) if (row.event_type) all.add(row.event_type);
  if (current) all.add(current);
  return [...all].sort((a, b) => a.localeCompare(b));
}
