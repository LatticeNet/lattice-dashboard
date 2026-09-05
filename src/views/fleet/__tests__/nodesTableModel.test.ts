import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { Node } from "../../../lib/api/types.ts";
import {
  DEFAULT_HIDDEN_COLUMNS,
  NAME_CELL_CHROME_PX,
  NAME_TRACK_MAX_PX,
  NAME_TRACK_MIN_PX,
  NODE_TABLE_COLUMNS,
  SELECT_CELL_PX,
  estimateNameWidth,
  gridTemplate,
  nameTrackMin,
  nextSortState,
  parseHiddenColumns,
  parseSortState,
  serializeHiddenColumns,
  serializeSortState,
  sortNodes,
  tableMinWidthPx,
  trackMinPx,
  visibleColumns,
} from "../nodesTableModel.ts";

function node(partial: Partial<Node>): Node {
  return { id: "node-x", name: "x", ...partial } as Node;
}

test("nextSortState cycles none -> default -> flipped -> none", () => {
  const none = { key: "", dir: "asc" } as const;
  const first = nextSortState(none, "cpu");
  assert.deepEqual(first, { key: "cpu", dir: "desc" }); // metrics start desc
  const second = nextSortState(first, "cpu");
  assert.deepEqual(second, { key: "cpu", dir: "asc" });
  const third = nextSortState(second, "cpu");
  assert.deepEqual(third, { key: "", dir: "asc" });
  // identity columns start asc
  assert.deepEqual(nextSortState(none, "name"), { key: "name", dir: "asc" });
  // non-sortable columns leave state untouched
  assert.deepEqual(nextSortState(first, "tags"), first);
});

test("sortNodes orders by cpu desc with name tiebreak and tolerates missing metrics", () => {
  const rows = [
    node({ id: "a", name: "alpha", metrics: { cpu_percent: 10 } as Node["metrics"] }),
    node({ id: "b", name: "beta" }),
    node({ id: "c", name: "gamma", metrics: { cpu_percent: 90 } as Node["metrics"] }),
    node({ id: "d", name: "delta", metrics: { cpu_percent: 10 } as Node["metrics"] }),
  ];
  const sorted = sortNodes(rows, { key: "cpu", dir: "desc" });
  assert.deepEqual(
    sorted.map((n) => n.name),
    ["gamma", "alpha", "delta", "beta"],
  );
});

test("sortNodes by status follows the ontology's display order", () => {
  // The server's word decides; the legacy fields are set to contradict it on
  // purpose so a regression to reading `online` would reorder the rows.
  const rows = [
    node({ id: "a", name: "down", status: "offline", online: true }),
    node({ id: "b", name: "dead", status: "disabled", online: true }),
    node({ id: "c", name: "up", status: "online", online: false }),
    node({ id: "d", name: "never", status: "never_reported", online: true }),
    node({ id: "e", name: "limping", status: "degraded", online: false }),
  ];
  const sorted = sortNodes(rows, { key: "status", dir: "asc" });
  assert.deepEqual(
    sorted.map((n) => n.name),
    ["up", "limping", "down", "never", "dead"],
  );
  // Older servers without the word: the same order rebuilt from the flags.
  const legacy = [node({ id: "a", name: "down" }), node({ id: "b", name: "dead", disabled: true, online: true }), node({ id: "c", name: "up", online: true })];
  assert.deepEqual(
    sortNodes(legacy, { key: "status", dir: "asc" }).map((n) => n.name),
    ["up", "down", "dead"],
  );
});

test("sortNodes by lastSeen desc puts newest first and empty last", () => {
  const rows = [
    node({ id: "a", name: "old", last_seen: "2026-01-01T00:00:00Z" as Node["last_seen"] }),
    node({ id: "b", name: "never" }),
    node({ id: "c", name: "fresh", last_seen: "2026-08-01T00:00:00Z" as Node["last_seen"] }),
  ];
  const sorted = sortNodes(rows, { key: "lastSeen", dir: "desc" });
  assert.deepEqual(
    sorted.map((n) => n.name),
    ["fresh", "old", "never"],
  );
});

test("hidden-column persistence round-trips and rejects unknown/required ids", () => {
  const hidden = parseHiddenColumns("role, update,nonsense,name,");
  assert.deepEqual([...hidden].sort(), ["role", "update"]);
  assert.equal(serializeHiddenColumns(hidden), "role,update");
});

