import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentLoopHealth } from "@/lib/api/types";
import { agentAge, loopProblems, loopStepRows, loopSummary } from "../loopHealthModel.ts";

// The browser's clock, and an agent whose clock runs an hour behind it.
const NOW = Date.parse("2026-10-03T12:00:00Z");
const AGENT = NOW - 3_600_000;
const agentAt = (secondsBeforeBeat: number) => new Date(AGENT - 30_000 - secondsBeforeBeat * 1000).toISOString();

function health(over: Partial<AgentLoopHealth> = {}): AgentLoopHealth {
  return {
    started_at: agentAt(7200),
    // The beat was collected 30 s before now on the agent's clock and arrived 30 s ago.
    collected_at: new Date(AGENT - 30_000).toISOString(),
    received_at: new Date(NOW - 30_000).toISOString(),
    ...over,
  };
}

test("an agent instant ages by the agent's own clock, carried forward by when the beat arrived", () => {
  const h = health({ cycle_completed_at: agentAt(8) });
  assert.equal(agentAge(h, h.cycle_completed_at, NOW), 38_000);
  assert.equal(agentAge(h, undefined, NOW), undefined);
  assert.equal(agentAge(h, "0001-01-01T00:00:00Z", NOW), undefined);
});

test("steps follow the loop's order, and only a core step past the server's rule reads stale", () => {
  const rows = loopStepRows(
    health({
      step: "inventory",
      steps: {
        zebra: { last_ok_at: agentAt(1) },
        usage: { last_ok_at: agentAt(1500), consecutive_errors: 9, last_error: "post /api/agent/usage: 502" },
        config: { last_ok_at: agentAt(5) },
        tasks: { last_ok_at: agentAt(1200), consecutive_errors: 40, last_error: "timeout" },
        monitors: { last_ok_at: agentAt(60), consecutive_errors: 1, last_error: "refused" },
        inventory: {},
      },
    }),
    NOW,
  );
  assert.deepEqual(rows.map((r) => r.name), ["config", "usage", "inventory", "tasks", "monitors", "zebra"]);
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(byName.config!.tone, "ok");
  assert.equal(byName.usage!.tone, "failing", "usage is not a core step, so it fails but is never stale");
  assert.equal(byName.tasks!.tone, "stale");
  assert.equal(byName.monitors!.tone, "failing");
  assert.equal(byName.inventory!.tone, "idle");
  assert.equal(byName.inventory!.running, true);
  assert.equal(byName.tasks!.lastOkAgeMs, 1_230_000);
});

test("the summary reads the cycle, the step, the block and the result queue, and marks an old beat", () => {
  const s = loopSummary(
    health({
      cycle_completed_at: agentAt(8),
      cycle_duration_ms: 2100,
      step: "usage",
      step_since: agentAt(2),
      linechain_blocked: "journal 3 unreadable",
      linechain_blocked_since: agentAt(300),
      watchdog: true,
      monitor_results_queued: 4,
      monitor_results_dropped: 7,
    }),
    NOW,
  );
  assert.equal(s.cycleAgeMs, 38_000);
  assert.equal(s.cycleDurationMs, 2100);
  assert.equal(s.step, "usage");
  assert.equal(s.stepAgeMs, 32_000);
  assert.deepEqual(s.blocked, { reason: "journal 3 unreadable", ageMs: 330_000 });
  assert.equal(s.watchdog, true);
  assert.equal(s.queued, 4);
  assert.equal(s.dropped, 7);
  assert.equal(s.beatAgeMs, 30_000);
  assert.equal(s.stale, false);
  assert.equal(loopSummary(health({ received_at: new Date(NOW - 11 * 60_000).toISOString() }), NOW).stale, true);
});

test("the server's problems keep their kind; an unknown kind keeps its sentence", () => {
  const problems = loopProblems(
    health({
      problems: [
        { kind: "stalled", since: new Date(NOW - 420_000).toISOString(), reason: "the work loop ...", degrades: true, pages: true },
        { kind: "something_new", since: new Date(NOW).toISOString(), reason: "a new reason" },
      ],
    }),
  );
  assert.deepEqual(problems.map((p) => [p.kind, p.pages, p.degrades]), [["stalled", true, true], ["other", false, false]]);
  assert.equal(problems[1]!.reason, "a new reason");
});
