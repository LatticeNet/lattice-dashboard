import type {
  NotifyCatalogueEntry,
  NotifyCataloguePattern,
  NotifyCatalogueResponse,
  NotifyDelivery,
  NotifySeverity,
} from "@/lib/api";

import { eventKey } from "@/lib/incidentSeverity";

/**
 * The presentation catalogue (design-notify-abstraction 13.1 and 13.3): what
 * kind of event a notification is, how bad it is, and the glyph the phone and
 * the Sent log both show for it. Kept free of Vue so `node --test` covers it.
 *
 * The server is the source of truth. Rows of GET /api/notify/deliveries carry
 * category, severity, recovery and icon, and GET /api/notify/catalogue lists
 * every entry. FALLBACK_CATALOGUE mirrors the server's table
 * (internal/server/notify_catalogue.go) only so the console still reads a
 * server from before slice P, which sends neither; a field the server sent is
 * never replaced from it. When the server's table changes, the server wins
 * and this mirror only matters for older servers.
 */

export const NOTIFY_SEVERITIES = ["info", "notice", "warning", "critical"] as const satisfies readonly NotifySeverity[];

/**
 * The glyphs the console can draw. An explicit allow-list, so the bundle
 * carries these icons and no others; a name outside it draws bell.
 * NotifyEventGlyph.vue maps each name to its lucide import.
 */
export const NOTIFY_ICON_NAMES = [
  "server-off",
  "server",
  "power-off",
  "power",
  "activity",
  "heart-pulse",
  "hourglass",
  "bot",
  "key-round",
  "shield-alert",
  "lock-keyhole",
  "gauge",
  "calendar-clock",
  "receipt",
  "bell-off",
  "bell-ring",
  "flask-conical",
  "puzzle",
  "webhook",
  "bell",
] as const;
export type NotifyIconName = (typeof NOTIFY_ICON_NAMES)[number];

export const FALLBACK_ICON: NotifyIconName = "bell";

/** A server icon name the console can draw, or bell. */
export function notifyIconName(name: string | undefined): NotifyIconName {
  return (NOTIFY_ICON_NAMES as readonly string[]).includes(name ?? "") ? (name as NotifyIconName) : FALLBACK_ICON;
}

/** Category ids in the server's order, which is also the order the filter groups follow. */
export const FALLBACK_CATEGORIES = [
  { id: "nodes", label: "Nodes" },
  { id: "services", label: "Services" },
  { id: "monitors", label: "Monitors" },
  { id: "agents", label: "Agents" },
  { id: "ssh", label: "SSH" },
  { id: "auth", label: "Sign-in" },
  { id: "quota", label: "Quota" },
  { id: "inventory", label: "Inventory" },
  { id: "notify", label: "Notifications" },
  { id: "plugins", label: "Plugins" },
  { id: "webhooks", label: "Webhooks" },
  { id: "general", label: "General" },
] as const;

function entry(type: string, category: string, severity: NotifySeverity, icon: NotifyIconName, description: string, recovery = false): NotifyCatalogueEntry {
  return { type, category, severity, recovery, icon, description };
}

/**
 * The client mirror of the catalogue table in design-notify-abstraction 13.1.
 * Fallback only: the server is the source of truth (see the file comment).
 */
