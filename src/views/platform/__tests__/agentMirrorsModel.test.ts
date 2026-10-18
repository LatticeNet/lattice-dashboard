import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_MIRROR_PREFER_FOR,
  draftChangesMirror,
  draftFromMirror,
  emptyMirrorDraft,
  filterOrderGroups,
  groupOrderChanges,
  groupOrders,
  healthById,
  isNodeConfined,
  mirrorDraftProblems,
  mirrorFieldValue,
  mirrorFromDraft,
  mirrorPlanDiff,
  mirrorReach,
  mirrorRefLabel,
  mirrorScope,
  mirrorsWithChunkFailures,
  namePreview,
  parseAgentMirrorPlan,
  parseSourceLabel,
  parseSourceList,
  pendingByMirror,
  planBehindRegistry,
  planHeadline,
  sortMirrors,
  type MirrorDraft,
} from "../agentMirrorsModel.ts";
import type { AgentMirror, AgentMirrorOrder } from "../../../lib/api/types.ts";
import enPlatform from "../../../i18n/locales/en/platform.ts";
import zhPlatform from "../../../i18n/locales/zh-CN/platform.ts";

const R2: AgentMirror = { id: "r2", name: "Cloudflare R2", base_url: "https://agent.dl.example.com/lattice-agent", global: true, priority: 10, enabled: true };

test("order labels read as a mirror, the control plane or upstream, and a stale entry's * is kept apart", () => {
  assert.deepEqual(parseSourceLabel("mirror:r2"), { kind: "mirror", mirror: "r2", raw: "mirror:r2", changed: false });
  assert.deepEqual(parseSourceLabel("control-plane"), { kind: "controlPlane", raw: "control-plane", changed: false });
  assert.deepEqual(parseSourceLabel("upstream*"), { kind: "upstream", raw: "upstream", changed: true });
  assert.equal(parseSourceLabel("mirror:").kind, "other", "a mirror label without an id is not a mirror");
  assert.equal(parseSourceLabel("ftp").kind, "other");
  // lattice-server agentUpdateSourcesChange: comma-joined, empty means none.
  assert.deepEqual(
    parseSourceList("mirror:r2*,control-plane,upstream").map((source) => [source.kind, source.mirror, source.changed]),
    [
      ["mirror", "r2", true],
      ["controlPlane", undefined, false],
      ["upstream", undefined, false],
    ],
  );
  assert.deepEqual(parseSourceList(""), []);
});

/** Forty nodes as the server's order lists them (by id), on three orders. */
function fleetOrder(): AgentMirrorOrder[] {
  return Array.from({ length: 40 }, (_, index) => {
    const id = `node_${String(index + 1).padStart(3, "0")}`;
    const sources =
      index < 6
        ? ["mirror:cn-cache", "control-plane", "mirror:r2", "upstream"]
        : index === 6
          ? ["control-plane", "upstream"]
          : ["control-plane", "mirror:r2", "upstream"];
    return { node_id: id, name: `edge-${String(40 - index).padStart(2, "0")}`, sources };
  });
}

test("forty nodes on three orders read as three rows, the largest first, nodes by name", () => {
  const groups = groupOrders(fleetOrder());
  assert.deepEqual(
    groups.map((group) => [group.sources.join(" "), group.nodes.length]),
    [
      ["control-plane mirror:r2 upstream", 33],
      ["mirror:cn-cache control-plane mirror:r2 upstream", 6],
      ["control-plane upstream", 1],
    ],
  );
  assert.deepEqual(groups[1]?.nodes.map((node) => node.name), ["edge-35", "edge-36", "edge-37", "edge-38", "edge-39", "edge-40"]);
  assert.equal(groups.reduce((sum, group) => sum + group.nodes.length, 0), 40, "every node is in exactly one row");
});

test("a node without a name is listed by its id, and an empty order is its own row", () => {
  const groups = groupOrders([
    { node_id: "node_b", sources: [] },
    { node_id: "node_a", name: "alpha", sources: [] },
  ]);
  assert.deepEqual(groups, [{ key: "", sources: [], nodes: [{ id: "node_a", name: "alpha" }, { id: "node_b", name: "node_b" }] }]);
});

