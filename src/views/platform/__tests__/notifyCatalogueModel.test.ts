import assert from "node:assert/strict";
import test from "node:test";

import type { NotifyCatalogueResponse, NotifyDelivery } from "@/lib/api";
import enPlatform from "@/i18n/locales/en/platform.ts";
import zhPlatform from "@/i18n/locales/zh-CN/platform.ts";

import {
  catalogueMatch,
  eventOptionGroups,
  FALLBACK_CATALOGUE,
  FALLBACK_CATEGORIES,
  NOTIFY_ICON_NAMES,
  notifyIconName,
  notifyLabel,
  notifyTone,
  patternMatches,
  presentDelivery,
  ruleEventGroups,
  TONE_DISC,
  toneSaysSeverity,
} from "../notifyCatalogueModel.ts";

function row(over: Partial<NotifyDelivery> & Pick<NotifyDelivery, "event_type">): NotifyDelivery {
  return { id: "nd_1", event_id: "evt_1", source: "server", outcome: "sent", created_at: "2026-10-15T09:00:00Z", ...over };
}

/** The table of design-notify-abstraction 13.1, as the contract states it. */
const CONTRACT: [type: string, category: string, severity: string, recovery: boolean, icon: string][] = [
  ["node.offline", "nodes", "critical", false, "server-off"],
  ["node.online", "nodes", "info", true, "server"],
  ["service.down", "services", "critical", false, "power-off"],
  ["service.recovered", "services", "info", true, "power"],
  ["monitor.down", "monitors", "warning", false, "activity"],
  ["monitor.recovered", "monitors", "info", true, "heart-pulse"],
  // Design 29 D13: placed after monitor.recovered, glyphs apart from the monitor's.
  ["path.degraded", "monitors", "warning", false, "trending-down"],
  ["path.recovered", "monitors", "info", true, "trending-up"],
  ["agent.stalled", "agents", "warning", false, "hourglass"],
  ["agent.recovered", "agents", "info", true, "bot"],
  ["ssh.login", "ssh", "notice", false, "key-round"],
  ["ssh.compromise_suspected", "ssh", "critical", false, "shield-alert"],
  ["auth.2fa_limit", "auth", "warning", false, "lock-keyhole"],
  ["proxy.quota", "quota", "notice", false, "gauge"],
  ["proxy.expiry", "quota", "notice", false, "calendar-clock"],
  ["inventory.renewal", "inventory", "notice", false, "receipt"],
  ["notify.channel_failing", "notify", "warning", false, "bell-off"],
  ["notify.channel_ok", "notify", "info", true, "bell-ring"],
  ["notify.test", "notify", "info", false, "flask-conical"],
  ["generic", "general", "info", false, "bell"],
];

/** A catalogue as a slice P server answers it, with one type this console has never heard of. */
const SERVER: NotifyCatalogueResponse = {
  categories: [...FALLBACK_CATEGORIES.map((c) => ({ ...c })), { id: "probes", label: "Probes" }],
  types: [
    ...FALLBACK_CATALOGUE.types.map((entry) => ({ ...entry })),
    { type: "probe.down", category: "probes", severity: "warning", recovery: false, icon: "radar", description: "An outbound probe failed" },
  ],
  // As lattice-server sends it: a pattern carries no type of its own.
  patterns: [{ pattern: "plugin.<id>.message", category: "plugins", severity: "info", recovery: false, icon: "puzzle", description: "Plugin message" }],
  webhook_types: [{ type: "backup.finished", category: "webhooks", severity: "info", recovery: false, icon: "webhook", description: "Inbound webhook nas-backup" }],
};

const words = (messages: Record<string, unknown>) => (key: string) => {
  const types = (((messages as { platform: { notifications: { sent: { types: Record<string, string> } } } }).platform.notifications.sent.types) ?? {}) as Record<string, string>;
  return types[key];
};

test("the client mirror is the contract's table, entry for entry", () => {
  const mirror = FALLBACK_CATALOGUE.types.map((e) => [e.type, e.category, e.severity, e.recovery, e.icon]);
  assert.deepEqual(mirror, CONTRACT);
  assert.deepEqual(
    FALLBACK_CATALOGUE.patterns.map((p) => [p.pattern, p.category, p.severity, p.recovery, p.icon]),
    [["plugin.<id>.message", "plugins", "info", false, "puzzle"]],
  );
  for (const entry of FALLBACK_CATALOGUE.types) {
    assert.ok((NOTIFY_ICON_NAMES as readonly string[]).includes(entry.icon), `${entry.type} draws ${entry.icon}, which the allow-list lacks`);
    assert.ok(FALLBACK_CATEGORIES.some((c) => c.id === entry.category), `${entry.type} files under unknown category ${entry.category}`);
  }
});

