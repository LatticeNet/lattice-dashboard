import type { NotifyKind } from "@/lib/api";

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
