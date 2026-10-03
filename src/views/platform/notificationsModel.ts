import type { NotifyChannelHealth, NotifyKind, NotifyRuleUpsertRequest, NotifyRuleView } from "@/lib/api";

/**
 * The channel form is a kind switch over a list of config fields. The lists
 * live here, away from the view, so the shape the console sends for each kind
 * can be checked against the server's contract without rendering a dialog.
 */

export interface FieldDef {
  /** Config key as the server reads it. */
  key: string;
  /** i18n key for the label. */
  label: string;
  required: boolean;
  /** Literal placeholder, or an i18n key when it starts with "platform.". */
  placeholder: string;
  /** i18n key for one sentence on what the field changes at the destination. */
  hint?: string;
  /**
   * A closed set of accepted values, rendered as a select. Blank is always
   * allowed on top of these and means the server's own default.
   */
  options?: readonly string[];
}

/**
 * Interruption levels bark-server accepts, in the order the app lists them.
 * The server validates the same set and answers 400 to anything else, so the
 * select only ever offers these; blank leaves the choice to the server, which
 * sends "active".
 */
export const BARK_LEVELS = ["active", "timeSensitive", "passive", "critical"] as const;

export const KIND_FIELDS: Record<NotifyKind, FieldDef[]> = {
  telegram: [
    { key: "token", label: "platform.notifications.fieldBotToken", required: true, placeholder: "123456:ABC-DEF…" },
    { key: "chat_id", label: "platform.notifications.fieldChatId", required: true, placeholder: "-1001234567890" },
    { key: "base_url", label: "platform.notifications.fieldBaseUrl", required: false, placeholder: "https://api.telegram.org (optional)" },
  ],
  bark: [
    { key: "base_url", label: "platform.notifications.fieldBaseUrl", required: true, placeholder: "https://api.day.app" },
    { key: "key", label: "platform.notifications.fieldDeviceKey", required: true, placeholder: "platform.notifications.deviceKeyPlaceholder" },
    {
      key: "level",
      label: "platform.notifications.fieldLevel",
      required: false,
      placeholder: "platform.notifications.levelDefault",
      hint: "platform.notifications.levelHint",
      options: BARK_LEVELS,
    },
    {
      key: "group",
      label: "platform.notifications.fieldGroup",
      required: false,
      placeholder: "lattice",
      hint: "platform.notifications.groupHint",
    },
    {
      key: "url",
      label: "platform.notifications.fieldBarkUrl",
      required: false,
      placeholder: "https://lattice.example/alerts",
      hint: "platform.notifications.barkUrlHint",
    },
  ],
  discord: [
    { key: "webhook_url", label: "platform.notifications.fieldWebhookUrl", required: true, placeholder: "https://discord.com/api/webhooks/…" },
  ],
  webhook: [
    { key: "url", label: "platform.notifications.fieldUrl", required: true, placeholder: "https://example.com/hook" },
  ],
};

export const KIND_OPTIONS: NotifyKind[] = ["telegram", "bark", "discord", "webhook"];

/**
 * What the blank entry of a select carries. reka-ui refuses a SelectItem whose
 * value is the empty string (it reserves "" for "nothing selected" and throws
 * at render, which unmounts the whole list), so the "server default" entry
 * carries this sentinel and the form maps it back to blank at the boundary.
 * The config itself never holds it: blank stays "" and is omitted on save.
 */
export const SELECT_DEFAULT = "__default__";

export function toSelectValue(value: string): string {
  return value || SELECT_DEFAULT;
}

export function fromSelectValue(value: string): string {
  return value === SELECT_DEFAULT ? "" : value;
}

/** Whether every required field has a non-blank value. Optional fields never block. */
export function configComplete(fields: readonly FieldDef[], config: Record<string, string>): boolean {
  return fields
    .filter((field) => field.required)
    .every((field) => (config[field.key] ?? "").trim().length > 0);
}

/**
 * The config the console sends. Blank fields are omitted rather than sent as
 * empty strings: an absent optional key is how the server applies its own
 * default, and a channel saved before a field existed keeps the same shape
 * when it is edited and saved again with the field left blank.
 */
export function buildConfig(fields: readonly FieldDef[], config: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of fields) {
    const value = (config[field.key] ?? "").trim();
    if (value) out[field.key] = value;
  }
  return out;
}

/**
 * Stored keys the save would silently drop. The server never returns config
 * values and replaces the whole map on save, so a stored key the form does not
 * re-send is gone once the save lands. Required keys left blank already fail
 * the save with a 400 and are covered by the edit hint, so they are not listed
 * here; the optional Bark fields (level, group, url) and any key the form has
 * no input for would vanish without a word, which is what this list exists to
 * surface.
 */