test("tone follows severity, and a recovery reads as recovered whatever its severity", () => {
  assert.equal(notifyTone({ severity: "critical", recovery: false }), "critical");
  assert.equal(notifyTone({ severity: "warning", recovery: false }), "warning");
  assert.equal(notifyTone({ severity: "notice", recovery: false }), "notice");
  assert.equal(notifyTone({ severity: "info", recovery: false }), "quiet");
  assert.equal(notifyTone({ severity: "info", recovery: true }), "recovered");
  // Recovery wins: a server that ever marks a recovery critical still gets the green disc.
  assert.equal(notifyTone({ severity: "critical", recovery: true }), "recovered");
  assert.equal(notifyTone({ severity: "warning", recovery: true }), "recovered");
  const tones = Object.fromEntries(CONTRACT.map(([type]) => [type, notifyTone(presentDelivery(row({ event_type: type })))]));
  assert.equal(tones["node.offline"], "critical");
  assert.equal(tones["node.online"], "recovered");
  assert.equal(tones["monitor.down"], "warning");
  assert.equal(tones["path.degraded"], "warning");
  assert.equal(tones["path.recovered"], "recovered", "a recovery is info with recovery set, which reads recovered");
  assert.equal(tones["ssh.login"], "notice");
  assert.equal(tones["notify.test"], "quiet");
  // Only critical and warning spell their severity out on the meta line.
  assert.deepEqual(
    (["critical", "warning", "notice", "quiet", "recovered"] as const).filter(toneSaysSeverity),
    ["critical", "warning"],
  );
  // Every tone has a disc in existing semantic tokens.
  assert.match(TONE_DISC.critical, /bg-destructive\/10 text-destructive/);
  assert.match(TONE_DISC.warning, /text-warning-text/);
  assert.match(TONE_DISC.notice, /text-info-text/);
  assert.match(TONE_DISC.quiet, /bg-muted text-muted-foreground/);
  assert.match(TONE_DISC.recovered, /text-success-text/);
});

test("the server's fields win, and a row from an older server falls back to the mirror", () => {
  // Slice P server: the row says it all, and this console does not second-guess it.
  const sent = presentDelivery(row({ event_type: "node.offline", category: "nodes", severity: "warning", recovery: false, icon: "server" }));
  assert.deepEqual([sent.category, sent.severity, sent.recovery, sent.icon], ["nodes", "warning", false, "server"]);
  // Older server: no presentation on the row, so the mirror supplies it.
  const old = presentDelivery(row({ event_type: "node.offline" }));
  assert.deepEqual([old.category, old.severity, old.recovery, old.icon, old.labelKey], ["nodes", "critical", false, "server-off", "node_offline"]);
  // A field at a time: what the server sent stays, the rest is looked up.
  const partial = presentDelivery(row({ event_type: "monitor.recovered", severity: "info" }));
  assert.deepEqual([partial.category, partial.severity, partial.recovery, partial.icon], ["monitors", "info", true, "heart-pulse"]);
  // A severity outside the closed set is not trusted; the lookup's stands.
  assert.equal(presentDelivery(row({ event_type: "ssh.login", severity: "loud" })).severity, "notice");
});