test("a console that has never been configured gets the default column set", () => {
  const hidden = parseHiddenColumns(null);
  assert.deepEqual([...hidden].sort(), [...DEFAULT_HIDDEN_COLUMNS].sort());
  // The default is the set that fits the card (see the width budget below):
  // identity, where to reach the node, its status, what the agent does, and
  // the row actions. Nothing else, and in this order.
  assert.deepEqual(
    visibleColumns(hidden).map((c) => c.id),
    ["name", "owner", "status", "tags", "publicIp", "agentConfig", "actions"],
  );
  // Hostname and Last seen left the default set to make room; they are still
  // in the catalog and the column manager lists them.
  for (const id of ["hostname", "lastSeen", "role", "cpu", "memory", "disk"]) {
    assert.ok(hidden.has(id), `${id} must be hidden by default`);
    assert.ok(NODE_TABLE_COLUMNS.find((c) => c.id === id)?.optional, `${id} must stay in the column manager`);
  }
});

test("an empty stored value means the operator wants every column, not the defaults", () => {
  // `null` (never configured) and `""` (configured, nothing hidden) are
  // different answers. Collapsing them would push the built-in defaults back
  // at an operator who has explicitly turned every column on.
  assert.equal(parseHiddenColumns("").size, 0);
  assert.ok(parseHiddenColumns(null).size > 0);
});

test("visibleColumns always keeps required columns and gridTemplate matches", () => {
  const hidden = parseHiddenColumns(
    NODE_TABLE_COLUMNS.filter((c) => c.optional)
      .map((c) => c.id)
      .join(","),
  );
  const visible = visibleColumns(hidden);
  assert.deepEqual(
    visible.map((c) => c.id),
    ["name", "status", "actions"],
  );
  assert.equal(gridTemplate(hidden).split(" ").length, visible.length);
});

/**
 * The live fleet's six widest name bodies at 14px medium, as Chrome on macOS
 * draws them (the Akkocloud figure) and as the system face measures them
 * (the rest, from the design spec's PIL pass over SFNS.ttf).
 */
const MEASURED: Record<string, number> = {
  "Akkocloud-UK-London-KVM": 187,
  "gomami-jpn-pulse-nano": 152,
  "Aaitr-jp-softbank-NAT": 149,
  "gomami-hk-turin-mini": 137,
  "gomami-jp-pulse-mini": 137,
  "LegendVPS-SG-EVO": 132,
};
const measured = (body: string) => MEASURED[body] ?? body.length * 8;

const fleet = [
  node({ id: "node_4ol55vwphys3rgdt", name: "[cd]-Akkocloud-UK-London-KVM" }),
  node({ id: "node_5cuasrdombv", name: "[cd]-gomami-jpn-pulse-nano" }),
  node({ id: "node_fdlsvreyz4un2elo", name: "[Metix]-Aaitr-jp-softbank-NAT" }),
  node({ id: "node_ykr7g35t3gzmgshc", name: "[OpenJobs-Data]-TiDB-1" }),
  node({ id: "legend", name: "[cd]-LegendVPS-SG-EVO" }),
  node({ id: "dmit-1", name: "[Metix]-DMIT-1" }),
];

test("the Node column is the longest measured name body plus the cell's fixed chrome", () => {
  // 12px row padding + 8px dot + 8px gap + 187px name + 12px cell padding
  // + 1px hairline: 228px on the live fleet, the number the spec records.
  assert.equal(NAME_CELL_CHROME_PX, 12 + 8 + 8 + 12 + 1);
  assert.equal(nameTrackMin(fleet, measured), 228);
  // The widest row governs, whichever it is.
  assert.equal(nameTrackMin(fleet, measured), Math.max(...fleet.map((n) => nameTrackMin([n], measured))));
  assert.ok(nameTrackMin([fleet[5]!], measured) < 228);
});

test("the owner prefix no longer widens the Node column", () => {
  // The same body behind [OpenJobs-Data] and bare measures the same: the
  // prefix has a column of its own now, and the names line up at one x.
  assert.equal(
    nameTrackMin([node({ id: "p", name: "[OpenJobs-Data]-gomami-jpn-pulse-nano" })], measured),
    nameTrackMin([node({ id: "b", name: "gomami-jpn-pulse-nano" })], measured),
  );
  // A fractional measurement rounds up, never down into the hairline.
  assert.equal(nameTrackMin([node({ id: "f", name: "frac" })], () => 200.2), 200 + NAME_CELL_CHROME_PX + 1);
});

