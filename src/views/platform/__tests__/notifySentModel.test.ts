import assert from "node:assert/strict";
import test from "node:test";

import type { NotifyDelivery } from "@/lib/api";

import {
  lastFailedAttempt,
  parseSentOutcome,
  SENT_LIMIT,
  sentCause,
  sentEventChoices,
  sentNote,
  sentOccurrences,
  sentQuery,
  sentState,
  sentTone,
} from "../notifySentModel.ts";

function row(over: Partial<NotifyDelivery>): NotifyDelivery {
  return { id: "nd_1", event_id: "evt_1", event_type: "node.offline", source: "server", outcome: "sent", created_at: "2026-10-02T09:00:00Z", ...over };
}

test("each outcome reads as one state, and a planned row is retrying once it has tried", () => {
  assert.equal(sentState(row({ outcome: "sent" })), "sent");
  assert.equal(sentState(row({ outcome: "failed" })), "failed");
  assert.equal(sentState(row({ outcome: "no_route" })), "not_routed");
  assert.equal(sentState(row({ outcome: "planned" })), "queued");
  assert.equal(
    sentState(row({ outcome: "planned", attempts: [{ at: "2026-10-02T09:00:01Z", ok: false, kind: "upstream_5xx", status: 502, duration_ms: 80 }] })),
    "retrying",
  );
});

test("a sent row stays quiet and only failures and pending rows are tinted", () => {
  assert.equal(sentTone("sent"), "quiet");
  assert.equal(sentTone("failed"), "destructive");
  assert.equal(sentTone("retrying"), "warning");
  assert.equal(sentTone("queued"), "warning");
  assert.equal(sentTone("not_routed"), "secondary");
});

test("the cause is the latest failed receipt, named from its kind and status", () => {
  const delivery = row({
    outcome: "sent",
    attempts: [
      { at: "t1", ok: false, kind: "timeout", duration_ms: 15000 },
      { at: "t2", ok: false, kind: "upstream_5xx", status: 503, duration_ms: 90 },
      { at: "t3", ok: true, duration_ms: 70 },
    ],
  });
  assert.equal(lastFailedAttempt(delivery)?.at, "t2");
  assert.deepEqual(sentCause(delivery), { key: "serverError", status: 503 });
  assert.equal(sentCause(row({ attempts: [{ at: "t", ok: true, duration_ms: 1 }] })), undefined);
});

test("the server's fixed reasons become keys, failure sentences are left to the receipts, and unknown text is kept", () => {
  assert.deepEqual(sentNote(row({ reason: "no enabled rule routes this event type" })), { key: "noRule" });
  assert.deepEqual(sentNote(row({ reason: "no other enabled channel" })), { key: "noOtherChannel" });
  assert.deepEqual(sentNote(row({ reason: "interrupted by restart, not retried" })), { key: "interrupted" });
  assert.deepEqual(sentNote(row({ reason: "channel deleted before delivery" })), { key: "channelDeleted" });
  assert.deepEqual(sentNote(row({ reason: "redriven after restart" })), { key: "redriven" });
  // A redriven row keeps its flag after a later attempt rewrites the reason.
  assert.deepEqual(sentNote(row({ reason: "upstream status 502, retrying", redriven: true })), { key: "redriven" });
  for (const reason of ["upstream status 401", "upstream status 502 after 4 attempts", "timed out after 2 attempts, retrying", "channel config refused"]) {
    assert.equal(sentNote(row({ reason })), undefined, reason);
  }
  assert.deepEqual(sentNote(row({ reason: "something new the server says" })), { raw: "something new the server says" });
  assert.equal(sentNote(row({})), undefined);
});

test("filters become the server query, and an unknown outcome in the address reads as all", () => {
  assert.deepEqual(sentQuery({ outcome: "all", channel: "", event: "" }), { limit: SENT_LIMIT });
  assert.deepEqual(sentQuery({ outcome: "failed", channel: "ch_bark_urgent", event: "node.offline" }, 100), {
    limit: 100,
    outcome: "failed",
    channel_id: "ch_bark_urgent",
    event_type: "node.offline",
  });
  assert.equal(parseSentOutcome("planned"), "planned");
  assert.equal(parseSentOutcome("bogus"), "all");
  assert.equal(parseSentOutcome(undefined), "all");
});

