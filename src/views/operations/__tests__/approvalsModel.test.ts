import assert from "node:assert/strict";
import test from "node:test";

import {
  EVENT_NODE_PREVIEW_LIMIT,
  SYSTEM_WRITER,
  UNKNOWN_WRITER,
  approvalActionPrefix,
  approvalEventTitle,
  approvalWriter,
  groupApprovalsIntoEvents,
  groupNodePreview,
  humanizeActionPrefix,
  isApprovalEventGroupable,
  parseAgentUpdatePlan,
  partitionBatchResults,
  runWithConcurrency,
  type ApprovalEventItem,
} from "../approvalsModel.ts";

let nextId = 0;

function makeItem(overrides: Partial<ApprovalEventItem> = {}): ApprovalEventItem {
  nextId += 1;
  return {
    id: `appr-${nextId}`,
    node_id: `node-${nextId}`,
    plugin: "agentupdate",
    action: "update-agent",
    plan: "",
    status: "pending",
    actor_id: SYSTEM_WRITER,
    created_at: "2026-08-06T10:00:00Z",
    ...overrides,
  };
}

function agentUpdatePlan(current: string, target: string, nodeName = "edge-1"): string {
  return [
    "# lattice agent update plan",
    `node_name: ${nodeName}`,
    `current_version: ${current}`,
    `target_version: ${target}`,
    "artifact_url: https://dl.example.invalid/agent",
  ].join("\n");
}

test("actionable statuses are pending and approved-not-applied only", () => {
  for (const status of ["pending", "approved"]) {
    assert.equal(isApprovalEventGroupable(makeItem({ status })), true, status);
  }
  for (const status of ["applied", "rejected", "dismissed", "failed"]) {
    assert.equal(isApprovalEventGroupable(makeItem({ status })), false, status);
  }
});

test("items group by writer + plugin + action prefix", () => {
  const items = [
    makeItem({ actor_id: "lattice-server", plugin: "selfdns", action: "apply-zone:a" }),
    makeItem({ actor_id: "lattice-server", plugin: "selfdns", action: "apply-zone:b" }),
    makeItem({ actor_id: "operator-7", plugin: "selfdns", action: "apply-zone:a" }),
    makeItem({ actor_id: "lattice-server", plugin: "nftpolicy", action: "apply-zone:a" }),
  ];

  const groups = groupApprovalsIntoEvents(items);

  assert.equal(groups.length, 3);
  const sizes = groups.map((group) => group.items.length).sort();
  assert.deepEqual(sizes, [1, 1, 2]);
  const pair = groups.find((group) => group.items.length === 2);
  assert.equal(pair?.writer, "lattice-server");
  assert.equal(pair?.actionPrefix, "apply-zone");
});

test("agentupdate items group by the version transition parsed from plan text", () => {
  const upgrade = agentUpdatePlan("0.3.0", "0.3.3");
  const items = [
    makeItem({ plan: agentUpdatePlan("0.3.0", "0.3.3", "edge-1") }),
    makeItem({ plan: agentUpdatePlan("0.3.0", "0.3.3", "edge-2") }),
    makeItem({ plan: agentUpdatePlan("0.3.3-alpha.2", "0.3.3", "edge-3") }),
  ];

  const groups = groupApprovalsIntoEvents(items);

  assert.equal(groups.length, 2);
  const main = groups.find((group) => group.items.length === 2);
  assert.deepEqual(main?.transition, { current: "0.3.0", target: "0.3.3" });
  const alpha = groups.find((group) => group.items.length === 1);
  assert.deepEqual(alpha?.transition, { current: "0.3.3-alpha.2", target: "0.3.3" });
  assert.notEqual(main?.key, alpha?.key);
  assert.ok(upgrade.includes("current_version"));
});

test("parseAgentUpdatePlan reads versions and node name from YAML-ish text and tolerates quotes", () => {
  const parsed = parseAgentUpdatePlan('node_name: "edge 9"\ncurrent_version: 0.3.0\ntarget_version: 0.3.3\n');
  assert.deepEqual(parsed.transition, { current: "0.3.0", target: "0.3.3" });
  assert.equal(parsed.nodeName, "edge 9");

  const partial = parseAgentUpdatePlan("target_version: 0.3.3\nunrelated: line");
  assert.equal(partial.transition, undefined);
  assert.equal(partial.nodeName, undefined);
});

test("singbox-linemeta apply-metadata:<sha256> items collapse into one event", () => {
  const items = Array.from({ length: 24 }, (_, i) =>
    makeItem({
      plugin: "singbox-linemeta",
      action: `apply-metadata:${"abcdef0123456789".repeat(4)}${String(i).padStart(2, "0")}`.slice(0, 64),
      plan: JSON.stringify({ lines: i + 1 }),
    }),
  );

  const groups = groupApprovalsIntoEvents(items);

  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.items.length, 24);
  assert.equal(groups[0]?.actionPrefix, "apply-metadata");
  assert.equal(groups[0]?.titleKind, "linemeta-sync");
  assert.equal(groups[0]?.title, "Line metadata sync");
  assert.equal(groups[0]?.isSystem, true);
});

