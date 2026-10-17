import assert from "node:assert/strict";
import { test } from "node:test";

import type { BeaconPlan, BeaconView, PathsResponse } from "@/lib/api/types";

import {
  DEFAULT_BEACON_LIMITS,
  agentHasResponder,
  beaconActions,
  beaconEnabled,
  beaconSources,
  beaconState,
  beaconTone,
  buildBeaconPlanRequest,
  changedSettings,
  companionAllowCount,
  defaultBind,
  beaconForbidden,
  beaconTargetBlock,
  refusalField,
  companionApprovalToRead,
  companionOutcome,
  defaultEndpointAddress,
  endpointAddresses,
  OTHER_ADDRESS,
  endpointIsOwn,
  formFor,
  isReachabilityCheck,
  nextEpoch,
  nodeRefusesBeacon,
  notListeningCause,
  parseBeaconEndpoint,
  parseBeaconIPv4,
  plannedSettings,
  reachState,
  readBeaconPlan,
  refusedFindings,
  settingsRows,
  shortHash,
  sortFindings,
  validListenPort,
  waitingSources,
  readBeaconReplan,
  readBeaconReplans,
  replanLines,
  replanMissingScopes,
  replanNames,
  replanOf,
  replanStep,
  replanSurface,
} from "../beaconModel.ts";
import { buildPathsMatrix } from "../pathsModel.ts";

const ALL = { monitorAdmin: true, nodeAdmin: true, networkPlan: true, netguardAdmin: true };

function view(over: Partial<BeaconView> = {}): BeaconView {
  return {
    node_id: "jp",
    state: "listening",
    applied: { enabled: true, port: 47231, bind: "10.0.0.5", endpoint: "203.0.113.12:50231", limits: DEFAULT_BEACON_LIMITS },
    epoch: 3,
    agent: { responder: true, state: "listening", bind: "10.0.0.5", port: 47231 },
    exposure: "netguard",
    sources: [
      { node_id: "sh", name: "cd-hs-sh", source_id: 3, approved: true, current: true },
      { node_id: "fsn", name: "hetzner-fsn", source_id: 7, approved: false, current: true, reason: "firewall_pending" },
      { node_id: "mk", name: "mkcloud", source_id: 9, approved: true, current: false },
    ],
    suggested_port: 47231,
    version: 4,
    ...over,
  };
}

/* ---- Addresses (lattice-sdk beacon/addr_test.go) ---- */

test("a bind address is a canonical dotted-quad IPv4 literal of an allowed class", () => {
  assert.deepEqual(parseBeaconIPv4("10.0.0.5"), { ok: true, value: "10.0.0.5" });
  assert.deepEqual(parseBeaconIPv4("100.64.1.2"), { ok: true, value: "100.64.1.2" }, "shared space stays allowed");
  assert.deepEqual(parseBeaconIPv4("203.0.113.12"), { ok: true, value: "203.0.113.12" });
  for (const raw of ["", "host.example", "010.0.0.5", "1.2.3", "1.2.3.4.5", "256.1.1.1", "::1", "1.2.3.4:5", " 1.2.3.4"]) {
    assert.deepEqual(parseBeaconIPv4(raw), { ok: false, problem: "notIPv4" }, raw);
  }
  for (const raw of ["0.1.2.3", "127.0.0.1", "169.254.169.254", "224.0.0.1", "240.0.0.1", "255.255.255.255"]) {
    assert.deepEqual(parseBeaconIPv4(raw), { ok: false, problem: "refused" }, raw);
  }
});

test("an endpoint is an IPv4 literal and a port, never a name or IPv6", () => {
  assert.deepEqual(parseBeaconEndpoint("203.0.113.12:50231"), { ok: true, value: "203.0.113.12:50231" });
  assert.deepEqual(parseBeaconEndpoint(" 203.0.113.12:50231 "), { ok: true, value: "203.0.113.12:50231" }, "trimmed, as the server trims");
  assert.deepEqual(parseBeaconEndpoint("203.0.113.12"), { ok: false, problem: "shape" });
  assert.deepEqual(parseBeaconEndpoint("[2001:db8::1]:443"), { ok: false, problem: "shape" });
  assert.deepEqual(parseBeaconEndpoint("beacon.example.net:443"), { ok: false, problem: "notIPv4" });
  assert.deepEqual(parseBeaconEndpoint("127.0.0.1:443"), { ok: false, problem: "refused" });
  for (const raw of ["203.0.113.12:0", "203.0.113.12:65536", "203.0.113.12:080", "203.0.113.12:", "203.0.113.12:4x"]) {
    assert.deepEqual(parseBeaconEndpoint(raw), { ok: false, problem: "port" }, raw);
  }
});