test("the filter keeps the rows holding a matching node, with only those nodes, by name or id", () => {
  const groups = groupOrders(fleetOrder());
  assert.deepEqual(
    filterOrderGroups(groups, "EDGE-3").map((group) => [group.sources[0], group.nodes.map((node) => node.name)]),
    [
      ["control-plane", ["edge-30", "edge-31", "edge-32", "edge-33"]],
      ["mirror:cn-cache", ["edge-35", "edge-36", "edge-37", "edge-38", "edge-39"]],
      ["control-plane", ["edge-34"]],
    ],
  );
  assert.deepEqual(filterOrderGroups(groups, "node_007").map((group) => group.nodes.map((node) => node.id)), [["node_007"]]);
  assert.deepEqual(filterOrderGroups(groups, "nothing-here"), []);
  // A mirror's id keeps every row that lists it whole: which nodes use it.
  assert.deepEqual(
    filterOrderGroups(groups, "CN-cache").map((group) => [group.sources[0], group.nodes.length]),
    [["mirror:cn-cache", 6]],
  );
  assert.equal(filterOrderGroups(groups, "r2").reduce((sum, group) => sum + group.nodes.length, 0), 39, "every node that lists r2");
  assert.deepEqual(filterOrderGroups(groups, "upstream"), [], "the fixed sources are not a filter; every node has them");
  assert.equal(filterOrderGroups(groups, "  ").length, 3, "blank text keeps every row whole");
});

test("a mirror's reach counts the nodes that list it", () => {
  const order = fleetOrder();
  assert.equal(mirrorReach(order, "r2"), 39);
  assert.equal(mirrorReach(order, "cn-cache"), 6);
  assert.equal(mirrorReach(order, "gone"), 0);
  assert.equal(mirrorReach(order, "r"), 0, "a label matches whole, never by prefix");
});

test("an entry applies where it is preferred, globally, both, or nowhere", () => {
  assert.equal(mirrorScope({ prefer_for: ["grp_cn"], global: false }), "preferred");
  assert.equal(mirrorScope({ global: true }), "global");
  assert.equal(mirrorScope({ prefer_for: ["node_001"], global: true }), "both");
  assert.equal(mirrorScope({ prefer_for: [] }), "nowhere");
});

test("the registry reads in the server's rank, priority and then id", () => {
  const mirrors = sortMirrors([
    { ...R2, id: "zz", priority: 0 },
    { ...R2, id: "b", priority: 10 },
    { ...R2, id: "a", priority: 10 },
  ]);
  assert.deepEqual(mirrors.map((mirror) => mirror.id), ["zz", "a", "b"]);
});

test("health is keyed by mirror, and only chunk failures raise attention", () => {
  const health = [
    { mirror: "r2", fetches: 31, chunk_failures: 0 },
    { mirror: "cn-cache", fetches: 6, chunk_failures: 2 },
  ];
  assert.equal(healthById(health).get("cn-cache")?.fetches, 6);
  assert.equal(healthById(undefined).size, 0);
  assert.deepEqual(mirrorsWithChunkFailures(health).map((entry) => entry.mirror), ["cn-cache"]);
  assert.deepEqual(mirrorsWithChunkFailures(null), []);
});

test("a principal is confined exactly when the server says so: an allowlist without *", () => {
  assert.equal(isNodeConfined(undefined), false);
  assert.equal(isNodeConfined([]), false);
  assert.equal(isNodeConfined(["*"]), false);
  assert.equal(isNodeConfined(["node_001", "*"]), false);
  assert.equal(isNodeConfined(["node_001"]), true);
});

test("a prefer_for entry names a node first, then a group, else stays its id", () => {
  const nodes = new Map([["node_001", "[cd]-hkbn-hub"]]);
  const groups = new Map([["grp_mainland", "Mainland"], ["node_001", "shadowed"]]);
  assert.deepEqual(mirrorRefLabel("node_001", nodes, groups), { kind: "node", text: "[cd]-hkbn-hub" });
  assert.deepEqual(mirrorRefLabel("grp_mainland", nodes, groups), { kind: "group", text: "Mainland" });
  assert.deepEqual(mirrorRefLabel("grp_gone", nodes, groups), { kind: "unknown", text: "grp_gone" });
});

