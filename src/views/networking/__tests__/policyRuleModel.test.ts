import assert from "node:assert/strict";
import { test } from "node:test";

import { assignRuleIds, draftPorts, parsePortList, ruleFieldError } from "../policyRuleModel.ts";

test("single ports parse, sort and collapse", () => {
  assert.deepEqual(parsePortList("443, 80,80"), { ok: true, ports: [80, 443] });
  assert.deepEqual(parsePortList(" 22 8080\n53 "), { ok: true, ports: [22, 53, 8080] });
  // A zh-CN keyboard types full-width and ideographic commas.
  assert.deepEqual(parsePortList("22，443、8080"), { ok: true, ports: [22, 443, 8080] });
  assert.deepEqual(parsePortList(""), { ok: true, ports: [] });
  // A field holding only separators was not left empty, so it is an error
  // rather than "every port".
  assert.deepEqual(parsePortList(" , "), { ok: false, reason: "invalid", token: "," });
  assert.deepEqual(parsePortList(",,"), { ok: false, reason: "invalid", token: ",," });
});

// The defect design 32 D7 names: the old parser dropped "8000-8010" and saved
// an empty list, which the model reads as every port.
test("a range is an error, never an empty list", () => {
  assert.deepEqual(parsePortList("8000-8010"), { ok: false, reason: "range", token: "8000-8010" });
  assert.deepEqual(parsePortList("22, 8000 - 8010"), { ok: false, reason: "range", token: "8000-8010" });
  assert.deepEqual(parsePortList("8000:8010"), { ok: false, reason: "range", token: "8000:8010" });
});

test("anything that is not a port from 1 to 65535 is an error", () => {
  for (const token of ["0", "65536", "http", "80.5", "+80", "-1", "1e3"]) {
    const parsed = parsePortList(`22, ${token}`);
    assert.equal(parsed.ok, false, token);
    if (!parsed.ok) assert.equal(parsed.token, token);
  }
});

test("existing ids are kept and new rules get the next free id", () => {
  assert.deepEqual(
    assignRuleIds([{ id: "rule_002" }, {}, {}], ["rule_001", "rule_004"], "rule"),
    ["rule_002", "rule_003", "rule_005"],
  );
  // A draft whose id collides with a kept rule gets a fresh one rather than a
  // duplicate the server would refuse.
  assert.deepEqual(assignRuleIds([{ id: "rule_001" }], ["rule_001"], "rule"), ["rule_002"]);
  assert.deepEqual(assignRuleIds([{}, {}], [], "grule_grp_web"), ["grule_grp_web_001", "grule_grp_web_002"]);
});

test("field errors name the token, and protocol any carries no ports", () => {
  assert.deepEqual(ruleFieldError({ protocol: "tcp", ports: "8000-8010" }), { key: "errPortRange", token: "8000-8010" });
  assert.deepEqual(ruleFieldError({ protocol: "udp", ports: "dns" }), { key: "errPortInvalid", token: "dns" });
  assert.deepEqual(ruleFieldError({ protocol: "any", ports: "53" }), { key: "errAnyNoPorts" });
  assert.equal(ruleFieldError({ protocol: "any", ports: "" }), undefined);
  assert.equal(ruleFieldError({ protocol: "tcp", ports: "" }), undefined);
  assert.deepEqual(draftPorts({ protocol: "tcp", ports: "443,80" }), [80, 443]);
  assert.deepEqual(draftPorts({ protocol: "any", ports: "" }), []);
  // Saving a draft with a bad token must fail loudly rather than save "all ports".
  assert.throws(() => draftPorts({ protocol: "tcp", ports: "8000-8010" }));
});
