import assert from "node:assert/strict";
import { test } from "node:test";

import type { ConnRecord } from "../../../lib/api/types.ts";
import {
  CLOSE_REASONS,
  DEFAULT_CONN_TRACE_FILTERS,
  HOP_CONFIDENCES,
  TRACE_BYTES_UNKNOWN_KEY,
  TRACE_TTL_DEFAULT_SECONDS,
  TRACE_TTL_MAX_SECONDS,
  TRACE_TTL_MIN_SECONDS,
  USER_KINDS,
  activeFilterCount,
  appendConnPage,
  clampTraceTtlSeconds,
  closeReasonDisplay,
  connCloseCell,
  connRecordKey,
  connTraceFiltersEqual,
  connectionsRequestParams,
  destinationText,
  emptyConnTracePaging,
  hopConfidenceDisplay,
  isDefaultConnTraceFilters,
  isStalled,
  readConnTraceFilters,
  resolveTraceWindow,
  traceBytesCell,
  traceBytesCoverage,
  traceDurationCell,
  userCellDisplay,
  writeConnTraceFilters,
  type ConnTraceFilters,
} from "../connTraceModel.ts";

function record(partial: Partial<ConnRecord> = {}): ConnRecord {
  return {
    node_id: "node-a",
    log_id: 1,
    started_at: "2026-08-26T10:00:00.000Z",
    ...partial,
  };
}

/* ----------------------------- filters: url ----------------------------- */

test("filters round-trip through the query, multi-value dimensions included", () => {
  const filters: ConnTraceFilters = {
    range: "6h",
    since: "",
    until: "",
    nodeId: "node-a",
    userId: "11111111-2222-3333-4444-555555555555",
    lineUuid: "line-9",
    sessionId: "sess-3",
    dst: "example.com",
    closeReasons: ["timeout", "unknown"],
    userKinds: ["managed", "unresolved"],
    stalledOnly: true,
    includeOpen: true,
  };

  const query = writeConnTraceFilters({}, filters);
  assert.equal(query.close_reason, "timeout,unknown");
  assert.equal(query.user_kind, "managed,unresolved");
  assert.equal(query.stalled, "true");
  assert.equal(query.include_open, "true");

  assert.deepEqual(readConnTraceFilters(query), filters);
  assert.ok(connTraceFiltersEqual(readConnTraceFilters(query), filters));
});

test("a custom window round-trips its instants, a preset window does not carry them", () => {
  const custom: ConnTraceFilters = {
    ...DEFAULT_CONN_TRACE_FILTERS,
    range: "custom",
    since: "2026-08-26T08:00:00.000Z",
    until: "2026-08-26T09:30:00.000Z",
  };
  const query = writeConnTraceFilters({}, custom);
  assert.deepEqual(readConnTraceFilters(query), custom);

  // A preset resolves at request time, so storing bounds would freeze it.
  const preset = writeConnTraceFilters({}, { ...custom, range: "24h" });
  assert.equal(preset.since, undefined);
  assert.equal(preset.until, undefined);
  assert.equal(readConnTraceFilters(preset).since, "");
});

test("the default filter set writes no keys of its own and keeps everyone else's", () => {
  const query = writeConnTraceFilters(
    { tab: "sessions", "conn.sort": "started_at", node_id: "stale" },
    DEFAULT_CONN_TRACE_FILTERS,
  );
  assert.deepEqual(query, { tab: "sessions", "conn.sort": "started_at" });
  assert.ok(isDefaultConnTraceFilters(readConnTraceFilters(query)));
  assert.equal(activeFilterCount(DEFAULT_CONN_TRACE_FILTERS), 0);
});

test("a hand-edited query is validated, not trusted", () => {
  const filters = readConnTraceFilters({
    range: "nonsense",
    close_reason: "timeout,not_a_reason,EOF",
    user_kind: "managed,bogus",
    stalled: "1",
    include_open: "no",
    since: "not-a-date",
  });
  assert.equal(filters.range, DEFAULT_CONN_TRACE_FILTERS.range);
  // Canonical order, not the order the URL happened to use.
  assert.deepEqual(filters.closeReasons, ["eof", "timeout"]);
  assert.deepEqual(filters.userKinds, ["managed"]);
  assert.equal(filters.stalledOnly, true);
  assert.equal(filters.includeOpen, false);
  assert.equal(filters.since, "");
});

