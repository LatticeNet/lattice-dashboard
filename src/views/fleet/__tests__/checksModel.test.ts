import assert from "node:assert/strict";
import { test } from "node:test";

import type { MonitorView } from "@/lib/api/types";

import {
  buildCarryPauses,
  buildCreate,
  buildPauseOld,
  buildSourcePause,
  buildUpdate,
  canEditCheck,
  checkGroup,
  draftChanged,
  draftFromMonitor,
  draftProblems,
  emptyDraft,
  identityChanged,
  sourcePaused,
  suggestName,
  switchDraftKind,
} from "../checksModel.ts";

function monitor(over: Partial<MonitorView> = {}): MonitorView {
  return {
    id: "mon_http",
    name: "Status page",
    type: "http",
    target: "https://status.example.com/health",
    interval_sec: 30,
    timeout_sec: 5,
    assign_all: false,
    node_ids: ["sh", "hk"],
    paused_node_ids: [],
    enabled: true,
    version: 4,
    alert: "down",
    ...over,
  };
}

test("groups: operator checks first, the path set's generated checks under it, edits only with a version", () => {
  assert.equal(checkGroup(monitor()), "operator");
  assert.equal(checkGroup(monitor({ managed_by: "latency" })), "pathset");
  assert.equal(canEditCheck(monitor(), true), true);
  assert.equal(canEditCheck(monitor({ version: undefined }), true), true, "a check listed without a version is edited at version zero");
  assert.equal(canEditCheck(monitor(), false), false, "a server without the edit route");
  assert.equal(canEditCheck(monitor({ managed_by: "latency" }), true), false);
  assert.equal(buildUpdate(monitor({ version: undefined }), { ...draftFromMonitor(monitor()), intervalSec: 60 }).version, 0);
});

test("names: suggested from the method and the target until the operator types one", () => {
  assert.equal(suggestName("http", "https://status.example.com/health"), "HTTP status.example.com/health");
  assert.equal(suggestName("http", "https://example.com/"), "HTTP example.com");
  assert.equal(suggestName("tcp", "203.0.113.9:22"), "TCP 203.0.113.9:22");
  assert.equal(suggestName("tls", "  "), "");
});

test("problems: target shape, cadence bounds, timeout under interval, sources and threshold", () => {
  assert.deepEqual(draftProblems({ ...draftFromMonitor(monitor()) }), []);
  assert.deepEqual(draftProblems({ ...emptyDraft("tcp"), target: "https://x" }), ["target"]);
  assert.deepEqual(draftProblems({ ...draftFromMonitor(monitor()), intervalSec: 5 }), ["interval"]);
  assert.deepEqual(draftProblems({ ...draftFromMonitor(monitor()), timeoutSec: 30 }), ["timeoutVsInterval"]);
  assert.deepEqual(draftProblems({ ...draftFromMonitor(monitor()), timeoutSec: 0 }), ["timeout"]);
  assert.deepEqual(draftProblems({ ...draftFromMonitor(monitor()), nodeIds: [] }), ["sources"]);
  assert.deepEqual(draftProblems({ ...emptyDraft("tls"), target: "example.com:443", thresholdDays: 0 }), ["threshold"]);
});

test("edit: only changed fields with the version; kind and target never ride an edit", () => {
  const m = monitor();
  assert.deepEqual(buildUpdate(m, draftFromMonitor(m)), { id: "mon_http", version: 4 });
  const draft = { ...draftFromMonitor(m), intervalSec: 60, nodeIds: ["sh", "hk", "fsn"], pausedNodeIds: ["hk"], alert: "off" as const };
  assert.deepEqual(buildUpdate(m, draft), { id: "mon_http", version: 4, interval_sec: 60, node_ids: ["fsn", "hk", "sh"], paused_node_ids: ["hk"], alert: "off" });
  // A source taken off the check drops its pause with it.
  const dropped = { ...draftFromMonitor(monitor({ paused_node_ids: ["hk"] })), nodeIds: ["sh"] };
  assert.deepEqual(buildUpdate(monitor({ paused_node_ids: ["hk"] }), dropped), { id: "mon_http", version: 4, node_ids: ["sh"], paused_node_ids: [] });
  const renamed = { ...draftFromMonitor(m), name: "  " };
  assert.equal(buildUpdate(m, renamed).name, "HTTP status.example.com/health", "an emptied name falls back to the suggestion");
  assert.equal(draftChanged(m, draftFromMonitor(m)), false);
  assert.equal(draftChanged(m, draft), true);
});