test("a listen port is 1024 to 65535; the beacon never takes a privileged port", () => {
  assert.equal(validListenPort(1024), true);
  assert.equal(validListenPort(65535), true);
  assert.equal(validListenPort(1023), false);
  assert.equal(validListenPort(65536), false);
  assert.equal(validListenPort(4.5), false);
});

/* ---- The view ---- */

test("an unknown state reads pending, never listening; only listening is good", () => {
  assert.equal(beaconState(view({ state: "warming_up" })), "pending");
  assert.equal(beaconState(undefined), "off");
  assert.equal(beaconTone("listening"), "success");
  assert.equal(beaconTone("refused_by_node"), "destructive");
  assert.equal(beaconTone("not_listening"), "destructive");
  assert.equal(beaconTone("agent_too_old"), "warning");
  assert.equal(beaconTone("pending"), "muted");
  assert.equal(beaconEnabled(view({ state: "off" })), false);
  assert.equal(beaconEnabled(view({ state: "agent_too_old" })), true);
});

test("the agent's report comes from the view, else from the node list", () => {
  assert.equal(agentHasResponder(view({ agent: undefined }), { beacon: { responder: true } }), true);
  assert.equal(agentHasResponder(view({ agent: undefined }), {}), false);
  assert.equal(nodeRefusesBeacon(view({ agent: { responder: true, refusal: "refused_by_node", state: "refused" } })), true);
  assert.equal(nodeRefusesBeacon(view()), false);
  assert.deepEqual(notListeningCause(view({ agent: { responder: true, state: "bind_failed", error: " listen udp 10.0.0.5:47231: bind: address already in use " } })), {
    kind: "bind_failed",
    error: "listen udp 10.0.0.5:47231: bind: address already in use",
  });
  assert.deepEqual(notListeningCause(view({ agent: { responder: true, state: "circuit_open" } })), { kind: "circuit_open", error: undefined });
});

test("sources split into approved and used, used but not admitted, and approved but idle", () => {
  const split = beaconSources(view());
  assert.deepEqual(split.active.map((s) => s.node_id), ["sh"]);
  assert.deepEqual(split.waiting.map((s) => s.node_id), ["fsn"]);
  assert.deepEqual(split.idle.map((s) => s.node_id), ["mk"]);
  assert.deepEqual(waitingSources(view()).map((s) => s.node_id), ["fsn"]);
  // A beacon that is off has no source waiting on it: the current set waits on the first plan instead.
  assert.deepEqual(waitingSources(view({ state: "off" })), []);
});

test("actions follow the state and the scopes; NetGuard adds netguard:admin to planning", () => {
  const on = beaconActions(view(), ALL);
  assert.deepEqual([on.enable, on.change, on.disable, on.rotate, on.missing], [false, true, true, true, []]);
  const off = beaconActions(view({ state: "off", exposure: undefined }), ALL);
  assert.deepEqual([off.enable, off.change, off.disable, off.rotate], [true, false, false, false]);
  const noGuard = beaconActions(view(), { ...ALL, netguardAdmin: false });
  assert.deepEqual([noGuard.change, noGuard.disable, noGuard.rotate, noGuard.missing], [false, false, true, ["netguard:admin"]]);
  const internet = beaconActions(view({ exposure: "internet" }), { ...ALL, netguardAdmin: false });
  assert.equal(internet.change, true, "no companion, no netguard:admin needed");
  const reader = beaconActions(view(), { monitorAdmin: false, nodeAdmin: false, networkPlan: false, netguardAdmin: false });
  assert.deepEqual([reader.change, reader.rotate, reader.missing], [false, false, ["monitor:admin", "node:admin", "network:plan", "netguard:admin"]]);
  const vetoed = beaconActions(view({ state: "off", agent: { responder: true, refusal: "refused_by_node", state: "refused" } }), ALL);
  assert.deepEqual([vetoed.enable, vetoed.enableBlocked], [true, "refused_by_node"]);
});

/* ---- The plan form ---- */

const NODE = { internal_ip: "10.0.0.5", public_ip: "203.0.113.12" };
const JP = { id: "jp", ...NODE };

test("the bind default follows the server: the primary interface address, else the public IPv4", () => {
  assert.equal(defaultBind(NODE), "10.0.0.5");
  assert.equal(defaultBind({ internal_ip: "fe80::1", public_ip: "203.0.113.12" }), "203.0.113.12");
  assert.equal(defaultBind({}), "");
});

