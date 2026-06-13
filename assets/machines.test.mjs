import assert from "node:assert/strict";
import test from "node:test";

import { dateInputValue, formatMoney, machinePayload, renewalState, splitIntList } from "./machines.js";

test("splitIntList normalizes non-negative unique offsets descending", () => {
  assert.deepEqual(splitIntList("14, 7 1 7 -1 nope"), [14, 7, 1]);
});

test("machinePayload trims fields and treats links as write-only", () => {
  assert.deepEqual(machinePayload({
    id: " mp1 ",
    node_id: " node-a ",
    label: " gmami ",
    vendor: " DMIT ",
    console_url: " https://console.example.com/s ",
    detail_url: "",
    clear_detail_url: true,
    price_cents: "990",
    currency: " usd ",
    renewal_cycle: "annual",
    next_renewal: "2026-07-01",
    remind_days_before: "14,7,1",
    reminders_enabled: true,
    auto_roll: true,
  }), {
    id: "mp1",
    node_id: "node-a",
    label: "gmami",
    vendor: "DMIT",
    region: "",
    notes: "",
    price_cents: 990,
    currency: "USD",
    renewal_cycle: "annual",
    cycle_days: 0,
    auto_roll: true,
    remind_days_before: [14, 7, 1],
    reminders_enabled: true,
    next_renewal: "2026-07-01T00:00:00Z",
    console_url: "https://console.example.com/s",
    clear_detail_url: true,
  });
});

test("machinePayload omits empty optional link/date fields", () => {
  const body = machinePayload({ node_id: "n1", console_url: "", detail_url: "", next_renewal: "" });
  assert.ok(!("console_url" in body));
  assert.ok(!("detail_url" in body));
  assert.ok(!("next_renewal" in body));
});

test("formatMoney and renewalState produce compact dashboard labels", () => {
  assert.equal(formatMoney(990, "usd"), "USD 9.90");
  assert.equal(formatMoney(0, "USD"), "");
  assert.equal(renewalState(-1, true), "overdue");
  assert.equal(renewalState(7, true), "soon");
  assert.equal(renewalState(8, true), "ok");
  assert.equal(renewalState(8, false), "");
});

test("dateInputValue converts API timestamps for date inputs", () => {
  assert.equal(dateInputValue("2026-07-01T00:00:00Z"), "2026-07-01");
  assert.equal(dateInputValue("0001-01-01T00:00:00Z"), "");
  assert.equal(dateInputValue(""), "");
});