export function droppedStoredKeys(
  fields: readonly FieldDef[],
  storedKeys: readonly string[],
  config: Record<string, string>,
): string[] {
  const sent = buildConfig(fields, config);
  const required = new Set(fields.filter((field) => field.required).map((field) => field.key));
  return storedKeys.filter((key) => !(key in sent) && !required.has(key));
}

export interface ChannelSaveGate {
  /** Stored keys this save would clear, in the order the server listed them. */
  dropped: string[];
  /** True while the save must not go out: keys would be cleared without an acknowledgement. */
  blocked: boolean;
}

/**
 * Whether an edit may be saved. A kind change hands the whole config over to
 * the kind-changed hint, since nothing stored carries across; otherwise every
 * stored optional key the form leaves blank has to be acknowledged as cleared
 * before Save is reachable.
 */
export function channelSaveGate(input: {
  fields: readonly FieldDef[];
  storedKeys: readonly string[];
  config: Record<string, string>;
  kindChanged: boolean;
  clearAcknowledged: boolean;
}): ChannelSaveGate {
  if (input.kindChanged) return { dropped: [], blocked: false };
  const dropped = droppedStoredKeys(input.fields, input.storedKeys, input.config);
  return { dropped, blocked: dropped.length > 0 && !input.clearAcknowledged };
}

// ── what a channel delete stops ─────────────────────────────────────────────

export type ChannelDeleteLine =
  | { kind: "silenced"; rule: string; events: string }
  | { kind: "kept"; rule: string; others: string[] }
  | { kind: "noRules" }
  | { kind: "unrouted" }
  | { kind: "rulesUnread" };

export interface ChannelDeleteImpact {
  lines: ChannelDeleteLine[];
  /** The operator types the channel's name before Delete enables. */
  typed: boolean;
}

interface ChannelLike {
  id: string;
  name?: string;
  enabled: boolean;
}

interface RuleLike {
  id: string;
  name?: string;
  enabled: boolean;
  channel_ids?: string[] | null;
  event_types?: string[] | null;
}

/**
 * What deleting a channel stops (design 23, section 3.8).
 *
 * Once one enabled rule exists, only rules deliver, so an enabled rule whose
 * every other channel is gone or disabled stops reaching anyone: those come
 * first, with their events, and the operator types the channel's name.
 * Rules that keep another enabled channel are named with it. With no enabled
 * rule every enabled channel gets everything, so the channel simply stops
 * receiving. With the rules unread nothing is claimed either way, and the
 * typed name is asked for.
 */
export function channelDeleteImpact(
  target: ChannelLike,
  rules: readonly RuleLike[] | undefined,
  channels: readonly ChannelLike[],
): ChannelDeleteImpact {
  if (!rules) return { lines: [{ kind: "rulesUnread" }], typed: true };
  const enabledRules = rules.filter((rule) => rule.enabled);
  if (!enabledRules.length) return { lines: target.enabled ? [{ kind: "noRules" }] : [], typed: false };
  const name = (entry: { id: string; name?: string }) => entry.name || entry.id;
  const silenced: ChannelDeleteLine[] = [];
  const kept: ChannelDeleteLine[] = [];
  for (const rule of [...enabledRules].sort((a, b) => name(a).localeCompare(name(b)))) {
    const routed = rule.channel_ids ?? [];
    if (!routed.includes(target.id)) continue;
    const others = routed
      .filter((id) => id !== target.id)
      .map((id) => channels.find((channel) => channel.id === id && channel.enabled))
      .filter((channel): channel is ChannelLike => !!channel)
      .map(name);
    // A rule with no event types matches every event, as the dispatcher reads it.
    const events = (rule.event_types?.length ? rule.event_types : ["*"]).join(", ");
    if (others.length) kept.push({ kind: "kept", rule: name(rule), others });
    else silenced.push({ kind: "silenced", rule: name(rule), events });
  }
  if (!silenced.length && !kept.length) return { lines: [{ kind: "unrouted" }], typed: false };
  return { lines: [...silenced, ...kept], typed: silenced.length > 0 };
}

// ── channel health ──────────────────────────────────────────────────────────

/**
 * Why a send failed, in words the console chooses. The server returns a
 * classified kind and a status code and never the transport error, which
 * carries the channel credential, so these are the only failure details a
 * page can show.
 */
export type FailureCauseKey = "refused" | "serverError" | "rateLimited" | "timeout" | "unreachable" | "configRefused" | "failed";