test("the endpoint is chosen from the node's own addresses, with the applied one kept when it is neither", () => {
  assert.deepEqual(endpointAddresses(NODE), [
    { address: "203.0.113.12", kind: "public" },
    { address: "10.0.0.5", kind: "interface" },
  ]);
  assert.deepEqual(endpointAddresses({ public_ip: "203.0.113.12", internal_ip: "203.0.113.12" }), [{ address: "203.0.113.12", kind: "public" }], "one address once");
  assert.deepEqual(endpointAddresses({ public_ip: "host.example", internal_ip: "127.0.0.1" }), [], "nothing the server would accept");
  assert.deepEqual(endpointAddresses(NODE, { endpoint: "198.51.100.40:50231" }).map((a) => a.kind), ["public", "interface", "current"]);
  assert.equal(endpointAddresses(NODE, { endpoint: "10.0.0.5:47231" }).length, 2, "an applied own address is not listed twice");
  assert.equal(defaultEndpointAddress(NODE), "203.0.113.12");
  assert.equal(defaultEndpointAddress({ internal_ip: "10.0.0.5" }), "10.0.0.5", "no public IPv4: the interface address");
  assert.equal(defaultEndpointAddress({}), OTHER_ADDRESS);
});

test("an enable opens on the suggested port and the public IPv4, and derives the rest", () => {
  const off = view({ state: "off", applied: undefined, epoch: undefined });
  const form = formFor("enable", off, NODE);
  assert.deepEqual(form, { port: "47231", bind: "", endpointAddress: "203.0.113.12", endpointOther: "", endpointPort: "" });
  const planned = plannedSettings("enable", form, off, NODE);
  assert.deepEqual(planned, { port: 47231, portRandom: false, bind: "10.0.0.5", endpoint: "203.0.113.12:47231", endpointDefault: false, problems: [] });
  assert.deepEqual(buildBeaconPlanRequest(JP, "enable", form, off), { node_id: "jp", action: "enable", port: 47231, endpoint: "203.0.113.12:47231" });
  // A NAT node names the outside port its router maps to the listen port.
  const nat = { ...form, endpointPort: "50231" };
  assert.equal(plannedSettings("enable", nat, off, NODE).endpoint, "203.0.113.12:50231");
  assert.deepEqual(buildBeaconPlanRequest(JP, "enable", nat, off), { node_id: "jp", action: "enable", port: 47231, endpoint: "203.0.113.12:50231" });
});

test("another address is typed and judged by the server; the form refuses only what is not an address", () => {
  const off = view({ state: "off", applied: undefined });
  const typed = { ...formFor("enable", off, NODE), endpointAddress: OTHER_ADDRESS, endpointOther: " 198.51.100.40 " };
  assert.equal(plannedSettings("enable", typed, off, NODE).endpoint, "198.51.100.40:47231");
  assert.deepEqual(plannedSettings("enable", { ...typed, endpointOther: "" }, off, NODE).problems, [{ field: "endpointAddress", code: "missing" }]);
  assert.deepEqual(plannedSettings("enable", { ...typed, endpointOther: "edge.example.net" }, off, NODE).problems, [{ field: "endpointAddress", code: "notIPv4" }]);
  assert.deepEqual(plannedSettings("enable", { ...typed, endpointOther: "169.254.169.254" }, off, NODE).problems, [{ field: "endpointAddress", code: "refused" }]);
  assert.equal(endpointIsOwn("203.0.113.12:50231", NODE), true);
  assert.equal(endpointIsOwn("10.0.0.5:47231", NODE), true);
  assert.equal(endpointIsOwn("198.51.100.40:50231", NODE), false);
  assert.equal(endpointIsOwn("not an endpoint", NODE), true, "a malformed endpoint is the parser's to refuse");
});

test("an enable without a drawn port leaves the port, and the public endpoint, to the control plane", () => {
  const fresh = view({ state: "off", applied: undefined, suggested_port: undefined });
  const form = formFor("enable", fresh, NODE);
  assert.equal(form.port, "");
  const planned = plannedSettings("enable", form, fresh, NODE);
  assert.deepEqual([planned.port, planned.portRandom, planned.endpoint, planned.endpointDefault, planned.problems], [undefined, true, undefined, true, []]);
  assert.deepEqual(buildBeaconPlanRequest(JP, "enable", form, fresh), { node_id: "jp", action: "enable" });
  // Any other address needs its port named: the server advertises only the public IPv4 with the port it draws.
  const inside = { ...form, endpointAddress: "10.0.0.5" };
  assert.deepEqual(plannedSettings("enable", inside, fresh, NODE).problems, [{ field: "endpointPort", code: "needed" }]);
  assert.equal(plannedSettings("enable", { ...inside, endpointPort: "50231" }, fresh, NODE).endpoint, "10.0.0.5:50231");
});

test("the form refuses what the server would, field by field", () => {
  const off = view({ state: "off", applied: undefined });
  const bad = plannedSettings("enable", { port: "80", bind: "127.0.0.1", endpointAddress: "203.0.113.12", endpointOther: "", endpointPort: "70000" }, off, NODE);
  assert.deepEqual(bad.problems, [
    { field: "port", code: "range" },
    { field: "bind", code: "refused" },
    { field: "endpointPort", code: "range" },
  ]);
  const bare = plannedSettings("enable", formFor("enable", off, {}), off, {});
  assert.deepEqual(bare.problems, [
    { field: "bind", code: "noDefault" },
    { field: "endpointAddress", code: "missing" },
  ]);
  for (const raw of ["0", "080", "+80", "1.5"]) {
    assert.deepEqual(plannedSettings("enable", { ...formFor("enable", off, NODE), endpointPort: raw }, off, NODE).problems, [{ field: "endpointPort", code: "range" }], raw);
  }
});