test("the production batch shapes into exactly the events an operator expects", () => {
  const agentItems = [
    ...Array.from({ length: 20 }, (_, i) => makeItem({ plan: agentUpdatePlan("0.3.0", "0.3.3", `edge-${i}`) })),
    makeItem({ plan: agentUpdatePlan("0.3.3-alpha.2", "0.3.3", "edge-99") }),
  ];
  const linemetaItems = Array.from({ length: 24 }, (_, i) =>
    makeItem({ plugin: "singbox-linemeta", action: `apply-metadata:${String(i).padStart(64, "0")}`, plan: "{}" }),
  );

  const groups = groupApprovalsIntoEvents([...agentItems, ...linemetaItems]);

  assert.equal(groups.length, 3);
  const titles = groups.map((group) => `${group.title} (${group.items.length})`).sort();
  assert.deepEqual(titles, [
    "Fleet upgrade 0.3.0 → 0.3.3 (20)",
    "Fleet upgrade 0.3.3-alpha.2 → 0.3.3 (1)",
    "Line metadata sync (24)",
  ]);
});

test("empty, missing, or whitespace writers collapse into one unknown-writer event", () => {
  const items = [
    makeItem({ actor_id: "" }),
    makeItem({ actor_id: "   " }),
    makeItem({ actor_id: undefined }),
  ];

  const groups = groupApprovalsIntoEvents(items);

  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.writer, UNKNOWN_WRITER);
  assert.equal(groups[0]?.isSystem, false);
  assert.equal(groups[0]?.items.length, 3);
  assert.equal(approvalWriter(makeItem({ actor_id: "  ops-bot " })), "ops-bot");
});

test("humanized titles cover known events and fall back to a title-cased prefix", () => {
  assert.deepEqual(approvalEventTitle("agentupdate", "update-agent", { current: "0.3.0", target: "0.3.3" }), {
    titleKind: "fleet-upgrade",
    title: "Fleet upgrade 0.3.0 → 0.3.3",
  });
  assert.deepEqual(approvalEventTitle("agentupdate", "update-agent", undefined), {
    titleKind: "fleet-upgrade",
    title: "Fleet upgrade",
  });
  assert.deepEqual(approvalEventTitle("singbox-linemeta", "apply-metadata", undefined), {
    titleKind: "linemeta-sync",
    title: "Line metadata sync",
  });
  assert.deepEqual(approvalEventTitle("selfdns", "apply-zone", undefined), {
    titleKind: "generic",
    title: "Apply Zone",
  });
  assert.equal(humanizeActionPrefix("apply-metadata"), "Apply Metadata");
  assert.equal(approvalActionPrefix("apply-metadata:deadbeef"), "apply-metadata");
  assert.equal(approvalActionPrefix("update-agent"), "update-agent");
});

test("groups sort newest first; node preview dedupes and counts the remainder", () => {
  const older = makeItem({ created_at: "2026-08-06T09:00:00Z", plugin: "selfdns", action: "apply-zone" });
  const newerGroupItems = Array.from({ length: 8 }, (_, i) =>
    makeItem({
      created_at: "2026-08-06T11:00:00Z",
      plugin: "nftpolicy",
      action: "sync-rules",
      node_id: `node-${String(i).padStart(2, "0")}`,
    }),
  );
  // Same node re-planned twice. The preview must show it once.
  newerGroupItems.push(makeItem({ created_at: "2026-08-06T11:00:00Z", plugin: "nftpolicy", action: "sync-rules", node_id: "node-00" }));

  const groups = groupApprovalsIntoEvents([older, ...newerGroupItems]);

  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.plugin, "nftpolicy", "newest event first");
  assert.equal(groups[0]?.newestCreatedAt, "2026-08-06T11:00:00Z");

  const preview = groupNodePreview(groups[0]!);
  assert.equal(preview.nodes.length, EVENT_NODE_PREVIEW_LIMIT);
  assert.equal(preview.extra, 2, "8 distinct nodes minus 6 previewed");
  assert.deepEqual(preview.nodes, ["node-00", "node-01", "node-02", "node-03", "node-04", "node-05"]);
});

test("partitionBatchResults splits fulfilled items from rejected ones with messages", () => {
  const items = [makeItem(), makeItem(), makeItem(), makeItem()];
  const results: PromiseSettledResult<unknown>[] = [
    { status: "fulfilled", value: undefined },
    { status: "rejected", reason: new Error("plan is stale") },
    { status: "fulfilled", value: undefined },
    { status: "rejected", reason: "409 conflict" },
  ];

  const { succeeded, failed } = partitionBatchResults(items, results);

  assert.deepEqual(succeeded.map((item) => item.id), [items[0]?.id, items[2]?.id]);
  assert.equal(failed.length, 2);
  assert.equal(failed[0]?.item.id, items[1]?.id);
  assert.equal(failed[0]?.error, "plan is stale");
  assert.equal(failed[1]?.error, "409 conflict");
});

test("runWithConcurrency preserves order, caps in-flight work, and reports progress", async () => {
  const items = Array.from({ length: 10 }, (_, i) => i);
  let inFlight = 0;
  let maxInFlight = 0;
  const progress: Array<[number, number]> = [];

  const results = await runWithConcurrency(
    items,
    4,
    async (value) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, value % 3));
      inFlight -= 1;
      if (value === 5) throw new Error("boom");
      return value * 2;
    },
    (done, total) => progress.push([done, total]),
  );

  assert.ok(maxInFlight <= 4, `never more than 4 in flight (saw ${maxInFlight})`);
  assert.equal(results.length, 10);
  for (let i = 0; i < 10; i += 1) {
    const result = results[i];
    if (i === 5) {
      assert.equal(result?.status, "rejected");
    } else {
      assert.equal(result?.status, "fulfilled");
      assert.equal(result?.status === "fulfilled" ? result.value : undefined, i * 2, "order preserved");
    }
  }
  assert.equal(progress.length, 10);
  assert.deepEqual(progress[progress.length - 1], [10, 10]);
});