test("without a measurer the per-character estimate stands in", () => {
  // 8.3px a character leaves a little over Chrome's 8.1px: the estimate is
  // never narrower than the measurement for the fleet's longest name.
  assert.ok(estimateNameWidth("Akkocloud-UK-London-KVM") >= 187);
  assert.equal(nameTrackMin(fleet), nameTrackMin(fleet, estimateNameWidth));
  assert.ok(nameTrackMin(fleet) >= nameTrackMin(fleet, measured));
  assert.ok(nameTrackMin(fleet) < 300, `${nameTrackMin(fleet)}px is more than the longest name needs`);
  // CJK glyphs are square: one em each, wider than a Latin character.
  assert.ok(estimateNameWidth("东京节点") > estimateNameWidth("tokyo"));
});

test("the name track stays inside its band", () => {
  assert.equal(nameTrackMin([]), NAME_TRACK_MIN_PX);
  assert.equal(nameTrackMin([node({ id: "a", name: "a" })]), NAME_TRACK_MIN_PX);
  assert.equal(nameTrackMin([node({ id: "x", name: "x".repeat(120) })]), NAME_TRACK_MAX_PX);
  assert.equal(nameTrackMin([node({ id: "x", name: "x" })], () => 10_000), NAME_TRACK_MAX_PX);
  // The id stands in for a missing name, as it does in the cell.
  assert.ok(nameTrackMin([node({ id: "node_" + "k".repeat(40), name: "" })]) > NAME_TRACK_MIN_PX);
});

test("the owner is a column of its own, right after Node, sortable, chip-sized", () => {
  const ids = NODE_TABLE_COLUMNS.map((c) => c.id);
  assert.equal(ids.indexOf("owner"), ids.indexOf("name") + 1);
  const owner = NODE_TABLE_COLUMNS.find((c) => c.id === "owner")!;
  assert.equal(owner.labelKey, "fleet.nodes.table.colOwner");
  // The widest live owner chip ("OpenJobs-Data") is 99px at the chip's 11px;
  // the track holds it and no more. A longer owner truncates inside the chip.
  assert.equal(owner.width, "104px");
  assert.ok(trackMinPx(owner.width) >= 99);
  assert.equal(owner.sortKey, "owner");
  // Visible until hidden, and the column manager can hide it.
  assert.equal(owner.optional, true);
  assert.ok(!owner.defaultHidden);
  assert.ok(visibleColumns(parseHiddenColumns(null)).some((c) => c.id === "owner"));
  assert.ok(!visibleColumns(parseHiddenColumns("owner")).some((c) => c.id === "owner"));
});

test("sortNodes by owner groups the prefixes and puts unowned nodes last either way", () => {
  const rows = [
    node({ id: "1", name: "[Metix]-DMIT-1" }),
    node({ id: "2", name: "bare" }),
    node({ id: "3", name: "[cd]-homeserver" }),
    node({ id: "4", name: "[OpenJobs-Data]-TiDB-1" }),
    node({ id: "5", name: "[cd]-Akkocloud-UK-London-KVM" }),
  ];
  const asc = sortNodes(rows, { key: "owner", dir: "asc" }).map((n) => n.id);
  assert.deepEqual(asc, ["5", "3", "1", "4", "2"]);
  const desc = sortNodes(rows, { key: "owner", dir: "desc" }).map((n) => n.id);
  assert.deepEqual(desc, ["4", "1", "5", "3", "2"]);
  // Ties within an owner fall through to name.
  assert.ok(asc.indexOf("5") < asc.indexOf("3"));
  assert.equal(nextSortState({ key: "", dir: "asc" }, "owner").key, "owner");
});

test("the hostname is a column of its own, in the catalog and the column manager", () => {
  const hostname = NODE_TABLE_COLUMNS.find((c) => c.id === "hostname");
  assert.ok(hostname, "hostname column missing from the catalog");
  assert.equal(hostname.labelKey, "fleet.nodes.table.colHostname");
  // Optional, so the column manager lists it. Out of the default set: its
  // 200px floor is what the card's width budget could not hold.
  assert.equal(hostname.optional, true);
  assert.equal(hostname.defaultHidden, true);
  assert.ok(!visibleColumns(parseHiddenColumns(null)).some((c) => c.id === "hostname"));
  assert.ok(visibleColumns(parseHiddenColumns("")).some((c) => c.id === "hostname"));
  assert.ok(!visibleColumns(parseHiddenColumns("hostname")).some((c) => c.id === "hostname"));
  assert.equal(serializeHiddenColumns(new Set(["hostname"])), "hostname");
});