test("a change opens on the applied settings and sends only what moved; an endpoint on the listen port follows it", () => {
  const on = view({ applied: { enabled: true, port: 47231, bind: "10.0.0.5", endpoint: "203.0.113.12:47231", limits: DEFAULT_BEACON_LIMITS } });
  const form = formFor("change", on, NODE);
  assert.deepEqual(form, { port: "47231", bind: "10.0.0.5", endpointAddress: "203.0.113.12", endpointOther: "", endpointPort: "" });
  assert.deepEqual(buildBeaconPlanRequest(JP, "change", form, on), { node_id: "jp", action: "change" });
  assert.deepEqual(changedSettings(form, on, JP), [], "nothing moved: the plan re-plans the source set");
  const moved = { ...form, port: "51000" };
  assert.deepEqual(buildBeaconPlanRequest(JP, "change", moved, on), { node_id: "jp", action: "change", port: 51000, endpoint: "203.0.113.12:51000" });
  assert.deepEqual(changedSettings(moved, on, JP), ["port", "endpoint"]);
  // A mapped endpoint opens with its outside port and stays where the operator put it.
  const mapped = view();
  const mappedForm = formFor("change", mapped, NODE);
  assert.equal(mappedForm.endpointPort, "50231");
  assert.equal(plannedSettings("change", { ...mappedForm, port: "51000" }, mapped, NODE).endpoint, "203.0.113.12:50231");
  // An emptied field keeps the current value.
  assert.equal(plannedSettings("change", { ...mappedForm, port: "", bind: "" }, mapped, NODE).bind, "10.0.0.5");
  // An applied edge address stays chosen, and unchanged it is not sent.
  const edge = view({ applied: { enabled: true, port: 47231, bind: "10.0.0.5", endpoint: "198.51.100.40:47231", limits: DEFAULT_BEACON_LIMITS } });
  const edgeForm = formFor("change", edge, NODE);
  assert.equal(edgeForm.endpointAddress, "198.51.100.40");
  assert.deepEqual(buildBeaconPlanRequest(JP, "change", edgeForm, edge), { node_id: "jp", action: "change" });
});

test("a disable names nothing but the action", () => {
  const junk = { port: "1", bind: "x", endpointAddress: "y", endpointOther: "z", endpointPort: "0" };
  assert.deepEqual(buildBeaconPlanRequest(JP, "disable", junk, view()), { node_id: "jp", action: "disable" });
  assert.deepEqual(plannedSettings("disable", formFor("disable", view(), NODE), view(), NODE).problems, []);
});

/* ---- The NetGuard companion ---- */

test("the companion's outcome is read only while NetGuard holds the beacon closed", () => {
  const pending = view({ firewall_pending: true, applied_approval_id: "approval_b1" });
  assert.equal(companionApprovalToRead(pending), "approval_b1");
  assert.equal(companionApprovalToRead({ ...pending, firewall_pending: false }), undefined);
  assert.equal(companionApprovalToRead({ ...pending, exposure: "internet" }), undefined, "no NetGuard, no companion");
  assert.equal(companionApprovalToRead({ ...pending, state: "off" }), undefined);
  assert.equal(companionApprovalToRead({ ...pending, applied_approval_id: undefined }), undefined);
});

test("the companion's outcome follows its approval: applying, failed in the task's words, or applied", () => {
  assert.deepEqual(companionOutcome({ status: "approved", waiting: { code: "task_running", reason: " Task task_9c1 is running on gomami. ", blocked: false } }), {
    kind: "applying",
    reason: "Task task_9c1 is running on gomami.",
    blocked: false,
  });
  assert.deepEqual(companionOutcome({ status: "approved", waiting: { code: "node_offline", reason: "gomami has been offline for 2 hours.", blocked: true } }), {
    kind: "applying",
    reason: "gomami has been offline for 2 hours.",
    blocked: true,
  });
  assert.deepEqual(companionOutcome({ status: "approved" }), { kind: "applying", reason: undefined, blocked: false });
  assert.deepEqual(companionOutcome({ status: "rejected", reason: "nft: Could not process rule: No such file or directory" }), {
    kind: "failed",
    reason: "nft: Could not process rule: No such file or directory",
  });
  assert.deepEqual(companionOutcome({ status: "failed" }), { kind: "failed", reason: undefined });
  assert.deepEqual(companionOutcome({ status: "applied" }), { kind: "applied" });
  assert.deepEqual(companionOutcome({ status: "pending" }), { kind: "unknown" });
  assert.deepEqual(companionOutcome(undefined), { kind: "unknown" });
});