test("identity: a new method or target makes a new check and pauses the old one", () => {
  const m = monitor();
  assert.equal(identityChanged(m, draftFromMonitor(m)), false);
  assert.equal(identityChanged(m, { type: "tcp", target: m.target }), true);
  assert.equal(identityChanged(m, { type: "http", target: "https://status.example.com/v2" }), true);
  assert.equal(identityChanged(m, { type: "http", target: ` ${m.target} ` }), false);
  assert.deepEqual(buildPauseOld(m), { id: "mon_http", version: 4, enabled: false });
});

test("create: tls carries a threshold and no nodes; agent checks carry their sources; alert only when the server takes it", () => {
  const tls = buildCreate({ ...emptyDraft("tls"), target: "example.com:443" }, false);
  assert.deepEqual(tls, { name: "TLS example.com:443", type: "tls", target: "example.com:443", interval_sec: 3600, timeout_sec: 10, threshold_days: 14, assign_all: false });
  const http = buildCreate({ ...draftFromMonitor(monitor()), nodeIds: ["hk", "sh"] }, true);
  assert.deepEqual(http, { name: "Status page", type: "http", target: "https://status.example.com/health", interval_sec: 30, timeout_sec: 5, assign_all: false, node_ids: ["hk", "sh"], alert: "down" });
});

test("a replacement keeps the pauses of the sources it still runs on", () => {
  const draft = { ...draftFromMonitor(monitor({ paused_node_ids: ["hk"] })), target: "https://status.example.com/v2", nodeIds: ["sh", "hk"] };
  assert.deepEqual(buildCarryPauses({ id: "mon_new", version: 1 }, draft), { id: "mon_new", version: 1, paused_node_ids: ["hk"] });
  assert.deepEqual(buildCarryPauses({ id: "mon_new" }, { ...draft, nodeIds: ["sh"] }), undefined, "a source taken off drops its pause");
  assert.equal(buildCarryPauses({ id: "mon_new", version: 1 }, { ...draft, pausedNodeIds: [] }), undefined);
  assert.equal(buildCarryPauses({ id: "mon_new", version: 1 }, { ...draft, type: "tls" }), undefined);
});

test("pause one source of a check", () => {
  const m = monitor({ paused_node_ids: ["hk"] });
  assert.deepEqual(buildSourcePause(m, "sh", true), { id: "mon_http", version: 4, paused_node_ids: ["hk", "sh"] });
  assert.deepEqual(buildSourcePause(m, "hk", false), { id: "mon_http", version: 4, paused_node_ids: [] });
  assert.equal(sourcePaused(m, "hk"), true);
  assert.equal(sourcePaused(m, "sh"), false);
});

test("switching kind keeps the agent assignment aside through tls and hands it back", () => {
  const start = { ...draftFromMonitor(monitor()), type: "tcp" as const, target: "203.0.113.1:22" };
  const toTls = switchDraftKind(start, "tls");
  assert.equal(toTls.draft.assignAll, false);
  assert.deepEqual(toTls.draft.nodeIds, []);
  assert.equal(toTls.draft.intervalSec, 3600);
  const back = switchDraftKind(toTls.draft, "http", toTls.stash);
  assert.deepEqual(back.draft.nodeIds, ["hk", "sh"]);
  assert.equal(back.draft.intervalSec, 30);
  assert.equal(back.stash, undefined);
  const sideways = switchDraftKind(start, "http");
  assert.deepEqual(sideways.draft.nodeIds, ["hk", "sh"]);
});