export interface FailureCause {
  key: FailureCauseKey;
  status?: number;
}

export function failureCause(kind?: string, status?: number): FailureCause {
  switch (kind) {
    case "upstream_4xx":
      return { key: "refused", status };
    case "upstream_5xx":
      return { key: "serverError", status };
    case "rate_limited":
      return { key: "rateLimited", status: status || 429 };
    case "timeout":
      return { key: "timeout" };
    case "network":
      return { key: "unreachable" };
    case "config_invalid":
      return { key: "configRefused" };
    default:
      return { key: "failed" };
  }
}

export type HealthTone = "muted" | "warning" | "danger";

/**
 * One line for a channel's health. `unreported` is a server older than the
 * outbox, which sends no health at all: the line says so rather than calling
 * the channel unused.
 */
export interface HealthLine {
  state: "unreported" | "unknown" | "ok" | "degraded" | "failing";
  tone: HealthTone;
  /** When the line's claim dates from: the last success, the last failure, or failing since. */
  at?: string;
  failures: number;
  cause?: FailureCause;
}

export function channelHealthLine(health?: NotifyChannelHealth): HealthLine {
  if (!health) return { state: "unreported", tone: "muted", failures: 0 };
  const failures = health.consecutive_failures ?? 0;
  const cause = health.last_failure_kind ? failureCause(health.last_failure_kind, health.last_status_code) : undefined;
  switch (health.state) {
    case "failing":
      return { state: "failing", tone: "danger", at: health.failing_since ?? health.last_failure_at, failures, cause };
    case "degraded":
      return { state: "degraded", tone: "warning", at: health.last_failure_at, failures, cause };
    case "ok":
      return { state: "ok", tone: "muted", at: health.last_ok_at ?? health.last_attempt_at, failures: 0 };
    default:
      return { state: "unknown", tone: "muted", failures: 0 };
  }
}

interface HealthChannel {
  id: string;
  name?: string;
  enabled: boolean;
  health?: NotifyChannelHealth;
}

/**
 * Enabled channels the server calls failing, worst first: the longest run of
 * failures, then the earliest start. A disabled channel sends nothing, so its
 * old failures are not a claim worth the attention list.
 */
export function failingChannels<T extends HealthChannel>(channels: readonly T[]): T[] {
  return channels
    .filter((channel) => channel.enabled && channel.health?.state === "failing")
    .sort(
      (a, b) =>
        (b.health?.consecutive_failures ?? 0) - (a.health?.consecutive_failures ?? 0) ||
        (a.health?.failing_since ?? "").localeCompare(b.health?.failing_since ?? ""),
    );
}

// ── fallback channel ────────────────────────────────────────────────────────

/**
 * Channels a rule may fall back to: every stored channel except the rule's
 * own, since a channel that is also a primary has already failed by the time
 * the fallback would be used (the server refuses it too).
 */
export function fallbackChoices<T extends { id: string }>(channels: readonly T[], primaryIds: readonly string[]): T[] {
  return channels.filter((channel) => !primaryIds.includes(channel.id));
}

/**
 * The fallback a save sends: "" clears a fallback that the operator removed
 * or that became one of the rule's own channels, and undefined leaves a rule
 * that never had one untouched on a server that may not know the field.
 */
export function fallbackForSave(selected: string, primaryIds: readonly string[], hadFallback: boolean): string | undefined {
  const value = primaryIds.includes(selected) ? "" : selected;
  if (!value && !hadFallback) return undefined;
  return value;
}

/* ------------------------- incident escalation and quiet hours ------------------------- */

/** lattice-server incidents.go: re-send an unacknowledged critical incident after 30 min at Bark level critical. */
export const ESCALATE_DEFAULT_MINUTES = 30;
export const ESCALATE_MIN_MINUTES = 5;
export const ESCALATE_MAX_MINUTES = 1440;
export const ESCALATION_DEFAULT_LEVEL = "critical";

/** The rule form's escalation and quiet hours fields, as the inputs hold them. */
export interface RuleIncidentDraft {
  escalate: boolean;
  /** The number input's text. */
  afterMinutes: string;
  barkLevel: string;
  quiet: boolean;
  /** "HH:MM", what a time input holds. */
  quietStart: string;
  quietEnd: string;
  quietZone: string;
}

/**
 * The draft for a rule, or for a new one: escalation on after 30 minutes at
 * critical, quiet hours off (the operator's default), with 23:00 to 07:00 in
 * the browser's zone ready if they are turned on. A rule from a server
 * without these fields reads as the defaults.
 */