test("a 403 is told apart from other refusals", () => {
  assert.equal(beaconForbidden({ status: 403 }), true);
  assert.equal(beaconForbidden({ status: 404 }), false);
  assert.equal(beaconForbidden(null), false);
});

/* ---- The plan document ---- */

const PLAN: BeaconPlan = {
  kind: "node.beacon",
  node_id: "jp",
  node_name: "[cd]-xuezhang-jp-nat",
  action: "change",
  beacon: { enabled: true, port: 51000, bind: "10.0.0.5", endpoint: "203.0.113.12:51000", limits: DEFAULT_BEACON_LIMITS },
  previous: { enabled: true, port: 47231, bind: "10.0.0.5", endpoint: "203.0.113.12:47231", limits: DEFAULT_BEACON_LIMITS },
  sources: [{ node_id: "sh", name: "cd-hs-sh", source_id: 3, allow: ["10.88.0.2/32", "203.0.113.5/32"] }],
  exposure: "netguard",
  netguard: { port: 51000, allow: ["10.88.0.2/32", "203.0.113.5/32", "203.0.113.5/32"], notrack: true, binding_version: 12, ruleset_sha256: "9f2c41d0aa", ruleset: "table inet lattice_guard {}" },
  base_version: 4,
};

test("the filed plan is read from the approval's text, the bytes it binds", () => {
  const text = JSON.stringify({ ...PLAN, node_name: "from the text" }, null, 2);
  assert.equal(readBeaconPlan(text, PLAN)?.node_name, "from the text");
  assert.equal(readBeaconPlan("not json", PLAN)?.node_name, PLAN.node_name);
  assert.equal(readBeaconPlan(undefined, undefined), undefined);
});

test("settings rows say what changes, and an enable shows what opens", () => {
  const rows = settingsRows(PLAN);
  assert.deepEqual(
    rows.map((r) => [r.key, r.before, r.after, r.changed]),
    [
      ["state", "on", "on", false],
      ["port", "47231", "51000", true],
      ["bind", "10.0.0.5", "10.0.0.5", false],
      ["endpoint", "203.0.113.12:47231", "203.0.113.12:51000", true],
    ],
  );
  const enable = settingsRows({ ...PLAN, previous: undefined });
  assert.deepEqual(enable[0], { key: "state", before: "off", after: "on", changed: true });
  assert.equal(enable[1]!.before, undefined);
  const disable = settingsRows({ beacon: { ...PLAN.beacon, enabled: false }, previous: PLAN.previous });
  assert.deepEqual(disable.map((r) => r.after), ["off", undefined, undefined, undefined]);
});

test("findings put blocks first; a 409 carries the ones that refused the plan", () => {
  const sorted = sortFindings([
    { code: "open_to_internet", severity: "warn", message: "w" },
    { code: "port_sshd", severity: "block", message: "b" },
  ]);
  assert.deepEqual(sorted.map((f) => f.code), ["port_sshd", "open_to_internet"]);
  const refused = Object.assign(new Error("plan blocked by lint findings"), { status: 409, body: { error: "plan blocked by lint findings", findings: [{ code: "port_knock", severity: "block", message: "m" }] } });
  assert.deepEqual(refusedFindings(refused).map((f) => f.code), ["port_knock"]);
  assert.deepEqual(refusedFindings(Object.assign(new Error("stale"), { status: 409, body: { error: "the node's beacon is already enabled" } })), []);
  assert.deepEqual(refusedFindings(Object.assign(new Error("bad"), { status: 400, body: { findings: [{ code: "x", severity: "block", message: "" }] } })), []);
});

test("the companion counts each admitted address once; hashes keep both ends", () => {
  assert.equal(companionAllowCount(PLAN), 2);
  assert.equal(companionAllowCount({ netguard: undefined }), 0);
  assert.equal(shortHash("9f2c41d0aa7712e1bb63c04f5e1d9ab07e1"), "9f2c41…07e1");
  assert.equal(shortHash("abcd"), "abcd");
});

/* ---- Reachability and rotation ---- */

test("reachability reads the verdict, and nothing before a check was armed", () => {
  assert.equal(reachState(view({ reachability: {} })), undefined);
  assert.equal(reachState(view({ reachability: { state: "filtered", source: "sh" } })), "filtered");
  assert.equal(reachState(view({ reachability: { state: "something_new" } })), undefined);
  assert.equal(nextEpoch(view({ epoch: 3 })), 4);
  assert.equal(nextEpoch(view({ epoch: undefined })), 1);
});