test("vue-router array query values resolve to their first usable string", () => {
  const filters = readConnTraceFilters({ node_id: ["node-a", "node-b"], dst: [null, "cdn"] });
  assert.equal(filters.nodeId, "node-a");
  assert.equal(filters.dst, "cdn");
});

/* --------------------------- filters: request --------------------------- */

test("a preset window resolves against the clock, a custom window is absolute", () => {
  const now = Date.parse("2026-08-26T12:00:00.000Z");
  assert.deepEqual(resolveTraceWindow({ ...DEFAULT_CONN_TRACE_FILTERS, range: "1h" }, now), {
    since: "2026-08-26T11:00:00.000Z",
    until: "",
  });
  assert.deepEqual(
    resolveTraceWindow(
      {
        ...DEFAULT_CONN_TRACE_FILTERS,
        range: "custom",
        since: "2026-01-01T00:00:00.000Z",
        until: "2026-01-02T00:00:00.000Z",
      },
      now,
    ),
    { since: "2026-01-01T00:00:00.000Z", until: "2026-01-02T00:00:00.000Z" },
  );
});

test("request params carry only the constrained dimensions", () => {
  const now = Date.parse("2026-08-26T12:00:00.000Z");
  const params = connectionsRequestParams(
    {
      ...DEFAULT_CONN_TRACE_FILTERS,
      range: "15m",
      nodeId: "node-a",
      dst: "example.com",
      closeReasons: ["reset", "timeout"],
      stalledOnly: true,
    },
    { limit: 100, cursor: "c-2", nowMs: now },
  );
  assert.deepEqual(params, {
    limit: 100,
    since: "2026-08-26T11:45:00.000Z",
    node_id: "node-a",
    dst: "example.com",
    close_reason: "reset,timeout",
    stalled: "true",
    cursor: "c-2",
  });
  // No cursor on the newest page, and no flags the operator did not set.
  const first = connectionsRequestParams(DEFAULT_CONN_TRACE_FILTERS, { limit: 50, nowMs: now });
  assert.equal(first.cursor, undefined);
  assert.equal(first.include_open, undefined);
  assert.equal(first.user_kind, undefined);
});

/* ----------------------------- close reason ----------------------------- */

test("every close reason maps to a label and a tone", () => {
  for (const reason of CLOSE_REASONS) {
    const display = closeReasonDisplay(reason);
    assert.equal(display.id, reason);
    assert.equal(display.labelKey, `platform.trace.closeReason.${reason}`);
    assert.ok(display.tone);
  }
});

test("unknown reads as unknown, never as success", () => {
  const success = closeReasonDisplay("eof");
  assert.equal(success.tone, "success");
  assert.equal(success.certain, true);

  for (const raw of ["unknown", "", undefined, "   "]) {
    const display = closeReasonDisplay(raw);
    assert.equal(display.id, "unknown", `raw ${JSON.stringify(raw)}`);
    assert.equal(display.certain, false);
    assert.notEqual(display.tone, "success");
  }

  // A value this build does not know is unknown too, and keeps what was sent.
  const surprise = closeReasonDisplay("teapot");
  assert.equal(surprise.id, "unknown");
  assert.equal(surprise.certain, false);
  assert.equal(surprise.raw, "teapot");
});

test("a still-open connection is open, not unknown", () => {
  const open = connCloseCell(record({ open: true }));
  assert.equal(open.id, "open");
  assert.equal(open.certain, true);
  assert.equal(connCloseCell(record({ close_reason: "reset" })).id, "reset");
  assert.equal(connCloseCell(record({})).id, "unknown");
});

/* ------------------------------- user kind ------------------------------- */

test("a managed user resolves to a name when the directory is readable", () => {
  const names = new Map([["user-1", "alice"]]);
  const cell = userCellDisplay(
    record({ user_kind: "managed", user_id: "user-1", user_name: "u_a1b2c3d4e5f60718" }),
    names,
  );
  assert.equal(cell.primary, "alice");
  assert.equal(cell.resolved, true);
  assert.equal(cell.marker, false);
  assert.equal(cell.monospace, false);
  assert.equal(cell.userId, "user-1");
});