test("past the track cap the name cell truncates rather than painting under the next column", () => {
  // The content-derived minimum is the mechanism; the cap is what stops one
  // absurd name from turning the table into a scroll. A name wider than the
  // cap then has nowhere to go, so the cell itself has to clip it.
  const absurd = node({ id: "x", name: "[prefix]-" + "x".repeat(120) });
  assert.equal(nameTrackMin([absurd]), NAME_TRACK_MAX_PX);
  const source = readFileSync(fileURLToPath(new URL("../../../components/common/NodeTable.vue", import.meta.url)), "utf8");
  const nameCell = /<p class="([^"]*)">\{\{ nameBody\(node\) \}\}<\/p>/.exec(source);
  assert.ok(nameCell, "the name <p> was not found in NodeTable.vue");
  const classes = nameCell[1]!.split(/\s+/);
  // Tailwind's `truncate` is overflow-hidden + text-ellipsis + nowrap.
  assert.ok(classes.includes("truncate"), `name cell classes: ${classes.join(" ")}`);
  assert.ok(!classes.includes("whitespace-normal"));
  // ...and the block it sits in must be allowed to shrink, or the clip never happens.
  assert.match(source, /<div class="min-w-0">\s*<p class="[^"]*truncate/);
});

test("one name minimum for the page, so grouped tables do not disagree on the column width", () => {
  // Grouped by region: one group holds the long-named node, the other does
  // not. Computed per group the two tables would render the name column at
  // different widths; the page's minimum is the widest group's.
  const london = [node({ id: "node_4ol55vwphys3rgdt", name: "[cd]-Akkocloud-UK-London-KVM" })];
  const tokyo = [node({ id: "dmit-1", name: "[Metix]-DMIT-1" }), node({ id: "b", name: "b" })];
  assert.notEqual(nameTrackMin(london, measured), nameTrackMin(tokyo, measured));
  const page = nameTrackMin([...london, ...tokyo], measured);
  assert.equal(page, Math.max(nameTrackMin(london, measured), nameTrackMin(tokyo, measured)));
  // Order of the groups does not matter.
  assert.equal(nameTrackMin([...tokyo, ...london], measured), page);
});

test("gridTemplate pins the Node track at the measured width, plus the checkbox when selectable", () => {
  const template = gridTemplate(DEFAULT_HIDDEN_COLUMNS, 228);
  assert.ok(template.startsWith("228px 104px "), template);
  assert.ok(gridTemplate(DEFAULT_HIDDEN_COLUMNS).startsWith(`${NAME_TRACK_MIN_PX}px `));
  // The selection checkbox lives inside the pinned cell, not in a track of
  // its own: 16px plus its 12px gap, 256px on the live fleet.
  assert.equal(SELECT_CELL_PX, 28);
  const selectable = gridTemplate(DEFAULT_HIDDEN_COLUMNS, 228, true);
  assert.ok(selectable.startsWith("256px 104px "), selectable);
  assert.equal(selectable.split(" ").length, template.split(" ").length);
  // The other tracks are untouched by it.
  assert.equal(template.split(" ").slice(1).join(" "), gridTemplate(DEFAULT_HIDDEN_COLUMNS).split(" ").slice(1).join(" "));
});