export function ruleIncidentDraft(
  rule: Pick<NotifyRuleView, "escalation_off" | "escalate_after_minutes" | "escalation_bark_level" | "quiet_hours"> | undefined,
  browserZone: string,
): RuleIncidentDraft {
  const quiet = rule?.quiet_hours ?? null;
  return {
    escalate: !rule?.escalation_off,
    afterMinutes: String(rule?.escalate_after_minutes || ESCALATE_DEFAULT_MINUTES),
    barkLevel: rule?.escalation_bark_level || ESCALATION_DEFAULT_LEVEL,
    quiet: !!quiet,
    quietStart: quiet?.start ?? "23:00",
    quietEnd: quiet?.end ?? "07:00",
    quietZone: quiet?.time_zone ?? (browserZone || "Asia/Shanghai"),
  };
}

export type RuleIncidentError = "after" | "barkLevel" | "quietTimes" | "quietSame" | "quietZone";

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** What keeps the fields from saving, by the server's rules (applyNotifyRuleOptions). */
export function ruleIncidentErrors(draft: RuleIncidentDraft, knownZone: (zone: string) => boolean): RuleIncidentError[] {
  const errors: RuleIncidentError[] = [];
  // Hidden fields do not block a save: with escalation off they are not sent (ruleIncidentRequest).
  if (draft.escalate) {
    const after = Number(draft.afterMinutes);
    if (!Number.isInteger(after) || after < ESCALATE_MIN_MINUTES || after > ESCALATE_MAX_MINUTES) errors.push("after");
    if (!(BARK_LEVELS as readonly string[]).includes(draft.barkLevel)) errors.push("barkLevel");
  }
  if (draft.quiet) {
    if (!CLOCK.test(draft.quietStart) || !CLOCK.test(draft.quietEnd)) errors.push("quietTimes");
    else if (draft.quietStart === draft.quietEnd) errors.push("quietSame");
    if (!draft.quietZone.trim() || !knownZone(draft.quietZone.trim())) errors.push("quietZone");
  }
  return errors;
}

/**
 * The request fields for a save: only what changed from `original`, like the
 * fallback, so a rule whose escalation and quiet hours were left alone saves
 * on a server that does not know them. Turning quiet hours off sends null.
 */
export function ruleIncidentRequest(
  draft: RuleIncidentDraft,
  original: RuleIncidentDraft,
): Pick<NotifyRuleUpsertRequest, "escalation_off" | "escalate_after_minutes" | "escalation_bark_level" | "quiet_hours"> {
  const out: Pick<NotifyRuleUpsertRequest, "escalation_off" | "escalate_after_minutes" | "escalation_bark_level" | "quiet_hours"> = {};
  if (draft.escalate !== original.escalate) out.escalation_off = !draft.escalate;
  // With escalation off its delay and level are hidden, so edits to them are not sent.
  if (draft.escalate && Number(draft.afterMinutes) !== Number(original.afterMinutes)) out.escalate_after_minutes = Number(draft.afterMinutes);
  if (draft.escalate && draft.barkLevel !== original.barkLevel) out.escalation_bark_level = draft.barkLevel;
  const zone = draft.quietZone.trim();
  const quietChanged =
    draft.quiet !== original.quiet ||
    (draft.quiet && (draft.quietStart !== original.quietStart || draft.quietEnd !== original.quietEnd || zone !== original.quietZone.trim()));
  if (quietChanged) out.quiet_hours = draft.quiet ? { start: draft.quietStart, end: draft.quietEnd, time_zone: zone } : null;
  return out;
}

/** One line for a rule row: its quiet hours, and escalation when it is not the default. Empty when both are default. */
export function ruleIncidentSummary(
  rule: Pick<NotifyRuleView, "escalation_off" | "escalate_after_minutes" | "escalation_bark_level" | "quiet_hours">,
): { quiet?: { start: string; end: string; zone: string }; escalation: "off" | "default" | { minutes: number; level: string } } {
  const quiet = rule.quiet_hours ? { start: rule.quiet_hours.start, end: rule.quiet_hours.end, zone: rule.quiet_hours.time_zone } : undefined;
  if (rule.escalation_off) return { quiet, escalation: "off" };
  const minutes = rule.escalate_after_minutes || ESCALATE_DEFAULT_MINUTES;
  const level = rule.escalation_bark_level || ESCALATION_DEFAULT_LEVEL;
  if (minutes === ESCALATE_DEFAULT_MINUTES && level === ESCALATION_DEFAULT_LEVEL) return { quiet, escalation: "default" };
  return { quiet, escalation: { minutes, level } };
}
