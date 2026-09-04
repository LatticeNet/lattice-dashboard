import assert from "node:assert/strict";
import test from "node:test";

import {
  BARK_LEVELS,
  buildConfig,
  channelSaveGate,
  configComplete,
  droppedStoredKeys,
  fromSelectValue,
  KIND_FIELDS,
  SELECT_DEFAULT,
  toSelectValue,
} from "../notificationsModel.ts";

const bark = KIND_FIELDS.bark;
const field = (key: string) => bark.find((f) => f.key === key);

/**
 * The server keeps base_url and key mandatory and treats level, group and url
 * as optional with defaults applied at send time. The form has to match that
 * split exactly: a required optional field would block every channel saved
 * before the fields existed, and an optional secret would let a channel save
 * with nowhere to deliver to.
 */
test("bark keeps base_url and key required and adds level, group and url as optional", () => {
  assert.deepEqual(
    bark.map((f) => [f.key, f.required]),
    [["base_url", true], ["key", true], ["level", false], ["group", false], ["url", false]],
  );
});

/**
 * bark-server answers 400 to any other level, and the console's server does the
 * same before storing the channel. The select must offer exactly that set, so
 * an operator cannot pick a value the save will refuse.
 */
test("the level select offers exactly the levels bark-server accepts", () => {
  assert.deepEqual([...BARK_LEVELS], ["active", "timeSensitive", "passive", "critical"]);
  assert.deepEqual(field("level")?.options, BARK_LEVELS);
  for (const key of ["group", "url", "base_url", "key"]) {
    assert.equal(field(key)?.options, undefined, `${key} is free text`);
  }
});

test("optional bark fields never block the save or the test send", () => {
  assert.equal(configComplete(bark, { base_url: "https://api.day.app", key: "k" }), true);
  assert.equal(configComplete(bark, { base_url: "https://api.day.app", key: "k", level: "", group: "", url: "" }), true);
  assert.equal(configComplete(bark, { base_url: "https://api.day.app", key: " " }), false);
  assert.equal(configComplete(bark, { key: "k", level: "critical" }), false);
});

/**
 * A channel saved before the fields existed opens with every field blank. Saving
 * it again has to send the same two keys it had, so the server sees no change
 * and applies its own defaults, rather than three empty strings that would fail
 * level validation or pin the group to "".
 */
test("a channel without the new fields saves with the same config keys it had", () => {
  const sent = buildConfig(bark, { base_url: "https://api.day.app", key: "k", level: "", group: "", url: "" });
  assert.deepEqual(sent, { base_url: "https://api.day.app", key: "k" });
  assert.deepEqual(Object.keys(sent), ["base_url", "key"]);
});

test("set optional fields are sent as given, trimmed, with long group text intact", () => {
  const group = "fleet / oncall / weekend rotation (2026-09, europe-west, backup pager)";
  const sent = buildConfig(bark, {
    base_url: " https://api.day.app ",
    key: "k",
    level: "timeSensitive",
    group: ` ${group} `,
    url: "https://lattice.example/alerts",
  });
  assert.deepEqual(sent, {
    base_url: "https://api.day.app",
    key: "k",
    level: "timeSensitive",
    group,
    url: "https://lattice.example/alerts",
  });
});

/** Every field that carries a hint or a select placeholder points at an i18n key, not literal copy. */
test("bark field copy is keyed, so both locales carry it", () => {
  for (const f of bark) {
    assert.match(f.label, /^platform\.notifications\./);
    if (f.hint) assert.match(f.hint, /^platform\.notifications\./);
    if (f.options) assert.match(f.placeholder, /^platform\.notifications\./);
  }
});

/**
 * reka-ui throws at render on a SelectItem whose value is "", and the throw
 * unmounts the whole option list, so the level select opened to nothing. The
 * blank entry therefore carries a sentinel that is not a level, and the two
 * boundary functions keep "" as the only blank the config ever sees.
 */