test("without the directory a managed row shows the logged name, never the uuid", () => {
  const cell = userCellDisplay(
    record({ user_kind: "managed", user_id: "user-1", user_name: "u_a1b2c3d4e5f60718" }),
  );
  assert.equal(cell.primary, "u_a1b2c3d4e5f60718");
  assert.notEqual(cell.primary, "user-1");
  assert.equal(cell.monospace, true);
  assert.equal(cell.resolved, true);
});

test("every non-managed kind shows what is known and carries the marker", () => {
  for (const kind of USER_KINDS.filter((k) => k !== "managed")) {
    const cell = userCellDisplay(record({ user_kind: kind, user_name: "operator-label" }));
    assert.equal(cell.kind, kind);
    assert.equal(cell.kindLabelKey, `platform.trace.userKind.${kind}`);
    assert.equal(cell.primary, "operator-label");
    assert.equal(cell.resolved, false);
    assert.equal(cell.marker, true);
  }
});

test("a record with no user kind is unknown and marked, not silently managed", () => {
  const cell = userCellDisplay(record({ user_id: "user-1" }));
  assert.equal(cell.kind, "unknown");
  assert.equal(cell.primary, "");
  assert.equal(cell.marker, true);
  assert.equal(cell.resolved, false);
  assert.equal(userCellDisplay(record({ user_kind: "bogus" })).kind, "unknown");
});

/* --------------------------------- bytes --------------------------------- */

test("a measured zero and an unsampled counter are different answers", () => {
  const measured = traceBytesCell(0, true);
  assert.equal(measured.known, true);
  assert.equal(measured.text, "0 B");
  assert.equal(measured.i18nKey, "");

  for (const known of [false, undefined]) {
    const gap = traceBytesCell(0, known);
    assert.equal(gap.known, false);
    assert.equal(gap.text, "", "an unsampled counter has no number to print");
    assert.equal(gap.i18nKey, TRACE_BYTES_UNKNOWN_KEY);
  }
});

test("an omitted counter with bytes_known is a measured zero", () => {
  // Go omitempty drops a zero upload, so undefined plus bytes_known is 0 bytes.
  assert.deepEqual(traceBytesCell(undefined, true), { known: true, text: "0 B", i18nKey: "" });
  assert.equal(traceBytesCell(2048, true).text, "2.0 KiB");
});

test("byte coverage sums only what was measured and says how much that was", () => {
  const rows = [
    record({ log_id: 1, upload: 100, download: 900, bytes_known: true }),
    record({ log_id: 2, upload: 5, download: 5 }),
    record({ log_id: 3, upload: 400, download: 100, bytes_known: true }),
  ];
  assert.deepEqual(traceBytesCoverage(rows), {
    upload: 500,
    download: 1000,
    measured: 2,
    total: 3,
  });
});

/* ----------------------------- hop confidence ---------------------------- */

test("hop confidence maps to words, and only exact is exact", () => {
  for (const id of HOP_CONFIDENCES) {
    const display = hopConfidenceDisplay(id);
    assert.equal(display.id, id);
    assert.equal(display.labelKey, `platform.trace.hopConfidence.${id}`);
    assert.equal(display.wordingKey, `platform.trace.hopConfidence.${id}Wording`);
    assert.equal(display.exact, id === "exact");
    assert.equal(display.ambiguous, id === "ambiguous");
  }
  assert.equal(hopConfidenceDisplay("exact").tone, "success");
});

test("an unrecognised confidence is its own unknown, not downgraded to none", () => {
  for (const raw of ["", undefined, "probably"]) {
    const display = hopConfidenceDisplay(raw);
    assert.equal(display.id, "unknown");
    assert.equal(display.exact, false);
  }
});

/* -------------------------------- session -------------------------------- */