function draft(over: Partial<MirrorDraft>): MirrorDraft {
  return { ...emptyMirrorDraft(), id: "r2", base_url: "https://agent.dl.example.com/lattice-agent", ...over };
}

test("the draft is refused where validateAgentMirror refuses it, field by field", () => {
  assert.deepEqual(mirrorDraftProblems(draft({})), {});
  assert.equal(mirrorDraftProblems(draft({ id: "R2" })).id, "idInvalid");
  assert.equal(mirrorDraftProblems(draft({ id: "-r2" })).id, "idInvalid");
  assert.equal(mirrorDraftProblems(draft({ id: "a".repeat(32) })).id, "idInvalid");
  assert.equal(mirrorDraftProblems(draft({ id: "a".repeat(31) })).id, undefined);
  assert.equal(mirrorDraftProblems(draft({ name: "x".repeat(81) })).name, "nameTooLong");
  assert.equal(mirrorDraftProblems(draft({ name: "镜".repeat(80) })).name, undefined, "the limit counts characters, not bytes");
  assert.equal(mirrorDraftProblems(draft({ name: "two\nlines" })).name, "nameNotPrintable");
  const url = (base_url: string) => mirrorDraftProblems(draft({ base_url })).base_url;
  assert.equal(url(""), "urlRequired");
  assert.equal(url("http://agent.dl.example.com"), "urlNotHttps");
  assert.equal(url("https:agent.dl.example.com"), "urlNotHttps");
  assert.equal(url("https://user:pw@agent.dl.example.com"), "urlUserinfo");
  assert.equal(url("https://agent.dl.example.com/a?token=1"), "urlQuery");
  assert.equal(url("https://agent.dl.example.com/a#x"), "urlFragment");
  assert.equal(url("https://agent.dl.example.com/a%20b"), "urlPath");
  assert.equal(url("https://agent.dl.example.com/a/b_c~d+e-f.g/"), undefined);
  assert.equal(url("https://agent.dl.example.com/a/../b"), "urlDotSegment", "URL() would resolve it away; the typed text keeps it");
  assert.equal(url("https://agent.dl.example.com/./a"), "urlDotSegment");
  assert.equal(url("https://agent.dl.example.com/a..b/.hidden"), undefined, "only a whole . or .. part is a dot segment");
  assert.equal(url("HTTPS://agent.dl.example.com"), undefined, "the scheme is matched as Go's url.Parse lowercases it");
  assert.equal(mirrorDraftProblems(draft({ priority: "" })).priority, "priorityInvalid");
  assert.equal(mirrorDraftProblems(draft({ priority: "-1" })).priority, "priorityInvalid");
  assert.equal(mirrorDraftProblems(draft({ priority: "1.5" })).priority, "priorityInvalid");
  assert.equal(mirrorDraftProblems(draft({ priority: "1000001" })).priority, "priorityInvalid");
  assert.equal(mirrorDraftProblems(draft({ priority: "1000000" })).priority, undefined);
  const many = Array.from({ length: MAX_MIRROR_PREFER_FOR + 1 }, (_, index) => `node_${index}`);
  assert.equal(mirrorDraftProblems(draft({ prefer_for: many })).prefer_for, "preferForTooMany");
});

test("the registry the page holds names the server's two conflicts before a round trip", () => {
  const registry: AgentMirror[] = [R2, { ...R2, id: "hk", base_url: "https://hk.example/agent" }];
  // Create: the id is taken, and so is another entry's base URL, compared as the server canonicalizes it.
  assert.equal(mirrorDraftProblems(draft({ id: "r2", base_url: "https://new.example" }), { registry }).id, "idTaken");
  assert.equal(mirrorDraftProblems(draft({ id: "new", base_url: "HTTPS://HK.example:443/agent/" }), { registry }).base_url, "urlTaken");
  assert.deepEqual(mirrorDraftProblems(draft({ id: "new", base_url: "https://new.example" }), { registry }), {});
  // Change: the entry's own id and URL are its own, another entry's URL is still taken.
  assert.deepEqual(mirrorDraftProblems(draft({ id: "r2", base_url: R2.base_url }), { registry, editing: "r2" }), {});
  assert.equal(mirrorDraftProblems(draft({ id: "r2", base_url: "https://hk.example/agent" }), { registry, editing: "r2" }).base_url, "urlTaken");
});