test("the event filter offers known types and any type the rows carry, without the wildcard", () => {
  assert.deepEqual(
    sentEventChoices(["*", "node.offline", "monitor.down"], [row({ event_type: "plugin.latticenet.sub-store.message" }), row({ event_type: "node.offline" })]),
    ["monitor.down", "node.offline", "plugin.latticenet.sub-store.message"],
  );
  // A type from the address that no loaded row carries is still offered, so the select can show it.
  assert.deepEqual(sentEventChoices(["node.offline"], [], "backup.finished"), ["backup.finished", "node.offline"]);
});

test("a folded not-routed row counts every occurrence and names the latest", () => {
  assert.equal(sentOccurrences(row({ outcome: "no_route" })), undefined);
  assert.equal(sentOccurrences(row({ outcome: "no_route", repeats: 0 })), undefined);
  assert.deepEqual(sentOccurrences(row({ outcome: "no_route", repeats: 36, last_seen_at: "2026-10-02T09:58:00Z" })), {
    count: 37,
    last: "2026-10-02T09:58:00Z",
  });
  // An older server without last_seen_at still reads.
  assert.deepEqual(sentOccurrences(row({ outcome: "no_route", repeats: 1 })), { count: 2, last: "2026-10-02T09:00:00Z" });
});

test("an incident's held message reads as held, and its reason is worded from the values it names", () => {
  const now = Date.parse("2026-10-03T12:00:00Z");
  assert.equal(sentState(row({ outcome: "suppressed" }), now), "held");
  assert.equal(sentTone("held"), "secondary");
  // Quiet hours hold a planned row until they end; once it tried, it is retrying like any other.
  assert.equal(sentState(row({ outcome: "planned", held_until: "2026-10-03T23:00:00Z" }), now), "held");
  assert.equal(sentState(row({ outcome: "planned", held_until: "2026-10-03T11:00:00Z" }), now), "queued");
  assert.deepEqual(sentNote(row({ outcome: "suppressed", reason: 'held by maintenance window "Kernel upgrade" until 2026-10-03T13:00:00Z' })), {
    key: "heldMaintenance",
    params: { name: "Kernel upgrade", until: "2026-10-03T13:00:00Z" },
  });
  assert.deepEqual(sentNote(row({ outcome: "suppressed", reason: "snoozed until 2026-10-03T14:30:00Z" })), { key: "heldSnoozed", params: { until: "2026-10-03T14:30:00Z" } });
  assert.deepEqual(sentNote(row({ outcome: "suppressed", reason: "flapping (5 reopenings within 1h), at most one message an hour" })), { key: "heldFlapping", params: { n: 5 } });
  assert.deepEqual(sentNote(row({ outcome: "sent", held_until: "2026-10-03T07:00:00Z" })), { key: "quietHours", params: { until: "2026-10-03T07:00:00Z" } });
  assert.deepEqual(sentNote(row({ outcome: "sent", bark_level: "critical" })), { key: "escalation", params: { level: "critical" } });
});

test("a held message withdrawn when quiet hours ended reads as held and says why it never went out", () => {
  const withdrawnOpen = row({
    outcome: "suppressed",
    held_until: "2026-10-03T07:00:00Z",
    reason: "withdrawn when quiet hours ended: the incident was resolved, acknowledged or snoozed meanwhile",
  });
  const withdrawnRecovery = row({
    outcome: "suppressed",
    held_until: "2026-10-03T07:00:00Z",
    reason: "withdrawn when quiet hours ended: the open message it answers was withdrawn too",
  });
  assert.equal(sentState(withdrawnOpen, Date.parse("2026-10-03T08:00:00Z")), "held");
  // The withdrawal wins over the quiet hours note the row's held_until would give.
  assert.deepEqual(sentNote(withdrawnOpen), { key: "withdrawnOpen" });
  assert.deepEqual(sentNote(withdrawnRecovery), { key: "withdrawnRecovery" });
});