test("lookup order: exact, then the plugin pattern, then a webhook, then generic", () => {
  const plugin = presentDelivery(row({ event_type: "plugin.latticenet.sub-store.message", source: "plugin", source_id: "latticenet.sub-store" }));
  assert.deepEqual([plugin.category, plugin.icon, plugin.labelKey], ["plugins", "puzzle", "plugin_message"]);
  const webhook = presentDelivery(row({ event_type: "backup.finished", source: "webhook", source_id: "wh_backup" }));
  assert.deepEqual([webhook.category, webhook.icon, webhook.labelKey], ["webhooks", "webhook", "webhook"]);
  const unknown = presentDelivery(row({ event_type: "no.such.type" }));
  assert.deepEqual([unknown.category, unknown.severity, unknown.icon, unknown.labelKey], ["general", "info", "bell", "generic"]);
  // With the server's catalogue: its pattern, its webhook types, its own new types.
  assert.equal(catalogueMatch("plugin.latticenet.sub-store.message", SERVER).kind, "pattern");
  assert.equal(catalogueMatch("backup.finished", SERVER).kind, "webhook");
  assert.equal(catalogueMatch("backup.finished", SERVER).entry.description, "Inbound webhook nas-backup");
  // A webhook row whose type the loaded catalogue does not list (its webhook deleted since) still reads as a webhook.
  const orphan = presentDelivery(row({ event_type: "deploy.finished", source: "webhook" }), SERVER);
  assert.deepEqual([orphan.category, orphan.icon, orphan.labelKey], ["webhooks", "webhook", "webhook"]);
  assert.equal(catalogueMatch("probe.down", SERVER).kind, "exact");
  assert.equal(catalogueMatch("no.such.type", SERVER).kind, "generic");
  // The type named generic is the generic entry, not an exact match of its own.
  assert.equal(catalogueMatch("generic").kind, "generic");
  // A plugin id carries dots, so the wildcard spans segments; the fixed ones must still match.
  assert.ok(patternMatches("plugin.<id>.message", "plugin.a.b.c.message"));
  assert.ok(patternMatches("plugin.*.message", "plugin.x.message"));
  assert.ok(!patternMatches("plugin.<id>.message", "plugin.x.messages"));
  assert.ok(!patternMatches("plugin.<id>.message", "plugin..message"));
  assert.ok(!patternMatches("plugin.<id>.message", "xplugin.a.message"));
  // A host call without a plugin id sends plugin.message, which the server files under plugins too.
  assert.ok(patternMatches("plugin.<id>.message", "plugin.message"));
  assert.equal(presentDelivery(row({ event_type: "plugin.message", source: "plugin" })).category, "plugins");
  assert.equal(catalogueMatch("plugin.message", SERVER).kind, "pattern");
});

test("an icon name the console cannot draw draws bell", () => {
  assert.equal(notifyIconName("server-off"), "server-off");
  assert.equal(notifyIconName("radar"), "bell");
  assert.equal(notifyIconName(""), "bell");
  assert.equal(notifyIconName(undefined), "bell");
  // From the server's row, an unknown name is not swapped for the looked-up glyph either.
  assert.equal(presentDelivery(row({ event_type: "node.offline", icon: "skull" })).icon, "bell");
  assert.equal(presentDelivery(row({ event_type: "probe.down", category: "probes", icon: "radar" }), SERVER).icon, "bell");
});

test("the label is the console's words, then the catalogue's description, then the raw type", () => {
  const en = words(enPlatform);
  const zh = words(zhPlatform);
  assert.equal(notifyLabel(presentDelivery(row({ event_type: "node.offline" })), en), "Node offline");
  assert.equal(notifyLabel(presentDelivery(row({ event_type: "node.offline" })), zh), "节点离线");
  assert.equal(notifyLabel(presentDelivery(row({ event_type: "plugin.x.message", source: "plugin" })), en), "Plugin message");
  // A type the server knows and this console has no words for: the server's description.
  const probe = presentDelivery(row({ event_type: "probe.down", category: "probes", severity: "warning", icon: "radar" }), SERVER);
  assert.equal(notifyLabel(probe, zh), "An outbound probe failed");
  // The same row with no catalogue loaded: the lookup says generic, the server said probes,
  // so generic's words would lie and the raw type names it.
  const probeOld = presentDelivery(row({ event_type: "probe.down", category: "probes", severity: "warning" }));
  assert.equal(probeOld.labelKey, "");
  assert.equal(notifyLabel(probeOld, en), "probe.down");
  // Nothing at all: the raw type.
  assert.equal(notifyLabel({ type: "x.y", labelKey: "x_y", description: "" }, () => undefined), "x.y");
  assert.equal(notifyLabel({ type: "x.y", labelKey: "x_y", description: "Something" }, () => undefined), "Something");
});

test("every catalogue entry and category has words in both locales", () => {
  for (const messages of [enPlatform, zhPlatform]) {
    const sent = (messages as { platform: { notifications: { sent: { types: Record<string, string>; categories: Record<string, string>; tone: Record<string, string> } } } }).platform.notifications.sent;
    for (const entry of FALLBACK_CATALOGUE.types) {
      const { labelKey } = catalogueMatch(entry.type);
      assert.equal(typeof sent.types[labelKey], "string", `${entry.type} (${labelKey})`);
    }
    for (const key of ["plugin_message", "webhook", "generic"]) assert.equal(typeof sent.types[key], "string", key);
    for (const category of FALLBACK_CATEGORIES) assert.equal(typeof sent.categories[category.id], "string", category.id);
    for (const tone of ["critical", "warning", "notice", "quiet", "recovered"]) assert.equal(typeof sent.tone[tone], "string", tone);
  }
});

