import assert from "node:assert/strict";
import { test } from "node:test";

import { attentionCount, attentionView, sortAttention, type AttentionItem } from "../attentionModel.ts";

function item(key: string, tone: AttentionItem["tone"]): AttentionItem {
  return { key, tone, claim: key };
}

test("danger comes first, then warning, then information, keeping the page's order inside a tone", () => {
  const items = [item("w1", "warning"), item("i1", "info"), item("d1", "danger"), item("w2", "warning"), item("d2", "danger")];
  assert.deepEqual(
    sortAttention(items).map((entry) => entry.key),
    ["d1", "d2", "w1", "w2", "i1"],
  );
});

test("information items are listed but never counted", () => {
  const items = [item("d", "danger"), item("w", "warning"), item("i1", "info"), item("i2", "info")];
  assert.equal(attentionCount(items), 2);
  assert.equal(attentionCount([item("i", "info")]), 0);
  assert.equal(attentionCount([]), 0);
});

test("beyond the maximum the rest fold behind Show all", () => {
  const items = Array.from({ length: 9 }, (_, i) => item(`w${i}`, "warning"));
  const view = attentionView(items, 5);
  assert.equal(view.shown.length, 5);
  assert.equal(view.hidden, 4);
  assert.equal(view.total, 9);
  const open = attentionView(items, 5, true);
  assert.equal(open.shown.length, 9);
  assert.equal(open.hidden, 0);
});

test("a fold that would hide one row shows it instead", () => {
  const items = Array.from({ length: 6 }, (_, i) => item(`w${i}`, "warning"));
  assert.equal(attentionView(items, 5).hidden, 0);
  assert.equal(attentionView(items, 5).shown.length, 6);
});

test("an empty list renders nothing and the default maximum is five", () => {
  assert.deepEqual(attentionView([]), { shown: [], hidden: 0, total: 0 });
  const items = Array.from({ length: 8 }, (_, i) => item(`d${i}`, "danger"));
  assert.equal(attentionView(items).shown.length, 5);
});