export const FALLBACK_CATALOGUE: NotifyCatalogueResponse = {
  categories: FALLBACK_CATEGORIES.map((category) => ({ ...category })),
  types: [
    entry("node.offline", "nodes", "critical", "server-off", "A node stopped reporting"),
    entry("node.online", "nodes", "info", "server", "A node is reporting again", true),
    entry("service.down", "services", "critical", "power-off", "A service on a node went down"),
    entry("service.recovered", "services", "info", "power", "A service on a node recovered", true),
    entry("monitor.down", "monitors", "warning", "activity", "A monitor is failing"),
    entry("monitor.recovered", "monitors", "info", "heart-pulse", "A monitor recovered", true),
    entry("agent.stalled", "agents", "warning", "hourglass", "A node agent stalled"),
    entry("agent.recovered", "agents", "info", "bot", "A node agent recovered", true),
    entry("ssh.login", "ssh", "notice", "key-round", "An SSH login on a node"),
    entry("ssh.compromise_suspected", "ssh", "critical", "shield-alert", "A suspected SSH compromise"),
    entry("auth.2fa_limit", "auth", "warning", "lock-keyhole", "Too many failed two-factor attempts"),
    entry("proxy.quota", "quota", "notice", "gauge", "A VPN user is near their traffic quota"),
    entry("proxy.expiry", "quota", "notice", "calendar-clock", "A VPN user is about to expire"),
    entry("inventory.renewal", "inventory", "notice", "receipt", "A machine renews soon"),
    entry("notify.channel_failing", "notify", "warning", "bell-off", "A notification channel is failing"),
    entry("notify.channel_ok", "notify", "info", "bell-ring", "A notification channel works again", true),
    entry("notify.test", "notify", "info", "flask-conical", "A test message"),
    entry("generic", "general", "info", "bell", "A notification"),
  ],
  patterns: [{ ...entry("plugin.<id>.message", "plugins", "info", "puzzle", "A message from a plugin"), pattern: "plugin.<id>.message" }],
  webhook_types: [],
};

/** The entry operator webhook types share when the server's catalogue is not loaded. */
const FALLBACK_WEBHOOK = entry("", "webhooks", "info", "webhook", "An event from an inbound webhook");

const GENERIC_TYPE = "generic";

/** How an event type found its entry, in the server's lookup order. */
export type CatalogueMatchKind = "exact" | "pattern" | "webhook" | "generic";

export interface CatalogueMatch {
  kind: CatalogueMatchKind;
  entry: NotifyCatalogueEntry;
  /**
   * The message key under platform.notifications.sent.types that names it:
   * the exact type with dots as underscores, a pattern's fixed segments
   * (plugin.<id>.message reads plugin_message), webhook, or generic.
   */
  labelKey: string;
}

/** A pattern segment that stands for any text: `<id>` or `*`. */
function wildcard(segment: string): boolean {
  return segment === "*" || /^<[^>]*>$/.test(segment);
}

function patternText(pattern: NotifyCataloguePattern): string {
  return pattern.pattern || pattern.type || "";
}

