import assert from "node:assert/strict";
import { test } from "node:test";

import {
  hasRenewalDate,
  nextReminder,
  reminderCoverage,
  reminderOffsets,
  ruleRoutesRenewals,
  type ReminderMachine,
} from "../reminderModel.ts";

const TODAY = "2026-09-29";

function machine(name: string, renewal: string | undefined, extra: Partial<ReminderMachine> = {}): ReminderMachine {
  return {
    id: `mch_${name}`,
    node_id: `node_${name}`,
    label: name,
    next_renewal: renewal ? `${renewal}T00:00:00Z` : undefined,
    reminders_enabled: true,
    remind_days_before: [14, 7, 3, 1, 0],
    auto_roll: false,
    renewal_cycle: "monthly",
    ...extra,
  };
}

test("the next reminder is the largest offset not yet reached, on renewal minus offset", () => {
  // 10-06 is seven days out: the 7-day reminder is today's run.
  assert.deepEqual(nextReminder(machine("jp-nat", "2026-10-06"), TODAY), { offset: 7, at: "2026-09-29", inDays: 0, renewal: "2026-10-06" });
  // 10-20 is 21 days out: the 14-day reminder on 10-06.
  assert.deepEqual(nextReminder(machine("dmit-1", "2026-10-20"), TODAY), { offset: 14, at: "2026-10-06", inDays: 7, renewal: "2026-10-20" });
  // Ten days out: 14 has passed, 7 lands in three days.
  assert.equal(nextReminder(machine("x", "2026-10-09"), TODAY)?.offset, 7);
});

test("off, dateless and zero-dated machines have no next reminder", () => {
  assert.equal(nextReminder(machine("off", "2026-10-06", { reminders_enabled: false }), TODAY), undefined);
  assert.equal(nextReminder(machine("none", undefined), TODAY), undefined);
  assert.equal(nextReminder(machine("zero", "0001-01-01"), TODAY), undefined);
  assert.equal(hasRenewalDate({ next_renewal: "0001-01-01T00:00:00Z" }), false);
});

test("a manual machine past its offsets is reminded daily from the day after, for seven days", () => {
  const noZero = machine("late", "2026-09-30", { remind_days_before: [7, 3] });
  assert.deepEqual(nextReminder(noZero, TODAY), { offset: -1, at: "2026-10-01", inDays: 2, renewal: "2026-09-30", repeatsUntil: "2026-10-07" });
  const overdue = machine("overdue", "2026-09-25");
  assert.deepEqual(nextReminder(overdue, TODAY), { offset: -1, at: TODAY, inDays: 0, renewal: "2026-09-25", repeatsUntil: "2026-10-02" });
  // Day seven past is the last one; day eight is silence.
  assert.equal(nextReminder(machine("d7", "2026-09-22"), TODAY)?.offset, -1);
  assert.equal(nextReminder(machine("d8", "2026-09-21"), TODAY), undefined);
});

test("an auto-roll machine past its offsets starts over in the next cycle", () => {
  const rolled = machine("auto", "2026-09-30", { auto_roll: true, remind_days_before: [14, 7, 3] });
  // 09-30 rolls to 10-30; its 14-day reminder is on 10-16.
  assert.deepEqual(nextReminder(rolled, TODAY), { offset: 14, at: "2026-10-16", inDays: 17, renewal: "2026-10-30" });
  // A date the server has not rolled yet is rolled past today first.
  const stale = machine("auto-stale", "2026-09-10", { auto_roll: true });
  assert.equal(nextReminder(stale, TODAY)?.renewal, "2026-10-10");
});

test("offsets are whole days 0..365, deduplicated, largest first", () => {
  assert.deepEqual(reminderOffsets({ remind_days_before: [1, 14, 7, 7, -1, 400, 2.5, 0] }), [14, 7, 1, 0]);
  assert.deepEqual(reminderOffsets({}), []);
});

test("a rule routes renewals when it names the event, names *, or names nothing", () => {
  assert.equal(ruleRoutesRenewals({ event_types: ["inventory.renewal", "monitor.recovered", "service.recovered", "ssh.login"] }), true);
  assert.equal(ruleRoutesRenewals({ event_types: ["*"] }), true);
  assert.equal(ruleRoutesRenewals({ event_types: [] }), true);
  assert.equal(ruleRoutesRenewals({}), true);
  assert.equal(ruleRoutesRenewals({ event_types: ["monitor.down"] }), false);
});

test("coverage counts dated machines with reminders on, and finds the soonest reminder", () => {
  const fleet: ReminderMachine[] = [
    machine("cd-xuezhang-jp-nat", "2026-10-06"),
    machine("openjobs-vpn-dmit-1", "2026-10-20", { auto_roll: true }),
    machine("openjobs-vpn-dmit-2", "2026-10-20", { auto_roll: true }),
    machine("turned-off", "2026-10-08", { reminders_enabled: false }),
    machine("no-date", undefined, { reminders_enabled: false }),
    // A node nobody profiled has no id and is not a machine the engine reads.
    { node_id: "node_bare", next_renewal: "2026-10-01T00:00:00Z", reminders_enabled: true },
  ];
  const coverage = reminderCoverage(fleet, TODAY);
  assert.equal(coverage.covered, 3);
  assert.equal(coverage.off, 1);
  assert.equal(coverage.next?.machine.label, "cd-xuezhang-jp-nat");
  assert.deepEqual(coverage.next?.reminder, { offset: 7, at: TODAY, inDays: 0, renewal: "2026-10-06" });
  assert.equal(coverage.sameDay, 1);
});

test("machines whose next reminder lands on the same day are one message on that run", () => {
  const fleet = [1, 2, 3, 4].map((n) => machine(`openjobs-vpn-dmit-${n}`, "2026-10-20", { auto_roll: true }));
  const coverage = reminderCoverage(fleet, TODAY);
  assert.equal(coverage.next?.reminder.at, "2026-10-06");
  assert.equal(coverage.next?.machine.label, "openjobs-vpn-dmit-1");
  assert.equal(coverage.sameDay, 4);
  assert.deepEqual(reminderCoverage([], TODAY), { covered: 0, off: 0, next: undefined, sameDay: 0 });
});