test("filter options from the server's catalogue: grouped in its category order, its webhook and new types included", () => {
  const groups = eventOptionGroups(SERVER);
  // A category only the server knows comes after the catalogue's own, and general stays last.
  assert.deepEqual(
    groups.map((g) => g.category),
    ["nodes", "services", "monitors", "agents", "ssh", "auth", "quota", "inventory", "notify", "webhooks", "probes", "general"],
  );
  const byCategory = Object.fromEntries(groups.map((g) => [g.category, g.options.map((o) => o.type)]));
  assert.deepEqual(byCategory.nodes, ["node.offline", "node.online"]);
  assert.deepEqual(byCategory.webhooks, ["backup.finished"]);
  assert.deepEqual(byCategory.probes, ["probe.down"]);
  assert.equal(groups.find((g) => g.category === "probes")?.label, "Probes");
  // The plugin pattern is not a type anyone can filter by; a plugin's real type joins once seen.
  assert.equal(byCategory.plugins, undefined);
  const seen = eventOptionGroups(SERVER, [row({ event_type: "plugin.latticenet.sub-store.message", source: "plugin" })]);
  assert.deepEqual(seen.find((g) => g.category === "plugins")?.options.map((o) => o.type), ["plugin.latticenet.sub-store.message"]);
  // Each option carries its glyph and tone.
  const offline = groups[0]!.options[0]!;
  assert.deepEqual([offline.icon, offline.tone, offline.labelKey], ["server-off", "critical", "node_offline"]);
});

test("filter options without a catalogue: the mirror, the types the rows carry, and the address's own", () => {
  const groups = eventOptionGroups(null, [
    row({ event_type: "plugin.latticenet.sub-store.message", source: "plugin" }),
    row({ event_type: "backup.finished", source: "webhook" }),
    row({ event_type: "node.offline" }),
  ], "no.such.type");
  const all = groups.flatMap((g) => g.options.map((o) => o.type));
  // The three the old hard-coded list missed.
  for (const type of ["agent.stalled", "agent.recovered", "generic"]) assert.ok(all.includes(type), type);
  // Offered once, never the wildcard.
  assert.equal(all.filter((type) => type === "node.offline").length, 1);
  assert.ok(!all.includes("*"));
  const byCategory = Object.fromEntries(groups.map((g) => [g.category, g.options.map((o) => o.type)]));
  assert.deepEqual(byCategory.plugins, ["plugin.latticenet.sub-store.message"]);
  assert.deepEqual(byCategory.webhooks, ["backup.finished"]);
  // A type from the address that no loaded row carries is still offered, so the select can show it.
  assert.deepEqual(byCategory.general, ["generic", "no.such.type"]);
});

test("a row's own fields place its type in the filter, so a type never reads two ways on one screen", () => {
  // A slice P server whose catalogue read failed: the row says probes and warning, the mirror knows nothing.
  const groups = eventOptionGroups(null, [row({ event_type: "probe.down", category: "probes", severity: "warning", recovery: false, icon: "radar" })]);
  const probes = groups.find((g) => g.category === "probes");
  assert.deepEqual(probes?.options.map((o) => [o.type, o.tone, o.icon, o.labelKey]), [["probe.down", "warning", "bell", ""]]);
  assert.equal(groups.find((g) => g.category === "general")?.options.some((o) => o.type === "probe.down"), false);
  assert.equal(groups.at(-1)?.category, "general");
});

test("the rule form lists what a rule can name, and shows the plugin pattern flagged as a shape", () => {
  const fallback = ruleEventGroups(null);
  assert.deepEqual(fallback.flatMap((g) => g.options.filter((o) => !o.pattern).map((o) => o.type)), CONTRACT.map(([type]) => type));
  // The pattern sits in its own category, before webhooks and general, flagged so it is never taken for a type.
  assert.deepEqual(fallback.map((g) => g.category).slice(-2), ["plugins", "general"]);
  const plugin = fallback.find((g) => g.category === "plugins")!.options;
  assert.deepEqual(plugin.map((o) => [o.type, o.pattern, o.icon, o.labelKey]), [["plugin.<id>.message", true, "puzzle", "plugin_message"]]);
  const server = ruleEventGroups(SERVER);
  const types = server.flatMap((g) => g.options.filter((o) => !o.pattern).map((o) => o.type));
  assert.ok(types.includes("backup.finished"));
  assert.ok(types.includes("probe.down"));
  assert.deepEqual(server.map((g) => g.category).slice(-4), ["plugins", "webhooks", "probes", "general"]);
});