test("a draft becomes the entry the plan carries, trimmed, deduplicated and sorted as the server stores it", () => {
  assert.deepEqual(
    mirrorFromDraft(draft({ id: " r2 ", name: "  ", base_url: " https://agent.dl.example.com ", prefer_for: ["node_b", "grp_a", "node_b"], priority: " 20 ", global: true })),
    { id: "r2", base_url: "https://agent.dl.example.com", prefer_for: ["grp_a", "node_b"], global: true, priority: 20, enabled: true },
  );
  assert.deepEqual(mirrorFromDraft(draftFromMirror(R2)), { id: "r2", name: "Cloudflare R2", base_url: R2.base_url, global: true, priority: 10, enabled: true });
});

test("a change draft that reads as the entry already does is no change, so the form never files the server's 409", () => {
  const entry: AgentMirror = { ...R2, prefer_for: ["grp_a", "node_b"] };
  assert.equal(draftChangesMirror(draftFromMirror(entry), entry), false);
  assert.equal(draftChangesMirror({ ...draftFromMirror(entry), prefer_for: ["node_b", "grp_a"] }, entry), false, "order of prefer_for does not matter");
  assert.equal(draftChangesMirror({ ...draftFromMirror(entry), base_url: `${entry.base_url}/` }, entry), false, "a trailing slash is the same base");
  assert.equal(draftChangesMirror({ ...draftFromMirror(entry), base_url: "HTTPS://Agent.DL.example.com:443/lattice-agent" }, entry), false, "host case and the default port are the same base");
  assert.equal(draftChangesMirror({ ...draftFromMirror(entry), base_url: "https://agent.dl.example.com/Lattice-agent" }, entry), true, "the path keeps its case");
  assert.equal(draftChangesMirror({ ...draftFromMirror(entry), enabled: false }, entry), true);
  assert.equal(draftChangesMirror({ ...draftFromMirror(entry), priority: "11" }, entry), true);
  assert.equal(draftChangesMirror({ ...draftFromMirror(entry), name: "" }, entry), true);
});

/** A change plan as lattice-server renders it: json.MarshalIndent of model.AgentMirrorPlan, omitempty fields left out. */
const CHANGE_PLAN = JSON.stringify(
  {
    kind: "agent.mirrors",
    action: "change",
    mirror: { id: "r2", name: "Cloudflare R2", base_url: "https://agent.dl.example.com/lattice-agent", prefer_for: ["grp_mainland"], global: true, priority: 10, enabled: false },
    previous: { id: "r2", name: "Cloudflare R2", base_url: "https://agent.dl.example.com/lattice-agent", global: true, priority: 10, enabled: true },
    diff: ["prefer_for: - -> grp_mainland", "enabled: true -> false"],
    base_revision: 7,
    changes: [
      { node_id: "node_003", name: "edge-03", before: ["control-plane", "mirror:r2", "upstream"], after: ["control-plane", "upstream"] },
      { node_id: "node_001", name: "edge-01", before: ["control-plane", "mirror:r2", "upstream"], after: ["control-plane", "upstream"] },
      { node_id: "node_009", before: ["mirror:cn-cache", "control-plane", "mirror:r2", "upstream"], after: ["mirror:cn-cache", "control-plane", "upstream"] },
    ],
  },
  null,
  2,
);