test("the pinned Node cell is one opaque block on the card surface with a hairline edge", () => {
  // The leak: two separately pinned cells with transparent padding and gap
  // between them, painted on a different surface than the header. One cell,
  // sticky at left 0, carrying the row's left padding, on --card, above the
  // scrolling cells, with the hairline inset on its right edge.
  const source = readFileSync(fileURLToPath(new URL("../../../components/common/NodeTable.vue", import.meta.url)), "utf8");
  const cell = /const STICKY_CELL =\s*([\s\S]*?);/.exec(source)![1]!;
  const header = /const STICKY_HEADER_CELL =\s*([\s\S]*?);/.exec(source)![1]!;
  for (const [name, classes] of [["cell", cell], ["header", header]] as const) {
    for (const required of ["sm:sticky", "sm:left-0", "h-full", "bg-card", "pl-3", "shadow-[inset_-1px_0_0_var(--border)]"]) {
      assert.ok(classes.includes(required), `${name} lacks ${required}`);
    }
    assert.ok(!classes.includes("bg-background"), `${name} paints a second surface`);
  }
  assert.ok(/\bz-10\b/.test(cell) && /\bz-20\b/.test(header), "header must stack above the cells");
  // Hover and selection tints are opaque mixes into the card, never into transparent.
  assert.ok(cell.includes("var(--foreground)_3%,var(--card)"));
  assert.ok(cell.includes("var(--primary)_8%,var(--card)"));
  // The row leaves its padding to the pinned cells, the left one and the
  // right one; a transparent strip at either edge is the leak.
  assert.doesNotMatch(source, /class="group\/row grid [^"]*\b(?:px-3|pl-3|pr-3)\b/);
  assert.doesNotMatch(source, /sm:left-15|sm:left-3/);
});

test("the Actions cell pins to the right edge on the same surface, hairline on its left, padding inside", () => {
  // The three row buttons were the last track of a table that scrolls, so
  // with the default set 261px wider than a 1440 card they sat off screen at
  // rest. The cell is the Node cell's mirror: sticky at right 0, the card
  // surface, the same tints, the hairline on the edge that faces the data,
  // and the row's right padding carried inside so nothing scrolls through a
  // strip beside the buttons.
  const source = readFileSync(fileURLToPath(new URL("../../../components/common/NodeTable.vue", import.meta.url)), "utf8");
  const cell = /const STICKY_ACTIONS_CELL =\s*([\s\S]*?);/.exec(source)![1]!;
  const header = /const STICKY_ACTIONS_HEADER_CELL =\s*([\s\S]*?);/.exec(source)![1]!;
  for (const [name, classes] of [["cell", cell], ["header", header]] as const) {
    for (const required of ["sm:sticky", "sm:right-0", "h-full", "bg-card", "pr-3", "justify-end", "shadow-[inset_1px_0_0_var(--border)]"]) {
      assert.ok(classes.includes(required), `${name} lacks ${required}`);
    }
    assert.ok(!classes.includes("bg-background"), `${name} paints a second surface`);
    // Opaque at rest: the reveal belongs to the buttons, not the pinned surface.
    assert.ok(!classes.includes("opacity-0"), `${name} fades with the buttons`);
  }
  assert.ok(/\bz-10\b/.test(cell) && /\bz-20\b/.test(header), "header must stack above the cells");
  assert.ok(cell.includes("var(--foreground)_3%,var(--card)"));
  assert.ok(cell.includes("var(--primary)_8%,var(--card)"));
  // The focus ring's top, bottom and right segments, and the hairline survives focus.
  const ring = /group-focus-visible\/row:shadow-\[([^\]]*)\]/.exec(cell);
  assert.ok(ring, `cell lacks a focus shadow: ${cell}`);
  const segments = ring[1]!.split(",");
  assert.equal(segments.filter((s) => s.includes("var(--ring)")).length, 3, ring[1]);
  assert.ok(segments.includes("inset_-2px_0_0_var(--ring)"), "the right segment is the cell's to draw");
  assert.equal(segments.at(-1), "inset_1px_0_0_var(--border)", "the hairline must survive focus");
  // The reveal is on a block inside the cell, and both cells are in the template.
  assert.match(source, /<div :class="STICKY_ACTIONS_CELL">\s*<div\s+class="[^"]*\bopacity-0\b[^"]*group-hover\/row:opacity-100/);
  assert.match(source, /:class="STICKY_ACTIONS_HEADER_CELL"/);
});

test("the default set fits a 1440 display with the sidebar collapsed, no horizontal scroll", () => {
  // The card's scroller at 1440 is 1276px with the sidebar collapsed and
  // 1100px with it open. The table scrolls when the sum of the visible track
  // floors and gaps passes the scroller, so that sum, at the live fleet's
  // measured Node width with the selection checkbox, is the budget. Before
  // this the default set came to 1537px and the row actions sat off screen.
  const nameMin = nameTrackMin(fleet, measured);
  const budget = tableMinWidthPx(DEFAULT_HIDDEN_COLUMNS, nameMin, true);
  assert.ok(budget <= 1276, `default set is ${budget}px, more than a 1276px scroller`);
  // With the sidebar open too, with room to spare for a wider name.
  assert.ok(budget <= 1100, `default set is ${budget}px, more than an 1100px scroller`);
  // name 256 + owner 104 + status 112 + tags 120 + publicIp 150 + agentConfig 150
  // + actions 116, six 12px gaps.
  assert.equal(budget, 256 + 104 + 112 + 120 + 150 + 150 + 116 + 6 * 12);
});