test("session TTL clamps at both ends and defaults when nothing usable was given", () => {
  assert.equal(clampTraceTtlSeconds(TRACE_TTL_MAX_SECONDS + 1), TRACE_TTL_MAX_SECONDS);
  assert.equal(clampTraceTtlSeconds(86400), TRACE_TTL_MAX_SECONDS);
  assert.equal(clampTraceTtlSeconds(1), TRACE_TTL_MIN_SECONDS);
  assert.equal(clampTraceTtlSeconds(TRACE_TTL_MIN_SECONDS - 1), TRACE_TTL_MIN_SECONDS);

  assert.equal(clampTraceTtlSeconds(TRACE_TTL_MIN_SECONDS), TRACE_TTL_MIN_SECONDS);
  assert.equal(clampTraceTtlSeconds(TRACE_TTL_MAX_SECONDS), TRACE_TTL_MAX_SECONDS);
  assert.equal(clampTraceTtlSeconds(1800), 1800);
  assert.equal(clampTraceTtlSeconds("1800"), 1800);
  assert.equal(clampTraceTtlSeconds(1800.7), 1800);

  for (const bad of [0, -1, Number.NaN, "", "  ", "abc", undefined, null]) {
    assert.equal(
      clampTraceTtlSeconds(bad),
      TRACE_TTL_DEFAULT_SECONDS,
      `expected the documented default for ${JSON.stringify(bad)}`,
    );
  }
});

/* -------------------------------- paging --------------------------------- */

test("the record key is the node, the core generation and the log id together", () => {
  assert.equal(
    connRecordKey(record({ node_id: "node-a", core_generation: 7, log_id: 42 })),
    "node-a:7:42",
  );
  // A missing generation is generation zero, not a different row every render.
  assert.equal(connRecordKey(record({ node_id: "node-a", log_id: 42 })), "node-a:0:42");
});

test("paging appends a page, dedupes by key, and never loses or duplicates a row", () => {
  const first = appendConnPage(emptyConnTracePaging(), {
    records: [
      record({ log_id: 1, core_generation: 3 }),
      record({ log_id: 2, core_generation: 3, open: true }),
    ],
    next_cursor: "cursor-1",
  });
  assert.equal(first.records.length, 2);
  assert.equal(first.cursor, "cursor-1");
  assert.equal(first.exhausted, false);

  // The open snapshot comes back closed. It replaces its own row in place
  // rather than appearing twice or being dropped.
  const second = appendConnPage(first, {
    records: [
      record({ log_id: 2, core_generation: 3, close_reason: "eof" }),
      record({ log_id: 5, core_generation: 3 }),
      // Same log id on a different node, and after a core restart: both are
      // different connections and both must survive.
      record({ node_id: "node-b", log_id: 1, core_generation: 3 }),
      record({ log_id: 1, core_generation: 4 }),
    ],
  });

  assert.deepEqual(
    second.records.map(connRecordKey),
    ["node-a:3:1", "node-a:3:2", "node-a:3:5", "node-b:3:1", "node-a:4:1"],
  );
  assert.equal(second.records[1]?.open, undefined);
  assert.equal(second.records[1]?.close_reason, "eof");
  assert.equal(second.cursor, "");
  assert.equal(second.exhausted, true);
  assert.equal(new Set(second.records.map(connRecordKey)).size, second.records.length);
});

test("an empty page ends the walk without touching what is on screen", () => {
  const state = appendConnPage(emptyConnTracePaging(), {
    records: [record({ log_id: 1 })],
    next_cursor: "c",
  });
  const done = appendConnPage(state, {});
  assert.deepEqual(done.records.map(connRecordKey), ["node-a:0:1"]);
  assert.equal(done.exhausted, true);
});

/* ------------------------------ row helpers ------------------------------ */

test("a stalled record is marked, and the rest are not", () => {
  assert.equal(isStalled(record({ stalled_at: "2026-08-26T10:05:00.000Z" })), true);
  assert.equal(isStalled(record({})), false);
});

test("destination reads as host and port, falling back to the resolved ip", () => {
  assert.equal(destinationText(record({ dst_host: "example.com", dst_port: 443 })), "example.com:443");
  assert.equal(destinationText(record({ dst_ip: "203.0.113.7", dst_port: 80 })), "203.0.113.7:80");
  assert.equal(destinationText(record({ dst_host: "example.com" })), "example.com");
  assert.equal(destinationText(record({})), "");
});

test("duration is unknown when sing-box never reported an elapsed counter", () => {
  assert.deepEqual(traceDurationCell(undefined), { known: false, text: "" });
  assert.deepEqual(traceDurationCell(-1), { known: false, text: "" });
  assert.deepEqual(traceDurationCell(250), { known: true, text: "250 ms" });
  assert.deepEqual(traceDurationCell(90_000), { known: true, text: "1m" });
});