test("a reachability check is known by its manager or its id, and is not a path", () => {
  assert.equal(isReachabilityCheck({ id: "mon_beaconr_jp", managed_by: "beacon" }), true);
  assert.equal(isReachabilityCheck({ monitor_id: "mon_beaconr_jp" }), true);
  assert.equal(isReachabilityCheck({ id: "mon_latb_jp", managed_by: "latency" }), false);
  assert.equal(isReachabilityCheck(undefined), false);
});

test("a target's beacon that no plan can fix is read from its agent's report, in the server's order", () => {
  assert.equal(beaconTargetBlock({ beacon: { responder: true, refusal: "refused_by_node", state: "refused" } }), "refused_by_node");
  assert.equal(beaconTargetBlock({ beacon: undefined }), "agent_too_old", "an agent before M2b reports nothing");
  assert.equal(beaconTargetBlock({ beacon: { responder: false, state: "off" } }), "agent_too_old");
  assert.equal(beaconTargetBlock({ beacon: { responder: true, state: "bind_failed" } }), "beacon_not_listening");
  assert.equal(beaconTargetBlock({ beacon: { responder: true, state: "circuit_open" } }), "beacon_not_listening");
  assert.equal(beaconTargetBlock({ beacon: { responder: true, state: "listening" } }), undefined);
  assert.equal(beaconTargetBlock({ beacon: { responder: true, state: "off" } }), undefined, "a beacon still opening waits, it is not blocked");
});

test("a refusal marks the field it is about, from a blocking finding or the server's words", () => {
  const block = (code: string) => [{ code, severity: "block", message: "" }];
  assert.equal(refusalField("plan blocked by lint findings", block("port_sshd")), "port");
  assert.equal(refusalField("plan blocked by lint findings", block("port_singbox_inbound")), "port");
  assert.equal(refusalField("plan blocked by lint findings", block("bind_wireguard")), "bind");
  assert.equal(refusalField("plan blocked", [{ code: "port_sshd", severity: "warn", message: "" }]), undefined, "a warning blocks nothing");
  assert.equal(refusalField("endpoint 198.51.100.40:50231 is not one of the node's addresses (its public IPv4, its primary interface address or a provider edge its lines declare)"), "endpointAddress");
  assert.equal(refusalField("endpoint: beacon: not an IPv4 literal"), "endpointAddress");
  assert.equal(refusalField("the node has no public IPv4 to advertise; name the endpoint (address:port)"), "endpointAddress");
  assert.equal(refusalField("bind: beacon: address refused"), "bind");
  assert.equal(refusalField("the node reports no IPv4 address to bind; name one with bind"), "bind");
  assert.equal(refusalField("port must be 1024 to 65535"), "port");
  assert.equal(refusalField("the node's beacon is already enabled; plan a change instead"), undefined, "about the plan as a whole");
  assert.equal(refusalField(undefined), undefined);
});

/* ---- A change plan the sources need (the server's replan) ---- */

test("replan: the server's word is read as sent, and the form it opens files exactly the server's request", () => {
  const node = { id: "jp", name: "xuezhang-jp-nat", internal_ip: "10.0.0.5", public_ip: "203.0.113.12" };
  const replan = { node_id: "jp", name: "xuezhang-jp-nat", reason: "firewall_pending", added: ["fsn"], removed: ["mk"], request: { node_id: "jp", action: "change" as const } };
  const v = view({ replan });
  const item = replanOf(v, "xuezhang-jp-nat");
  assert.deepEqual(item, { nodeId: "jp", name: "xuezhang-jp-nat", reason: "firewall_pending", added: ["fsn"], removed: ["mk"], pendingApprovalId: undefined, request: { node_id: "jp", action: "change" } });
  // Pre-filled from what the server provides: the change form opens on the applied settings, and untouched it asks
  // for nothing but the change, which keeps the port, bind address and endpoint and re-plans the sources.
  assert.deepEqual(buildBeaconPlanRequest(node, "change", formFor("change", v, node), v), item!.request);
  assert.deepEqual(changedSettings(formFor("change", v, node), v, node), []);
  // The names come from the view's sources; a source the view does not name falls back to the page's, then its id.
  assert.deepEqual(replanNames(item!, v), { added: ["hetzner-fsn"], removed: ["mkcloud"] });
  assert.deepEqual(replanNames({ added: ["x1"], removed: [] }, v, (id) => (id === "x1" ? "far-node" : undefined)), { added: ["far-node"], removed: [] });
  assert.deepEqual(replanNames({ added: ["x2"], removed: [] }), { added: ["x2"], removed: [] });
  // The server said nothing is needed: null is an answer, not a reason to work it out from the sources.
  assert.equal(replanOf(view({ replan: null })), undefined);
  // A request that names another node is not trusted; the change on this node is.
  assert.deepEqual(readBeaconReplan({ ...replan, request: { node_id: "other", action: "change" } })?.request, { node_id: "jp", action: "change" });
  assert.equal(readBeaconReplan({ ...replan, node_id: "" }), undefined);
  assert.equal(readBeaconReplan(null), undefined);
  // The matrix's list, by node; an open plan is kept so the console offers its review instead of another.
  const list = readBeaconReplans([replan, { ...replan, node_id: "hel", name: "hetzner-hel", reason: "beacon_source_pending", added: null, removed: null, pending_approval_id: "apr_9" }]);
  assert.deepEqual([...list.keys()], ["jp", "hel"]);
  // hel's entry carries jp's request (copied above), so it is replaced by the change on hel.
  assert.deepEqual(list.get("hel"), { nodeId: "hel", name: "hetzner-hel", reason: "beacon_source_pending", added: [], removed: [], pendingApprovalId: "apr_9", request: { node_id: "hel", action: "change" } });
  assert.equal(readBeaconReplans(null).size, 0);
});