test("the row spans the card whatever is hidden: one data track is flexible, both pinned ones fixed", () => {
  // Both pinned tracks are px values: the Node one so it pins no more of the
  // viewport than the longest name needs, the Actions one so the pinned
  // surface is the buttons and not a stretch of empty card with a hairline
  // down its far side. Hide Tags and Hostname and nothing else is flexible,
  // so the template promotes the last data track before Actions; the spare
  // width lands there, the row spans the card, and the actions sit at its
  // edge instead of at the end of the tracks.
  const everything = parseHiddenColumns(
    NODE_TABLE_COLUMNS.filter((c) => c.optional)
      .map((c) => c.id)
      .join(","),
  );
  // A stored value is the operator's whole answer (see parseHiddenColumns),
  // so "the default set without Tags" is the default set plus "tags".
  const withoutTags = new Set([...DEFAULT_HIDDEN_COLUMNS, "tags"]);
  const sets = [
    DEFAULT_HIDDEN_COLUMNS,
    withoutTags,
    new Set([...DEFAULT_HIDDEN_COLUMNS, "tags", "agentConfig"]),
    parseHiddenColumns("hostname,tags,cpu,memory,disk,lastSeen"),
    everything,
  ];
  for (const hidden of sets) {
    const tracks = gridTemplate(hidden, 228, true).split(" ");
    assert.equal(tracks.at(-1), "116px", tracks.join(" "));
    assert.match(tracks[0]!, /^\d+px$/, "the pinned track must stay fixed");
    assert.equal(tracks.filter((t) => t.includes("1fr")).length >= 1, true, tracks.join(" "));
  }
  // The default set's flexible track is Tags, its own minmax; nothing is promoted.
  assert.deepEqual(gridTemplate(DEFAULT_HIDDEN_COLUMNS, 228, true).split(" "), [
    "256px", "104px", "112px", "minmax(120px,1fr)", "150px", "150px", "116px",
  ]);
  // Without Tags the last data track, Agent config, takes the spare width at its floor.
  assert.equal(gridTemplate(withoutTags, 228, true).split(" ").at(-2), "minmax(150px,1fr)");
  // Down to the required columns, Status is the one that stretches.
  assert.deepEqual(gridTemplate(everything, 228, true).split(" "), ["256px", "minmax(112px,1fr)", "116px"]);
  // The floor of every track is a px value the table's min-width can sum, so
  // the grid overflows its scroller exactly when the tracks do.
  assert.equal(trackMinPx("112px"), 112);
  assert.equal(trackMinPx("minmax(116px,1fr)"), 116);
  assert.equal(trackMinPx("minmax(200px, 1fr)"), 200);
  for (const column of NODE_TABLE_COLUMNS) {
    assert.ok(trackMinPx(column.width) > 0, `${column.id}: ${column.width} has no px floor`);
  }
  // name 256 (228 + checkbox) + status 112 + actions 116, two 12px gaps; the
  // row's padding is inside the pinned tracks, so nothing is added for it.
  assert.equal(tableMinWidthPx(everything, 228, true), 256 + 112 + 116 + 2 * 12);
  assert.equal(tableMinWidthPx(everything, 228, false), 228 + 112 + 116 + 2 * 12);
});