test("the plan text reads back into the document, and anything else is not a mirrors plan", () => {
  const plan = parseAgentMirrorPlan(CHANGE_PLAN);
  assert.ok(plan);
  assert.equal(plan.action, "change");
  assert.equal(plan.base_revision, 7);
  assert.equal(plan.previous?.enabled, true);
  assert.equal(plan.changes.length, 3);
  assert.equal(plan.changes[2]?.name, undefined, "a node without a name keeps none");
  assert.equal(parseAgentMirrorPlan(undefined), undefined);
  assert.equal(parseAgentMirrorPlan("current_version: 0.3.8\ntarget_version: 0.3.9"), undefined, "an agent update plan is text");
  assert.equal(parseAgentMirrorPlan('{"kind":"node.beacon","action":"change","mirror":{"id":"x","base_url":"y"}}'), undefined);
  assert.equal(parseAgentMirrorPlan('{"kind":"agent.mirrors","action":"rename","mirror":{"id":"x","base_url":"y"}}'), undefined);
  assert.equal(parseAgentMirrorPlan('{"kind":"agent.mirrors","action":"delete"}'), undefined, "a plan without its entry");
  assert.equal(parseAgentMirrorPlan("{not json"), undefined);
  const bare = parseAgentMirrorPlan('{"kind":"agent.mirrors","action":"create","mirror":{"id":"x","base_url":"https://x.example","priority":0,"enabled":true}}');
  assert.deepEqual([bare?.diff, bare?.changes, bare?.base_revision], [[], [], 0], "absent lists read as empty");
});

test("the diff reads each line from the plan's own entries only when they give back the exact line", () => {
  const plan = parseAgentMirrorPlan(CHANGE_PLAN)!;
  const rows = mirrorPlanDiff(plan);
  assert.deepEqual(rows.map((row) => ("field" in row ? [row.field, mirrorFieldValue(row.before, row.field), mirrorFieldValue(row.after, row.field)] : row.raw)), [
    ["prefer_for", "-", "grp_mainland"],
    ["enabled", "true", "false"],
  ]);
  // A line the entries do not reproduce is kept as the server wrote it.
  assert.deepEqual(mirrorPlanDiff({ ...plan, diff: ["enabled: maybe -> false", "colour: blue -> red"] }), [{ raw: "enabled: maybe -> false" }, { raw: "colour: blue -> red" }]);
  // A name holding " -> " still reads as one field, since rendering the entries gives the same line.
  const named = { ...plan, previous: { ...plan.previous!, name: "a -> b" }, diff: ["name: a -> b -> Cloudflare R2"] };
  assert.deepEqual(mirrorPlanDiff(named).map((row) => ("field" in row ? row.field : row.raw)), ["name"]);
});

test("a delete's after is absent, and a create's before is", () => {
  const removed = { ...R2 };
  const del = parseAgentMirrorPlan(
    JSON.stringify({ kind: "agent.mirrors", action: "delete", mirror: removed, previous: removed, diff: ["name: Cloudflare R2 -> -", "base_url: https://agent.dl.example.com/lattice-agent -> -", "global: true -> -", "priority: 10 -> -", "enabled: true -> -"], base_revision: 3, changes: [] }),
  )!;
  assert.ok(mirrorPlanDiff(del).every((row) => "field" in row && row.after === undefined && row.before?.id === "r2"));
  const create = parseAgentMirrorPlan(
    JSON.stringify({ kind: "agent.mirrors", action: "create", mirror: removed, diff: ["name: - -> Cloudflare R2", "base_url: - -> https://agent.dl.example.com/lattice-agent", "global: - -> true", "priority: - -> 10", "enabled: - -> true"], base_revision: 0, changes: [] }),
  )!;
  assert.ok(mirrorPlanDiff(create).every((row) => "field" in row && row.before === undefined && row.after?.id === "r2"));
});

test("a change without its lists reads as empty lists, never a throw", () => {
  const groups = groupOrderChanges([{ node_id: "node_1" } as unknown as { node_id: string; before: string[]; after: string[] }]);
  assert.deepEqual(groups.map((group) => [group.before, group.after, group.nodes.length]), [[[], [], 1]]);
});

test("node changes that move the same way share a row, the largest first, nodes by name", () => {
  const groups = groupOrderChanges(parseAgentMirrorPlan(CHANGE_PLAN)!.changes);
  assert.deepEqual(
    groups.map((group) => [group.before.length, group.after.length, group.nodes.map((node) => node.name)]),
    [
      [3, 2, ["edge-01", "edge-03"]],
      [4, 3, ["node_009"]],
    ],
  );
});

