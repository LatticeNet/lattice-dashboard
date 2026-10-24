import assert from "node:assert/strict";
import { test } from "node:test";

import { renameNoteKey, takeRenameNote, type NoteStorage } from "../renameNoteModel.ts";

function memory(): NoteStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

test("the first visit after a rename shows the note, and the next one does not", () => {
  const storage = memory();
  assert.equal(takeRenameNote(storage, "usr_1", "outboundPolicy"), true);
  assert.equal(takeRenameNote(storage, "usr_1", "outboundPolicy"), false);
});

test("the note is remembered per viewer and per page", () => {
  const storage = memory();
  takeRenameNote(storage, "usr_1", "outboundPolicy");
  assert.equal(takeRenameNote(storage, "usr_2", "outboundPolicy"), true, "another operator still sees it");
  assert.equal(takeRenameNote(storage, "usr_1", "nodeGroups"), true, "another page still shows its own");
  assert.notEqual(renameNoteKey("usr_1", "nodeGroups"), renameNoteKey("usr_2", "nodeGroups"));
});

test("storage that is missing or throws shows nothing rather than nagging every visit", () => {
  assert.equal(takeRenameNote(null, "usr_1", "outboundPolicy"), false);
  const broken: NoteStorage = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {},
  };
  assert.equal(takeRenameNote(broken, "usr_1", "outboundPolicy"), false);
});
