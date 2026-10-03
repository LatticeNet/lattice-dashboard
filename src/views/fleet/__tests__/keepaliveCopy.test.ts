import assert from "node:assert/strict";
import test from "node:test";

// The keepalive surfaces build many keys from a value (`fleet.keepalive.kind.${kind}`),
// which the literal-key coverage in i18n/__tests__ cannot see. Each list
// below is the set of values the code can produce, so a new kind, filter,
// step or error without copy fails here instead of rendering a dotted path.
import enFleet from "../../../i18n/locales/en/fleet.ts";
import enPlatform from "../../../i18n/locales/en/platform.ts";
import zhFleet from "../../../i18n/locales/zh-CN/fleet.ts";
import zhPlatform from "../../../i18n/locales/zh-CN/platform.ts";
import { INCIDENT_FILTERS, INCIDENT_KINDS, SNOOZE_MINUTES, type WindowDraftError, type WindowPhase } from "../incidentsModel.ts";
import { LOOP_STEP_ORDER } from "../loopHealthModel.ts";
import { BARK_LEVELS, type RuleIncidentError } from "../../platform/notificationsModel.ts";
import { SENT_OUTCOMES, type SentNoteKey, type SentState } from "../../platform/notifySentModel.ts";

const en = { ...enFleet, ...enPlatform } as Record<string, unknown>;
const zh = { ...zhFleet, ...zhPlatform } as Record<string, unknown>;

function lookup(messages: Record<string, unknown>, key: string): unknown {
  return key.split(".").reduce<unknown>((node, seg) => (node && typeof node === "object" ? (node as Record<string, unknown>)[seg] : undefined), messages);
}

const WINDOW_ERRORS: WindowDraftError[] = ["name", "nameLong", "reasonLong", "target", "start", "end", "endBeforeStart", "endPast", "tooLong"];
const WINDOW_PHASES: WindowPhase[] = ["upcoming", "active", "ended"];
const RULE_ERRORS: RuleIncidentError[] = ["after", "barkLevel", "quietTimes", "quietSame", "quietZone"];
const SENT_STATES: SentState[] = ["sent", "failed", "retrying", "queued", "not_routed", "held"];
const SENT_NOTES: SentNoteKey[] = ["heldMaintenance", "heldSnoozed", "heldFlapping", "quietHours", "withdrawnOpen", "withdrawnRecovery", "escalation", "noRule", "noChannel", "noOtherChannel", "redriven", "interrupted", "channelDeleted", "channelDisabled"];

const keys = [
  ...INCIDENT_KINDS.map((kind) => `fleet.keepalive.kind.${kind.replace(".", "_")}`),
  ...INCIDENT_KINDS.filter((kind) => kind !== "monitor.down").map((kind) => `fleet.keepalive.claim.${kind.replace(".", "_")}`),
  ...INCIDENT_FILTERS.map((filter) => `fleet.keepalive.filter.${filter}`),
  ...SNOOZE_MINUTES.map((minutes) => `fleet.keepalive.snooze.m${minutes}`),
  ...WINDOW_PHASES.map((phase) => `fleet.keepalive.maintenance.phase.${phase}`),
  ...WINDOW_ERRORS.map((error) => `fleet.keepalive.maintenance.error.${error}`),
  ...LOOP_STEP_ORDER.map((step) => `fleet.loop.step.${step}`),
  ...BARK_LEVELS.map((level) => `platform.notifications.incidents.levels.${level}`),
  ...RULE_ERRORS.map((error) => `platform.notifications.incidents.errors.${error}`),
  ...SENT_STATES.map((state) => `platform.notifications.sent.state.${state}`),
  ...SENT_OUTCOMES.map((outcome) => `platform.notifications.sent.outcomeFilter.${outcome}`),
  ...SENT_NOTES.map((note) => `platform.notifications.sent.note.${note}`),
];

test("every key the keepalive surfaces build from a value has copy in both locales", () => {
  const missing = keys.flatMap((key) => [
    ...(typeof lookup(en, key) === "string" ? [] : [`${key} (en)`]),
    ...(typeof lookup(zh, key) === "string" ? [] : [`${key} (zh-CN)`]),
  ]);
  assert.deepEqual(missing, []);
});