test("replan: from a server before it, the same rule from the sources (the server's beaconReplanFor)", () => {
  // NetGuard: hetzner-fsn uses the beacon unadmitted, mkcloud is admitted but left; both need the plan.
  assert.deepEqual(replanOf(view(), "xuezhang-jp-nat"), {
    nodeId: "jp",
    name: "xuezhang-jp-nat",
    reason: "firewall_pending",
    added: ["fsn"],
    removed: ["mk"],
    pendingApprovalId: undefined,
    request: { node_id: "jp", action: "change" },
  });
  // Without NetGuard a source that left drops out at the next config pull: only the added one needs a plan.
  const open = view({ exposure: "internet" });
  assert.deepEqual([replanOf(open)?.reason, replanOf(open)?.added, replanOf(open)?.removed], ["beacon_source_pending", ["fsn"], []]);
  assert.equal(replanOf(view({ exposure: "internet", sources: [{ node_id: "mk", name: "mkcloud", source_id: 9, approved: true, current: false }] })), undefined);
  // Nothing differs, the beacon is off, or there is no view: no plan.
  assert.equal(replanOf(view({ sources: [{ node_id: "sh", name: "cd-hs-sh", source_id: 3, approved: true, current: true }] })), undefined);
  assert.equal(replanOf(view({ state: "off", applied: null })), undefined);
  assert.equal(replanOf(undefined), undefined);
  assert.equal(replanOf(view({ pending_approval_id: "apr_1" }))?.pendingApprovalId, "apr_1");
});

test("replan: the scopes to file it, and what is said, in plain words", () => {
  const firewall = { reason: "firewall_pending" as const };
  const plan = { reason: "beacon_source_pending" as const };
  assert.deepEqual(replanMissingScopes(firewall, ALL), []);
  assert.deepEqual(replanMissingScopes(firewall, { ...ALL, netguardAdmin: false }), ["netguard:admin"], "a NetGuard companion needs netguard:admin too");
  assert.deepEqual(replanMissingScopes(plan, { ...ALL, netguardAdmin: false }), []);
  assert.deepEqual(replanMissingScopes(plan, { monitorAdmin: false, nodeAdmin: true, networkPlan: false, netguardAdmin: false }), ["monitor:admin", "network:plan"]);

  const R = "fleet.monitoring.beacon.replan.";
  assert.deepEqual(replanLines(firewall, { added: ["hetzner-fsn", "fra-2"], removed: ["mkcloud"] }, "tyo-3"), [
    { key: `${R}firewall`, params: { target: "tyo-3", names: "hetzner-fsn, fra-2" }, n: 2 },
    { key: `${R}removed`, params: { target: "tyo-3", names: "mkcloud" }, n: 1 },
  ]);
  assert.deepEqual(replanLines(plan, { added: ["hetzner-fsn"], removed: [] }, "tyo-3"), [{ key: `${R}plan`, params: { target: "tyo-3", names: "hetzner-fsn" }, n: 1 }]);
  // A plan needed for sources this session may not read is said without their names.
  assert.deepEqual(replanLines(firewall, { added: [], removed: [] }, "tyo-3"), [{ key: `${R}firewallUnnamed`, params: { target: "tyo-3" }, n: 1 }]);
  assert.deepEqual(replanLines(firewall, { added: [], removed: ["mkcloud"] }, "tyo-3"), [{ key: `${R}removed`, params: { target: "tyo-3", names: "mkcloud" }, n: 1 }]);
  // The attention list's claim is one line, the first.
  assert.deepEqual(replanLines(firewall, { added: ["hetzner-fsn"], removed: ["mkcloud"] }, "tyo-3", "claim"), [{ key: `${R}claim.firewall`, params: { target: "tyo-3", names: "hetzner-fsn" }, n: 1 }]);
  assert.deepEqual(replanLines(plan, { added: [], removed: [] }, "tyo-3", "claim"), [{ key: `${R}claim.planUnnamed`, params: { target: "tyo-3" }, n: 1 }]);
});