test("a plan made against an older revision is behind, and an unread revision decides nothing", () => {
  assert.equal(planBehindRegistry({ base_revision: 7 }, 8), true);
  assert.equal(planBehindRegistry({ base_revision: 7 }, 7), false);
  assert.equal(planBehindRegistry({ base_revision: 7 }, undefined), false);
});

test("a long list names its first few and counts the rest, and never hides a single one", () => {
  const nodes = Array.from({ length: 11 }, (_, index) => ({ id: `n${index}`, name: `n${index}` }));
  assert.deepEqual([namePreview(nodes, 8).names.length, namePreview(nodes, 8).extra], [8, 3]);
  assert.deepEqual([namePreview(nodes.slice(0, 9), 8).names.length, namePreview(nodes.slice(0, 9), 8).extra], [9, 0], "show 1 more would cost a click for one name");
  assert.deepEqual([namePreview(nodes.slice(0, 10), 8).names.length, namePreview(nodes.slice(0, 10), 8).extra], [8, 2]);
  assert.equal(namePreview(nodes.slice(0, 2), 8).extra, 0);
});

test("a plan's headline names an enable or a disable, and otherwise the fields it changes", () => {
  const plan = parseAgentMirrorPlan(CHANGE_PLAN)!;
  assert.deepEqual(planHeadline(plan), { kind: "change", fields: ["prefer_for", "enabled"] });
  assert.deepEqual(planHeadline({ ...plan, diff: ["enabled: true -> false"] }), { kind: "disable" });
  assert.deepEqual(planHeadline({ ...plan, mirror: { ...plan.mirror, enabled: true }, diff: ["enabled: false -> true"] }), { kind: "enable" });
  assert.deepEqual(planHeadline({ ...plan, action: "delete" }), { kind: "delete" });
  assert.deepEqual(planHeadline({ ...plan, action: "create" }), { kind: "create" });
});

test("pending plans are keyed by the mirror they touch, and an unread plan by none", () => {
  const plan = parseAgentMirrorPlan(CHANGE_PLAN)!;
  const map = pendingByMirror([
    { id: "approval_a", plan },
    { id: "approval_b", plan: { ...plan, mirror: { ...plan.mirror, id: "cn-oss" } } },
    { id: "approval_c", plan },
    { id: "approval_d" },
  ]);
  assert.deepEqual([...map.entries()], [["r2", ["approval_a", "approval_c"]], ["cn-oss", ["approval_b"]]]);
});

test("every draft problem, field, plan action and source has copy in both locales", () => {
  const problems = ["idInvalid", "idTaken", "nameTooLong", "nameNotPrintable", "urlRequired", "urlNotHttps", "urlUserinfo", "urlQuery", "urlFragment", "urlPath", "urlDotSegment", "urlTaken", "priorityInvalid", "preferForTooMany"];
  for (const messages of [enPlatform, zhPlatform]) {
    const mirrors = (messages as unknown as { platform: { agentUpdatesPage: { mirrors: Record<string, Record<string, unknown>> } } }).platform.agentUpdatesPage.mirrors;
    const form = mirrors.form as { problems: Record<string, string> };
    for (const problem of problems) assert.equal(typeof form.problems[problem], "string", problem);
    for (const field of ["name", "base_url", "prefer_for", "global", "priority", "enabled"]) assert.equal(typeof mirrors.fields?.[field], "string", field);
    const plan = mirrors.plan as { headline: Record<string, string>; dialogTitle: Record<string, string> };
    for (const kind of ["create", "change", "delete", "enable", "disable"]) assert.equal(typeof plan.headline[kind], "string", kind);
    for (const action of ["create", "change", "delete"]) assert.equal(typeof plan.dialogTitle[action], "string", action);
    for (const source of ["mirror", "controlPlane", "upstream", "none", "changedInPlace"]) assert.equal(typeof mirrors.source?.[source], "string", source);
  }
});