test("keyboard focus on a row is a ring the pinned cell carries too", () => {
  // The row's only focus mark was a 5% tint under outline-none, about 1.09:1
  // against the card, and the pinned cell painted its opaque surface over
  // even that for the leftmost 257px: the checkbox, dot, name and id. A
  // focus indicator needs 3:1, and the cell has to draw its share of it.
  const source = readFileSync(fileURLToPath(new URL("../../../components/common/NodeTable.vue", import.meta.url)), "utf8");
  const row = /class="group\/row grid ([^"]*)"/.exec(source)![1]!;
  // An inset ring: an outer one is clipped by the scroller on every side
  // the row touches, which is all four for a full-width row.
  for (const required of ["focus-visible:inset-ring-2", "focus-visible:inset-ring-ring"]) {
    assert.ok(row.split(/\s+/).includes(required), `row lacks ${required}: ${row}`);
  }
  const cell = /const STICKY_CELL =\s*([\s\S]*?);/.exec(source)![1]!;
  // The tint the row applies, opaque on the cell, and the ring's top, bottom
  // and left segments in --ring, with the hairline kept on the right edge.
  assert.ok(cell.includes("group-focus-visible/row:bg-[color-mix(in_oklab,var(--foreground)_5%,var(--card))]"), cell);
  const ring = /group-focus-visible\/row:shadow-\[([^\]]*)\]/.exec(cell);
  assert.ok(ring, `cell lacks a focus shadow: ${cell}`);
  const segments = ring[1]!.split(",");
  assert.equal(segments.filter((s) => s.includes("var(--ring)")).length, 3, ring[1]);
  assert.equal(segments.at(-1), "inset_-1px_0_0_var(--border)", "the hairline must survive focus");
});

test("sort-state persistence round-trips and rejects unknown keys", () => {
  assert.equal(serializeSortState({ key: "", dir: "asc" }), "");
  assert.deepEqual(parseSortState(null), { key: "", dir: "asc" });
  assert.deepEqual(parseSortState("cpu:desc"), { key: "cpu", dir: "desc" });
  assert.deepEqual(parseSortState(serializeSortState({ key: "name", dir: "desc" })), {
    key: "name",
    dir: "desc",
  });
  assert.deepEqual(parseSortState("bogus:desc"), { key: "", dir: "asc" });
});

test("sortNodes does not depend on the order the poll delivered tied rows in", () => {
  // Two machines can carry one name (the console ships a duplicate-node report
  // for exactly that), and then the primary key and the name tiebreak are both
  // equal. Without a tiebreak on the id, the rendered order is whatever order
  // the last poll happened to return, and the rows swap under the operator.
  const rows = [
    node({ id: "node-2", name: "edge-01", metrics: { cpu_percent: 4 } as Node["metrics"] }),
    node({ id: "node-1", name: "edge-01", metrics: { cpu_percent: 4 } as Node["metrics"] }),
    node({ id: "node-3", name: "edge-02", metrics: { cpu_percent: 4 } as Node["metrics"] }),
  ];
  const asDelivered = sortNodes(rows, { key: "cpu", dir: "desc" }).map((n) => n.id);
  const reshuffled = sortNodes([...rows].reverse(), { key: "cpu", dir: "desc" }).map((n) => n.id);
  assert.deepEqual(asDelivered, reshuffled);
  assert.deepEqual(asDelivered, ["node-1", "node-2", "node-3"]);
});

test("sortNodes ranks metrics at the precision the cell prints", () => {
  const poll = (alpha: number, bravo: number) => [
    node({ id: "node-a", name: "alpha", metrics: { cpu_percent: alpha } as Node["metrics"] }),
    node({ id: "node-b", name: "bravo", metrics: { cpu_percent: bravo } as Node["metrics"] }),
  ];
  // Both rows print "8%" whichever way the jitter lands between two polls, so
  // neither may move: this is the churn the fleet list actually showed.
  const first = sortNodes(poll(7.92, 7.51), { key: "cpu", dir: "desc" }).map((n) => n.id);
  const second = sortNodes(poll(7.51, 7.92), { key: "cpu", dir: "desc" }).map((n) => n.id);
  assert.deepEqual(first, second);
  assert.deepEqual(first, ["node-a", "node-b"]);
  // A change the operator can see still reorders: 7.4 prints "7%", 8.6 prints "9%".
  assert.deepEqual(
    sortNodes(poll(7.4, 8.6), { key: "cpu", dir: "desc" }).map((n) => n.id),
    ["node-b", "node-a"],
  );
  // Same for the used/total columns: 63.4% and 63.2% both print "63%", so the
  // pair falls through to the name tiebreak instead of trading places.
  const mem = (used: number) =>
    node({
      id: `mem-${used}`,
      name: `mem-${used}`,
      metrics: { memory_used: used, memory_total: 1000 } as Node["metrics"],
    });
  assert.deepEqual(
    sortNodes([mem(634), mem(632)], { key: "memory", dir: "desc" }).map((n) => n.id),
    ["mem-632", "mem-634"],
  );
});