test("replan: a server that words it omits the field when nothing is needed, and that absence is an answer", () => {
  // view() needs a plan by the sources' rule (fsn unadmitted, mk left); a server known to word it said none by omitting replan.
  assert.equal(replanOf(view(), "xuezhang-jp-nat", true), undefined);
  // Unknown server (no paths read, or one before the follow-ups): the rule from the sources stands in for it.
  assert.equal(replanOf(view(), "xuezhang-jp-nat", false)?.reason, "firewall_pending");
  // A replan the server sends is read either way.
  const replan = { node_id: "jp", name: "xuezhang-jp-nat", reason: "beacon_source_pending", added: ["fsn"], removed: [], request: { node_id: "jp", action: "change" as const } };
  assert.equal(replanOf(view({ replan }), "", true)?.reason, "beacon_source_pending");
});

test("replan: the beacon read again for the action decides over an older paths read", () => {
  const node = { id: "jp", name: "xuezhang-jp-nat", internal_ip: "10.0.0.5", public_ip: "203.0.113.12" };
  // The paths read as the server sends it before anyone files the plan: beacon_replans with no waiting approval.
  const matrix = buildPathsMatrix({
    window: "1h",
    sources: [{ node_id: "fsn", name: "hetzner-fsn" }],
    targets: [{ node_id: "jp", name: "xuezhang-jp-nat" }],
    paths: [],
    beacon_replans: [{ node_id: "jp", name: "xuezhang-jp-nat", reason: "firewall_pending", added: ["fsn"], removed: [], request: { node_id: "jp", action: "change" } }],
  } as unknown as PathsResponse);
  const offered = matrix.replans.get("jp");
  assert.ok(offered && !offered.pendingApprovalId, "the surface offers the plan itself");
  const replan = { node_id: "jp", name: "xuezhang-jp-nat", reason: "firewall_pending", added: ["fsn"], removed: [], request: { node_id: "jp", action: "change" as const } };

  // Nothing filed meanwhile: the plan sheet opens on the fresh word, which files exactly the server's request.
  const fresh = view({ replan });
  const plan = replanStep(fresh, "xuezhang-jp-nat", matrix.replansKnown);
  assert.ok(plan.kind === "plan");
  assert.deepEqual(buildBeaconPlanRequest(node, "change", formFor("change", fresh, node), fresh), plan.item.request);

  // A plan was filed since (another tab, another operator): the beacon names it, as the server's beaconView does in
  // both its pending_approval_id and its replan. The action reviews that plan instead of filing a second one.
  const waits = replanStep(view({ pending_approval_id: "apr_4", replan: { ...replan, pending_approval_id: "apr_4" } }), "xuezhang-jp-nat", matrix.replansKnown);
  assert.deepEqual(waits.kind === "waits" && [waits.approvalId, waits.item.pendingApprovalId], ["apr_4", "apr_4"]);
  // From a server before the follow-ups the rule from the sources finds the same waiting plan.
  const before = replanStep(view({ pending_approval_id: "apr_5" }), "xuezhang-jp-nat", false);
  assert.equal(before.kind === "waits" && before.approvalId, "apr_5");

  // The plan applied since: the beacon omits replan, and nothing opens.
  assert.deepEqual(replanStep(view(), "", matrix.replansKnown), { kind: "settled" });
  // From a server before the follow-ups, sources that match the applied plan say the same.
  assert.deepEqual(replanStep(view({ sources: [{ node_id: "fsn", name: "hetzner-fsn", source_id: 7, approved: true, current: true }] }), "", false), { kind: "settled" });
  assert.deepEqual(replanStep(undefined), { kind: "settled" });
});

test("replan: the surface a read belongs to is the layer and its open sheet", () => {
  const pathSheet = replanSurface("paths", { path: "node_004~@mon_beacon_jp", open: undefined });
  assert.equal(pathSheet, replanSurface("paths", { path: "node_004~@mon_beacon_jp" }));
  // The sheet closed, another one opened, or the layer changed: a different surface, so the read is dropped.
  assert.notEqual(pathSheet, replanSurface("paths", {}));
  assert.notEqual(pathSheet, replanSurface("paths", { path: "node_005~@mon_beacon_jp" }));
  assert.notEqual(pathSheet, replanSurface("checks", { path: "node_004~@mon_beacon_jp" }));
  assert.notEqual(replanSurface("checks", { open: "mon_beacon_jp" }), replanSurface("checks", {}));
  // A repeated query parameter reads as its first value, as the page reads it.
  assert.equal(replanSurface("checks", { open: ["mon_beacon_jp", "x"] }), replanSurface("checks", { open: "mon_beacon_jp" }));
  // Other parameters (a filter, the window) leave the surface as it is.
  assert.equal(replanSurface("overview", { open: undefined, path: undefined }), replanSurface("overview", {}));
});