/** A wildcard matches one or more segments: a plugin id carries dots of its own. */
export function patternMatches(pattern: string, type: string): boolean {
  const parts = pattern.split(".");
  if (!parts.some(wildcard)) return pattern === type;
  const source = parts.map((part) => (wildcard(part) ? ".+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("\\.");
  return new RegExp(`^${source}$`).test(type);
}

export function patternLabelKey(pattern: string): string {
  return pattern
    .split(".")
    .filter((part) => part && !wildcard(part))
    .join("_");
}

/** Which catalogue to read: the server's once it loaded, else the mirror. */
function catalogueOf(catalogue: NotifyCatalogueResponse | null | undefined): NotifyCatalogueResponse {
  return catalogue && Array.isArray(catalogue.types) ? catalogue : FALLBACK_CATALOGUE;
}

/**
 * The catalogue's lookup (13.1): the exact type; then a pattern
 * (plugin.<id>.message); then an operator-defined webhook type, which the
 * mirror cannot list and so recognises by the row's webhook source; then the
 * generic entry. Lookup never fails.
 */
export function catalogueMatch(
  type: string,
  catalogue?: NotifyCatalogueResponse | null,
  options: { webhook?: boolean } = {},
): CatalogueMatch {
  const table = catalogueOf(catalogue);
  const exact = table.types.find((candidate) => candidate.type === type && type !== GENERIC_TYPE);
  if (exact) return { kind: "exact", entry: exact, labelKey: eventKey(type) };
  const pattern = (table.patterns ?? []).find((candidate) => patternMatches(patternText(candidate), type));
  if (pattern) return { kind: "pattern", entry: pattern, labelKey: patternLabelKey(patternText(pattern)) };
  const webhook = (table.webhook_types ?? []).find((candidate) => candidate.type === type);
  if (webhook) return { kind: "webhook", entry: webhook, labelKey: "webhook" };
  if (options.webhook) {
    const shared = table === FALLBACK_CATALOGUE ? FALLBACK_WEBHOOK : (table.webhook_types?.[0] ?? FALLBACK_WEBHOOK);
    return { kind: "webhook", entry: { ...shared, type }, labelKey: "webhook" };
  }
  const generic =
    table.types.find((candidate) => candidate.type === GENERIC_TYPE) ??
    FALLBACK_CATALOGUE.types.find((candidate) => candidate.type === GENERIC_TYPE)!;
  return { kind: "generic", entry: generic, labelKey: "generic" };
}

function isSeverity(value: unknown): value is NotifySeverity {
  return (NOTIFY_SEVERITIES as readonly unknown[]).includes(value);
}

/** What a row shows: its tone, glyph and the inputs of its label. */
export interface NotifyPresentation {
  type: string;
  category: string;
  severity: NotifySeverity;
  recovery: boolean;
  icon: NotifyIconName;
  /** A key under platform.notifications.sent.types, or "" when only the description or the raw type can name it. */
  labelKey: string;
  /** The catalogue's English line, the label when the console has no words for the type. */
  description: string;
}

/**
 * A delivery's presentation. Each field the server sent wins; a field it did
 * not send (a server before slice P sends none) comes from the catalogue
 * lookup. An icon name the console cannot draw draws bell rather than the
 * looked-up glyph: the server named a glyph, and bell is the honest fallback.
 */
export function presentDelivery(
  row: Pick<NotifyDelivery, "event_type" | "source"> & Partial<Pick<NotifyDelivery, "category" | "severity" | "recovery" | "icon">>,
  catalogue?: NotifyCatalogueResponse | null,
): NotifyPresentation {
  const match = catalogueMatch(row.event_type, catalogue, { webhook: row.source === "webhook" });
  const category = typeof row.category === "string" && row.category ? row.category : match.entry.category;
  // The lookup fell through to generic, yet the server filed the row elsewhere: a
  // type the server knows and this console does not. Generic's words would be
  // wrong, so the raw type names it.
  const contradicted = match.kind === "generic" && category !== match.entry.category;
  return {
    type: row.event_type,
    category,
    severity: isSeverity(row.severity) ? row.severity : isSeverity(match.entry.severity) ? match.entry.severity : "info",
    recovery: typeof row.recovery === "boolean" ? row.recovery : match.entry.recovery === true,
    icon: notifyIconName(typeof row.icon === "string" && row.icon ? row.icon : match.entry.icon),
    labelKey: contradicted ? "" : match.labelKey,
    description: contradicted ? "" : match.entry.description,
  };
}

/**
 * The readable label, in order: the console's words for the type, the
 * catalogue's description, the raw type. `words` answers a key under
 * platform.notifications.sent.types, or undefined when the locale has none.
 */
export function notifyLabel(presentation: Pick<NotifyPresentation, "type" | "labelKey" | "description">, words: (key: string) => string | undefined): string {
  return (presentation.labelKey ? words(presentation.labelKey) : undefined) || presentation.description || presentation.type;
}

/** Colour says how bad, the glyph says what (13.3). */
export type NotifyTone = "critical" | "warning" | "notice" | "quiet" | "recovered";

/** A recovery reads as recovered whatever its severity; the rest follow severity. */
export function notifyTone(presentation: Pick<NotifyPresentation, "severity" | "recovery">): NotifyTone {
  if (presentation.recovery) return "recovered";
  switch (presentation.severity) {
    case "critical":
      return "critical";
    case "warning":
      return "warning";
    case "notice":
      return "notice";
    default:
      return "quiet";
  }
}

/** Whether the meta line spells the severity out, so the distinction does not rest on colour alone. */
export function toneSaysSeverity(tone: NotifyTone): boolean {
  return tone === "critical" || tone === "warning";
}

/*
 * The disc: the soft fills status.ts gives its icon chips (iconBgClass), with
 * the glyph in the AA text step where one exists (status.ts's textClass does
 * the same for warning). Existing semantic tokens only, no new hue.
 */
export const TONE_DISC: Record<NotifyTone, string> = {
  critical: "bg-destructive/10 text-destructive",
  warning: "bg-warning/10 text-warning-text",
  notice: "bg-info/10 text-info-text",
  quiet: "bg-muted text-muted-foreground",
  recovered: "bg-success/10 text-success-text",
};

/** The glyph alone, where a disc would be too heavy (a select option, a form hint). */
export const TONE_INK: Record<NotifyTone, string> = {
  critical: "text-destructive",
  warning: "text-warning-text",
  notice: "text-info-text",
  quiet: "text-muted-foreground",
  recovered: "text-success-text",
};

export interface EventOption {
  type: string;
  labelKey: string;
  description: string;
  icon: NotifyIconName;
  tone: NotifyTone;
}

export interface EventOptionGroup {
  category: string;
  /** The server's English label for the category, the fallback when the console has none. */
  label: string;
  options: EventOption[];
}

function optionFor(type: string, catalogue: NotifyCatalogueResponse | null | undefined, webhook: boolean): { category: string; option: EventOption } {
  const presentation = presentDelivery({ event_type: type, source: webhook ? "webhook" : "server" }, catalogue);
  return {
    category: presentation.category,
    option: { type, labelKey: presentation.labelKey, description: presentation.description, icon: presentation.icon, tone: notifyTone(presentation) },
  };
}

/**
 * Event types grouped by category, in the catalogue's category order: every
 * exact type and operator webhook type the catalogue lists (the mirror when
 * the server has no catalogue), then any type the loaded rows carry (a
 * plugin's message, a webhook the mirror cannot list, a type newer than this
 * console), then the one the address asks for, which a filtered empty page
 * would otherwise leave the select unable to show. Rows only ever add; a
 * catalogue type is offered before anything was sent.
 */
export function eventOptionGroups(
  catalogue: NotifyCatalogueResponse | null | undefined,
  rows: readonly Pick<NotifyDelivery, "event_type" | "source">[] = [],
  current = "",
): EventOptionGroup[] {
  const table = catalogueOf(catalogue);
  const groups = new Map<string, EventOptionGroup>();
  const labels = new Map<string, string>();
  for (const category of [...(table.categories ?? []), ...FALLBACK_CATEGORIES]) {
    if (!labels.has(category.id)) labels.set(category.id, category.label);
  }
  const seen = new Set<string>();
  const add = (type: string, webhook: boolean) => {
    if (!type || type === "*" || seen.has(type)) return;
    seen.add(type);
    const { category, option } = optionFor(type, catalogue, webhook);
    let group = groups.get(category);
    if (!group) {
      group = { category, label: labels.get(category) ?? category, options: [] };
      groups.set(category, group);
    }
    group.options.push(option);
  };
  for (const known of table.types) add(known.type, false);
  for (const known of table.webhook_types ?? []) add(known.type, true);
  const extras = rows.map((row) => ({ type: row.event_type, webhook: row.source === "webhook" }));
  if (current) extras.push({ type: current, webhook: false });
  extras.sort((a, b) => a.type.localeCompare(b.type));
  for (const extra of extras) add(extra.type, extra.webhook);
  const order = [...labels.keys()];
  const rank = (id: string) => {
    const at = order.indexOf(id);
    return at < 0 ? order.length : at;
  };
  return [...groups.values()].sort((a, b) => rank(a.category) - rank(b.category) || a.category.localeCompare(b.category));
}

/**
 * The rule form's list of event types: what a rule can name, which is an
 * exact type (notifyRuleMatches compares types exactly, or "*"), so a pattern
 * is left out and so are types only seen in the log.
 */
export function ruleEventGroups(catalogue: NotifyCatalogueResponse | null | undefined): EventOptionGroup[] {
  return eventOptionGroups(catalogue);
}
