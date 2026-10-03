import assert from "node:assert/strict";
import test from "node:test";

import {
  BARK_LEVELS,
  buildConfig,
  channelDeleteImpact,
  channelHealthLine,
  failingChannels,
  failureCause,
  fallbackChoices,
  fallbackForSave,
  channelSaveGate,
  configComplete,
  droppedStoredKeys,
  fromSelectValue,
  KIND_FIELDS,
  SELECT_DEFAULT,
  ruleIncidentDraft,
  ruleIncidentErrors,
  ruleIncidentRequest,
  ruleIncidentSummary,
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

// ── channel delete impact ────────────────────────────────────────────────────

const barkInfo = { id: "ch_bark_info", name: "Bark info", enabled: true };
const barkUrgent = { id: "ch_bark_urgent", name: "Bark urgent", enabled: true };
const telegram = { id: "ch_tg", name: "Telegram ops", enabled: true };
const rule = (id: string, name: string, channel_ids: string[], event_types: string[] = ["node.offline"], enabled = true) => ({ id, name, channel_ids, event_types, enabled });

test("a rule whose only channel is deleted stops reaching anyone, is named with its events, and needs the typed name", () => {
  const impact = channelDeleteImpact(barkUrgent, [rule("r1", "Node offline", ["ch_bark_urgent"])], [barkInfo, barkUrgent]);
  assert.deepEqual(impact.lines, [{ kind: "silenced", rule: "Node offline", events: "node.offline" }]);
  assert.equal(impact.typed, true);
});

test("a rule that keeps another enabled channel is named with it and does not need the typed name", () => {
  const impact = channelDeleteImpact(barkInfo, [rule("r1", "Backups", ["ch_bark_info", "ch_tg"], ["backup.finished"])], [barkInfo, telegram]);
  assert.deepEqual(impact.lines, [{ kind: "kept", rule: "Backups", others: ["Telegram ops"] }]);
  assert.equal(impact.typed, false);
});

test("a disabled or deleted other channel does not keep a rule alive", () => {
  const impact = channelDeleteImpact(
    barkInfo,
    [rule("r1", "Backups", ["ch_bark_info", "ch_tg", "ch_gone"], ["backup.finished"])],
    [barkInfo, { ...telegram, enabled: false }],
  );
  assert.equal(impact.lines[0]?.kind, "silenced");
  assert.equal(impact.typed, true);
});

test("silenced rules come before kept ones, and a disabled rule is not counted", () => {
  const impact = channelDeleteImpact(
    barkInfo,
    [
      rule("r2", "VPN quota", ["ch_bark_info", "ch_tg"], ["proxy.quota"]),
      rule("r1", "Machine renewals", ["ch_bark_info"], ["inventory.renewal"]),
      rule("r3", "Old rule", ["ch_bark_info"], ["*"], false),
    ],
    [barkInfo, telegram],
  );
  assert.deepEqual(impact.lines.map((line) => line.kind), ["silenced", "kept"]);
  assert.equal(impact.typed, true);
});

test("a rule with no event types is named as matching every event", () => {
  const impact = channelDeleteImpact(barkInfo, [rule("r1", "Everything", ["ch_bark_info"], [])], [barkInfo]);
  assert.deepEqual(impact.lines, [{ kind: "silenced", rule: "Everything", events: "*" }]);
});

test("unread rules never claim nothing stops, and ask for the typed name", () => {
  const impact = channelDeleteImpact(barkInfo, undefined, [barkInfo]);
  assert.deepEqual(impact.lines, [{ kind: "rulesUnread" }]);
  assert.equal(impact.typed, true);
});

test("with no enabled rule every enabled channel gets everything, so the channel just stops receiving", () => {
  assert.deepEqual(channelDeleteImpact(barkInfo, [rule("r1", "Off", ["ch_tg"], ["*"], false)], [barkInfo, telegram]).lines, [{ kind: "noRules" }]);
  assert.deepEqual(channelDeleteImpact({ ...barkInfo, enabled: false }, [], [barkInfo]).lines, []);
});

test("a channel no enabled rule routes to receives nothing today", () => {
  const impact = channelDeleteImpact(barkInfo, [rule("r1", "Node offline", ["ch_bark_urgent"])], [barkInfo, barkUrgent]);
  assert.deepEqual(impact.lines, [{ kind: "unrouted" }]);
  assert.equal(impact.typed, false);
});

// ── channel health and fallback ─────────────────────────────────────────────

test("each failure kind gets its own words, and a refusal keeps its status", () => {
  assert.deepEqual(failureCause("upstream_4xx", 400), { key: "refused", status: 400 });
  assert.deepEqual(failureCause("upstream_5xx", 502), { key: "serverError", status: 502 });
  assert.deepEqual(failureCause("rate_limited"), { key: "rateLimited", status: 429 });
  assert.deepEqual(failureCause("timeout"), { key: "timeout" });
  assert.deepEqual(failureCause("network"), { key: "unreachable" });
  assert.deepEqual(failureCause("config_invalid"), { key: "configRefused" });
  assert.deepEqual(failureCause("something_new"), { key: "failed" });
});

test("health reads the server's state and dates the claim from the right instant", () => {
  assert.deepEqual(channelHealthLine(undefined), { state: "unreported", tone: "muted", failures: 0 });
  assert.equal(channelHealthLine({ state: "unknown", consecutive_failures: 0 }).state, "unknown");
  assert.deepEqual(channelHealthLine({ state: "ok", consecutive_failures: 0, last_ok_at: "t-ok", last_attempt_at: "t-ok" }), {
    state: "ok",
    tone: "muted",
    at: "t-ok",
    failures: 0,
  });
  const degraded = channelHealthLine({ state: "degraded", consecutive_failures: 0, last_failure_at: "t-fail", last_failure_kind: "timeout" });
  assert.equal(degraded.tone, "warning");
  assert.equal(degraded.at, "t-fail");
  assert.deepEqual(degraded.cause, { key: "timeout" });
  const failing = channelHealthLine({
    state: "failing",
    consecutive_failures: 4,
    failing_since: "t-since",
    last_failure_at: "t-last",
    last_failure_kind: "upstream_4xx",
    last_status_code: 400,
  });
  assert.deepEqual(failing, { state: "failing", tone: "danger", at: "t-since", failures: 4, cause: { key: "refused", status: 400 } });
});

test("only enabled failing channels need attention, the longest run first", () => {
  const channel = (id: string, enabled: boolean, state: string, failures: number, since = "") => ({
    id,
    enabled,
    health: { state, consecutive_failures: failures, failing_since: since },
  });
  const list = [
    channel("a", true, "failing", 3, "2026-10-02T09:10:00Z"),
    channel("b", true, "failing", 7, "2026-10-02T08:00:00Z"),
    channel("c", false, "failing", 9),
    channel("d", true, "degraded", 0),
    channel("e", true, "failing", 3, "2026-10-02T09:00:00Z"),
  ];
  assert.deepEqual(failingChannels(list).map((c) => c.id), ["b", "e", "a"]);
});

test("a rule can fall back to any channel but its own, and a save clears a fallback that became a primary", () => {
  const channels = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(fallbackChoices(channels, ["a"]).map((c) => c.id), ["b", "c"]);
  assert.equal(fallbackForSave("b", ["a"], false), "b");
  assert.equal(fallbackForSave("b", ["a", "b"], true), "");
  assert.equal(fallbackForSave("", ["a"], true), "");
  // A rule that never had a fallback sends nothing for it.
  assert.equal(fallbackForSave("", ["a"], false), undefined);
});

const zones = new Set(["Asia/Shanghai", "UTC", "America/Los_Angeles"]);
const knownZone = (zone: string) => zones.has(zone);

test("a new rule escalates after 30 minutes at critical and has no quiet hours", () => {
  const draft = ruleIncidentDraft(undefined, "America/Los_Angeles");
  assert.deepEqual(draft, { escalate: true, afterMinutes: "30", barkLevel: "critical", quiet: false, quietStart: "23:00", quietEnd: "07:00", quietZone: "America/Los_Angeles" });
  assert.deepEqual(ruleIncidentErrors(draft, knownZone), []);
  // Nothing changed, nothing sent: a rule saves on a server without the fields.
  assert.deepEqual(ruleIncidentRequest(draft, draft), {});
});

test("a rule's stored options fill the draft, and only what changed is sent", () => {
  const rule = { escalation_off: false, escalate_after_minutes: 45, escalation_bark_level: "timeSensitive", quiet_hours: { start: "22:30", end: "06:00", time_zone: "Asia/Shanghai" } };
  const original = ruleIncidentDraft(rule, "UTC");
  assert.equal(original.afterMinutes, "45");
  assert.equal(original.quietZone, "Asia/Shanghai");
  assert.deepEqual(ruleIncidentRequest({ ...original, afterMinutes: "60" }, original), { escalate_after_minutes: 60 });
  assert.deepEqual(ruleIncidentRequest({ ...original, escalate: false }, original), { escalation_off: true });
  assert.deepEqual(ruleIncidentRequest({ ...original, quiet: false }, original), { quiet_hours: null });
  assert.deepEqual(ruleIncidentRequest({ ...original, quietEnd: "07:00" }, original), { quiet_hours: { start: "22:30", end: "07:00", time_zone: "Asia/Shanghai" } });
  // Edits to hidden quiet hours fields while quiet hours stay off send nothing.
  const off = ruleIncidentDraft(undefined, "UTC");
  assert.deepEqual(ruleIncidentRequest({ ...off, quietStart: "21:00" }, off), {});
  assert.deepEqual(ruleIncidentRequest({ ...off, quiet: true }, off), { quiet_hours: { start: "23:00", end: "07:00", time_zone: "UTC" } });
});

test("the fields follow the server's rules: 5 to 1440 minutes, a Bark level, two different times, a known zone", () => {
  const base = ruleIncidentDraft(undefined, "UTC");
  assert.deepEqual(ruleIncidentErrors({ ...base, afterMinutes: "4" }, knownZone), ["after"]);
  assert.deepEqual(ruleIncidentErrors({ ...base, afterMinutes: "1441" }, knownZone), ["after"]);
  assert.deepEqual(ruleIncidentErrors({ ...base, afterMinutes: "7.5" }, knownZone), ["after"]);
  assert.deepEqual(ruleIncidentErrors({ ...base, barkLevel: "loud" }, knownZone), ["barkLevel"]);
  // Quiet hours are checked only when on.
  assert.deepEqual(ruleIncidentErrors({ ...base, quietZone: "Mars/Olympus" }, knownZone), []);
  const quiet = { ...base, quiet: true };
  assert.deepEqual(ruleIncidentErrors({ ...quiet, quietStart: "7:00" }, knownZone), ["quietTimes"]);
  assert.deepEqual(ruleIncidentErrors({ ...quiet, quietEnd: "23:00" }, knownZone), ["quietSame"]);
  assert.deepEqual(ruleIncidentErrors({ ...quiet, quietZone: "Mars/Olympus" }, knownZone), ["quietZone"]);
  assert.deepEqual(ruleIncidentErrors({ ...quiet, quietZone: " " }, knownZone), ["quietZone"]);
});

test("a rule row names its quiet hours and an escalation that is not the default", () => {
  assert.deepEqual(ruleIncidentSummary({ escalate_after_minutes: 30, escalation_bark_level: "critical", quiet_hours: null }), { quiet: undefined, escalation: "default" });
  assert.deepEqual(ruleIncidentSummary({ escalation_off: true }), { quiet: undefined, escalation: "off" });
  assert.deepEqual(ruleIncidentSummary({ escalate_after_minutes: 60, escalation_bark_level: "critical", quiet_hours: { start: "23:00", end: "07:00", time_zone: "Asia/Shanghai" } }), {
    quiet: { start: "23:00", end: "07:00", zone: "Asia/Shanghai" },
    escalation: { minutes: 60, level: "critical" },
  });
});