test("the blank level entry carries a sentinel the config never sees", () => {
  assert.notEqual(SELECT_DEFAULT, "");
  assert.equal(BARK_LEVELS.includes(SELECT_DEFAULT as (typeof BARK_LEVELS)[number]), false);
  assert.equal(toSelectValue(""), SELECT_DEFAULT);
  assert.equal(toSelectValue("critical"), "critical");
  assert.equal(fromSelectValue(SELECT_DEFAULT), "");
  assert.equal(fromSelectValue("passive"), "passive");
  assert.deepEqual(buildConfig(bark, { base_url: "b", key: "k", level: fromSelectValue(SELECT_DEFAULT) }), { base_url: "b", key: "k" });
});

/**
 * GET returns config_keys and never a value, and the server replaces the whole
 * config on save. Opening a channel saved with level, group and url just to
 * rename it, and saving with those blank, therefore drops all three: the next
 * incident page arrives as a plain, silence-able notification. The gate turns
 * that silent revert into a listed, acknowledged clear.
 */
const ONCALL_KEYS = ["base_url", "group", "key", "level", "url"];
const RETYPED_SECRETS = { base_url: "https://bark.lattice.example", key: "k", level: "", group: "", url: "" };

test("an untouched edit of a channel with stored optional fields is blocked until the clear is acknowledged", () => {
  const gate = channelSaveGate({ fields: bark, storedKeys: ONCALL_KEYS, config: RETYPED_SECRETS, kindChanged: false, clearAcknowledged: false });
  assert.deepEqual(gate.dropped, ["group", "level", "url"]);
  assert.equal(gate.blocked, true);
  const acknowledged = channelSaveGate({ fields: bark, storedKeys: ONCALL_KEYS, config: RETYPED_SECRETS, kindChanged: false, clearAcknowledged: true });
  assert.deepEqual(acknowledged.dropped, ["group", "level", "url"]);
  assert.equal(acknowledged.blocked, false);
});

test("re-entering every stored optional field lifts the gate, partially re-entering lists the rest", () => {
  const full = channelSaveGate({
    fields: bark,
    storedKeys: ONCALL_KEYS,
    config: { ...RETYPED_SECRETS, level: "critical", group: "oncall", url: "https://lattice.example/alerts" },
    kindChanged: false,
    clearAcknowledged: false,
  });
  assert.deepEqual(full, { dropped: [], blocked: false });
  const partial = channelSaveGate({
    fields: bark,
    storedKeys: ONCALL_KEYS,
    config: { ...RETYPED_SECRETS, level: "critical" },
    kindChanged: false,
    clearAcknowledged: false,
  });
  assert.deepEqual(partial.dropped, ["group", "url"]);
  assert.equal(partial.blocked, true);
});

/**
 * Required keys left blank are the server's 400 and the edit hint's subject, not
 * this gate's: a channel saved before the fields existed opens with everything
 * blank and must stay saveable exactly as before.
 */
test("a channel saved without the optional fields is not gated, and blank required keys are left to the server", () => {
  const legacy = channelSaveGate({ fields: bark, storedKeys: ["base_url", "key"], config: { base_url: "", key: "", level: "", group: "", url: "" }, kindChanged: false, clearAcknowledged: false });
  assert.deepEqual(legacy, { dropped: [], blocked: false });
  assert.deepEqual(droppedStoredKeys(bark, ["base_url", "key"], {}), []);
});

test("a kind change hands the stored config to the kind-changed hint instead of the gate", () => {
  const gate = channelSaveGate({ fields: KIND_FIELDS.telegram, storedKeys: ONCALL_KEYS, config: {}, kindChanged: true, clearAcknowledged: false });
  assert.deepEqual(gate, { dropped: [], blocked: false });
});

/** A key the form has no input for (set through the API) is replaced away just the same, so it is listed too. */
test("stored keys the form cannot re-enter are listed as dropped", () => {
  assert.deepEqual(droppedStoredKeys(bark, ["base_url", "key", "sound"], { base_url: "b", key: "k" }), ["sound"]);
});
