import assert from "node:assert/strict";
import test from "node:test";

import {
  GO_KEYS,
  keyTargetOf,
  nextRowIndex,
  shortcutFor,
  steppedRowIndex,
  type ShortcutContext,
} from "../keyboardShortcutsModel.ts";

const page: ShortcutContext = { target: "other", sheetOpen: false, sheetModal: false, overlayOpen: false, goPending: false };

test("on a page: / searches, g waits for a page key, ? lists the keys", () => {
  assert.deepEqual(shortcutFor({ key: "/" }, page), { kind: "focus-search" });
  assert.deepEqual(shortcutFor({ key: "g" }, page), { kind: "go-pending" });
  assert.deepEqual(shortcutFor({ key: "?" }, page), { kind: "help" });
  assert.equal(shortcutFor({ key: "x" }, page), null);
  assert.equal(shortcutFor({ key: "[" }, page), null, "no sheet, no stepping");
});

test("g then a key goes to that page; anything else cancels", () => {
  const pending = { ...page, goPending: true };
  assert.deepEqual(shortcutFor({ key: "n" }, pending), { kind: "go", page: "nodes" });
  assert.deepEqual(shortcutFor({ key: "A" }, pending), { kind: "go", page: "approvals" });
  assert.deepEqual(shortcutFor({ key: "v" }, pending), { kind: "go", page: GO_KEYS.v });
  assert.equal(shortcutFor({ key: "z" }, pending), null);
  assert.equal(shortcutFor({ key: "/" }, pending), null);
});

test("nothing fires while typing, in Terminal, with a modifier, or under another dialog or menu", () => {
  assert.equal(shortcutFor({ key: "/" }, { ...page, target: "editable" }), null);
  assert.equal(shortcutFor({ key: "g" }, { ...page, target: "terminal" }), null);
  assert.equal(shortcutFor({ key: "/", ctrlKey: true }, page), null);
  assert.equal(shortcutFor({ key: "g", metaKey: true }, page), null);
  assert.equal(shortcutFor({ key: "?", altKey: true }, page), null);
  assert.equal(shortcutFor({ key: "/" }, { ...page, overlayOpen: true }), null);
  assert.equal(shortcutFor({ key: "]" }, { ...page, sheetOpen: true, overlayOpen: true }), null);
  assert.equal(shortcutFor({ key: "/", repeat: true }, page), null, "a held key fires once");
});

test("an open sheet steps with [ and ], held keys included; a modal sheet keeps the page keys off", () => {
  const beside = { ...page, sheetOpen: true };
  assert.deepEqual(shortcutFor({ key: "]" }, beside), { kind: "step-sheet", direction: 1 });
  assert.deepEqual(shortcutFor({ key: "[", repeat: true }, beside), { kind: "step-sheet", direction: -1 });
  assert.deepEqual(shortcutFor({ key: "/" }, beside), { kind: "focus-search" }, "beside the list the search is in reach");
  const modal = { ...page, sheetOpen: true, sheetModal: true };
  assert.deepEqual(shortcutFor({ key: "]" }, modal), { kind: "step-sheet", direction: 1 });
  assert.equal(shortcutFor({ key: "/" }, modal), null);
  assert.equal(shortcutFor({ key: "g" }, modal), null);
  assert.equal(shortcutFor({ key: "n" }, { ...modal, goPending: true }), null);
});

test("row keys move one row, stop at the ends, and jump with Home and End", () => {
  assert.equal(nextRowIndex(5, 0, "j"), 1);
  assert.equal(nextRowIndex(5, 0, "ArrowDown"), 1);
  assert.equal(nextRowIndex(5, 4, "j"), 4, "no wrap at the end");
  assert.equal(nextRowIndex(5, 2, "k"), 1);
  assert.equal(nextRowIndex(5, 0, "ArrowUp"), 0, "no wrap at the top");
  assert.equal(nextRowIndex(5, 3, "Home"), 0);
  assert.equal(nextRowIndex(5, 1, "End"), 4);
  assert.equal(nextRowIndex(5, 1, "Enter"), -1);
  assert.equal(nextRowIndex(0, 0, "j"), -1);
  assert.equal(nextRowIndex(5, -1, "j"), 0);
});

test("the sheet steps to its neighbour row and stops at either end", () => {
  assert.equal(steppedRowIndex(5, 2, 1), 3);
  assert.equal(steppedRowIndex(5, 2, -1), 1);
  assert.equal(steppedRowIndex(5, 4, 1), -1);
  assert.equal(steppedRowIndex(5, 0, -1), -1);
  assert.equal(steppedRowIndex(5, -1, 1), -1, "no open row");
});

test("keys land on the shell's input, a field, or anything else", () => {
  const el = (tagName: string, opts: { xterm?: boolean; editable?: boolean } = {}) =>
    ({
      tagName,
      isContentEditable: !!opts.editable,
      classList: { contains: (name: string) => !!opts.xterm && name === "xterm-helper-textarea" },
      closest: () => null,
    }) as unknown as Element;
  assert.equal(keyTargetOf(el("TEXTAREA", { xterm: true })), "terminal");
  assert.equal(keyTargetOf(el("INPUT")), "editable");
  assert.equal(keyTargetOf(el("SELECT")), "editable");
  assert.equal(keyTargetOf(el("DIV", { editable: true })), "editable");
  assert.equal(keyTargetOf(el("TR")), "other");
  assert.equal(keyTargetOf(null), "other");
});
