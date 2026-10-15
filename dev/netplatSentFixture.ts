/**
 * Sent log fixtures for the netplat harness (dev/netplat-notifications.html,
 * `?view=sent`): the server's notification outbox as the console reads it.
 *
 * The default is the production routing on a bad night: Bark urgent refuses
 * with HTTP 400, so node.offline pages fail and the rule's fallback (with
 * `?channels=4`) carries them, notify.channel_failing goes to Bark info, a
 * Bark 502 is being retried, an inbound webhook's event reaches no rule, a
 * plugin message goes everywhere (one long enough that the server cut it), an
 * unrouted ssh.login folded 37 repeats into one row, and a restart redrove
 * one page.
 *
 *   ?sent=empty    the outbox holds nothing
 *   ?sent=memory   the server runs without the bolt hot store (history is memory only)
 *   ?sent=many     620 rows, so the log shows the newest 500 of them
 *   ?sent=slow     the deliveries read answers after 4 s, to see the table loading
 *   ?sent=incidents adds what keepalive incidents leave in the log: an open
 *                  message a maintenance window held, one flap damping held,
 *                  one quiet hours hold until morning, an escalation re-sent
 *                  at Bark level critical, and an offline page and its
 *                  recovery that quiet hours held and withdrew at their end
 *   ?fail=sent     the deliveries read answers 502
 *   ?test=ok       a stored-channel test of Bark urgent succeeds (it fails by default)
 *
 * Presentation (slice P, design-notify-abstraction 13): the default rows
 * cover every tone (critical, warning, notice, quiet, recovered), a title
 * long enough to wrap, a type nobody catalogued, a type only the server's
 * catalogue knows (probe.down, whose radar glyph the console cannot draw), a
 * plugin type and two webhook types. By default every other row carries the
 * server's category, severity, recovery and icon and the rest carry none, so
 * one page shows both paths drawing the same disc.
 *
 *   ?server=new       every row carries the four fields (a slice P server)
 *   ?server=old       no row carries them and the catalogue answers 404 (a server before slice P)
 *   ?fail=catalogue   the catalogue read answers 502; the console falls back to its mirror
 */
import { ApiError } from "@/lib/api/client";
import type { NotifyAttempt, NotifyCatalogueResponse, NotifyChannelTestResponse, NotifyDeliveriesQuery, NotifyDeliveriesResponse, NotifyDelivery } from "@/lib/api/index";
import { FALLBACK_CATALOGUE, catalogueMatch } from "@/views/platform/notifyCatalogueModel";

import { MINUTE, delay, flags, iso } from "./netplatFixture";
import { NOTIFY_CHANNELS } from "./netplatWebhooksFixture";

let seq = 1;

function attempt(agoMs: number, ok: boolean, kind?: string, status?: number, ms = 180): NotifyAttempt {
  return { at: iso(-agoMs), ok, kind, status, duration_ms: ms };
}

function row(over: Partial<NotifyDelivery> & Pick<NotifyDelivery, "event_type" | "outcome">, agoMs: number): NotifyDelivery {
  const channel = NOTIFY_CHANNELS.find((c) => c.id === over.channel_id);
  return {
    id: `nd_fixture_${seq++}`,
    event_id: over.event_id ?? `evt_fixture_${seq}`,
    source: "server",
    role: "primary",
    channel_name: channel?.name ?? over.channel_name,
    channel_kind: channel?.kind ?? over.channel_kind,
    created_at: iso(-agoMs),
    settled_at: over.outcome === "planned" ? undefined : iso(-agoMs + 2000),
    ...over,
  };
}

const withFallback = flags.get("channels") === "4";
const offlineBody =
  "[Metix]-DMIT-4 (node_dmit4): no heartbeat since 2026-10-02T08:31:02Z, 10 minutes past its alert delay.\n[cd]-gomami-jpn-pulse-nano (node_gomami): no heartbeat since 2026-10-02T08:31:40Z.\n[cd]-huoshan-shanghai (node_huoshan): no heartbeat since 2026-10-02T08:32:05Z.";

function fixtureRows(): NotifyDelivery[] {
  const rows: NotifyDelivery[] = [
    row({ event_type: "node.offline", channel_id: "ch_bark_urgent", rule_id: "rule_offline", rule_name: "Node offline", outcome: "failed", reason: "upstream status 400", title: "Lattice nodes offline: 3 (DMIT-4, gomami-jpn-pulse-nano, huoshan-shanghai)", body: offlineBody, event_id: "evt_off_1", attempts: [attempt(4 * MINUTE, false, "upstream_4xx", 400)] }, 4 * MINUTE),
    ...(withFallback
      ? [row({ event_type: "node.offline", channel_id: "ch_tg_fallback", rule_id: "rule_offline", rule_name: "Node offline", role: "fallback", fallback_for: "Bark urgent", outcome: "sent", title: "Lattice nodes offline: 3 (DMIT-4, gomami-jpn-pulse-nano, huoshan-shanghai)", body: offlineBody + "\n\nSent through the fallback channel because Bark urgent did not deliver it.", event_id: "evt_off_1", attempts: [attempt(4 * MINUTE - 900, true, undefined, undefined, 640)] }, 4 * MINUTE - 800)]
      : []),
    ...(withFallback
      ? [row({ event_type: "service.down", channel_id: "ch_tg_fallback", rule_id: "rule_offline", rule_name: "Node offline", role: "fallback", fallback_for: "Bark urgent", fallback_of: "nd_fixture_service_down", outcome: "sent", event_id: "evt_svc_1", title: "sing-box failed on [cd]-LegendVPS-SG-EVO", body: "[cd]-LegendVPS-SG-EVO (node_sg): sing-box has been failed since 2026-10-02T09:01:12Z (unit failed/failed, restarts 3).\n\nSent through the fallback channel because Bark urgent failed to deliver this critical alert and is still retrying.", attempts: [attempt(49_500, true, undefined, undefined, 520)] }, 49_800)]
      : []),
    row({ id: "nd_fixture_service_down", event_id: "evt_svc_1", event_type: "service.down", channel_id: "ch_bark_urgent", rule_id: "rule_offline", rule_name: "Node offline", outcome: "planned", reason: "upstream status 502 after 2 attempts, retrying", title: "sing-box failed on [cd]-LegendVPS-SG-EVO", body: "[cd]-LegendVPS-SG-EVO (node_sg): sing-box has been failed since 2026-10-02T09:01:12Z (unit failed/failed, restarts 3).", attempts: [attempt(50_000, false, "upstream_5xx", 502), attempt(45_000, false, "upstream_5xx", 502)], next_attempt_at: iso(15_000) }, 51_000),
    row({ event_type: "notify.channel_failing", channel_id: "ch_bark_info", outcome: "sent", title: "Lattice notification channel failing: Bark urgent", body: "Bark urgent (bark) has failed 3 deliveries in a row since 2026-10-02T08:30:00Z: the endpoint refused it (HTTP 400); the key, token or chat id is likely wrong. Alerts routed only to it are not arriving. Check its settings, then send a test from Notifications.", attempts: [attempt(12 * MINUTE, true)] }, 12 * MINUTE),
    row({ event_type: "node.offline", channel_id: "ch_bark_urgent", rule_id: "rule_offline", rule_name: "Node offline", outcome: "failed", reason: "upstream status 400", title: "Lattice node offline: [cd]-mkcloud-hr-iplc", body: "[cd]-mkcloud-hr-iplc (node_hr): no heartbeat since 2026-10-02T08:20:00Z.", attempts: [attempt(13 * MINUTE, false, "upstream_4xx", 400)] }, 13 * MINUTE),
    row({ event_type: "notify.test", source: "operator", role: "test", channel_id: "ch_bark_urgent", outcome: "failed", reason: "upstream status 400", title: "Lattice test", body: "Test message for the bark channel \"Bark urgent\", sent from Notifications at 2026-10-02T08:52:00Z. If you can read this, the channel works.", attempts: [attempt(20 * MINUTE, false, "upstream_4xx", 400, 310)] }, 20 * MINUTE),
    row({ event_type: "backup.finished", source: "webhook", source_id: "wh_backup", outcome: "no_route", reason: "no enabled rule routes this event type", title: "Backup of nas-home finished" }, 26 * MINUTE),
    row({ event_type: "ssh.login", outcome: "no_route", reason: "no enabled rule routes this event type", title: "SSH login on [Metix]-DMIT-1", body: "deploy from 203.0.113.61 (publickey)", repeats: 36, last_seen_at: iso(-2 * MINUTE) }, 47 * MINUTE),
    row({ event_type: "plugin.latticenet.sub-store.message", source: "plugin", source_id: "latticenet.sub-store", channel_id: "ch_bark_info", outcome: "sent", title: "Sub-Store sync failed for 2 of 14 subscriptions", body: "upstream answered 503 for airport-a and airport-b; the previous artifacts stay published.", attempts: [attempt(31 * MINUTE, true)] }, 31 * MINUTE),
    row({ event_type: "plugin.latticenet.sub-store.message", source: "plugin", source_id: "latticenet.sub-store", channel_id: "ch_bark_info", outcome: "sent", truncated: true, title: "Sub-Store conversion report for 14 subscriptions", body: Array.from({ length: 60 }, (_, i) => `airport-${String(i + 1).padStart(2, "0")}: 42 nodes kept, 3 dropped by the region filter, 1 renamed`).join("\n").slice(0, 4084) + " [truncated]", attempts: [attempt(33 * MINUTE, true)] }, 33 * MINUTE),
    row({ event_type: "node.offline", channel_id: "ch_bark_urgent", rule_id: "rule_offline", rule_name: "Node offline", outcome: "sent", reason: "redriven after restart", redriven: true, title: "Lattice node offline: [cd]-xuezhang-jp-NAT", body: "[cd]-xuezhang-jp-NAT (node_xjp): no heartbeat since 2026-10-02T06:40:00Z.", attempts: [attempt(2 * 60 * MINUTE, true, undefined, undefined, 420)] }, 2 * 60 * MINUTE + 30_000),
    row({ event_type: "ssh.login", channel_id: "ch_bark_info", rule_id: "rule_quota", rule_name: "VPN quota and expiry", outcome: "sent", title: "SSH login on [Metix]-DMIT-1", body: "root from 203.0.113.44 (publickey)", attempts: [attempt(3 * 60 * MINUTE, true)] }, 3 * 60 * MINUTE),
    row({ event_type: "inventory.renewal", channel_id: "ch_bark_info", rule_id: "rule_expiry", rule_name: "Machine renewals", outcome: "sent", title: "Lattice renewal: [cd]-Akkocloud-UK-London-KVM renews in 3 days (2026-10-05)", body: "Renews 2026-10-05 at 9.99 USD per month.", attempts: [attempt(9 * 60 * MINUTE, true)] }, 9 * 60 * MINUTE),
    row({ event_type: "proxy.quota", channel_id: "ch_bark_info", rule_id: "rule_quota", rule_name: "VPN quota and expiry", outcome: "failed", reason: "channel deleted before delivery", title: "Lattice proxy quota: alice at 92%" }, 26 * 60 * MINUTE),
    // Slice P: one row per tone the default list lacked, a wrapping title, and types the console does not know.
    row({ event_type: "ssh.compromise_suspected", channel_id: "ch_bark_urgent", rule_id: "rule_offline", rule_name: "Node offline", outcome: "sent", title: "SSH login after repeated failures on [Metix]-DMIT-1: root from 198.51.100.23 after 41 failed attempts in 6 minutes, the same address that set off the pressure window on [cd]-LegendVPS-SG-EVO and [cd]-hetzner-hel earlier tonight", body: "root logged in with a password from 198.51.100.23 (AS64500) at 2026-10-15T08:58:12Z. SSH Guard recorded 41 failures from it in the 6 minutes before.", attempts: [attempt(2 * MINUTE + 10_000, true, undefined, undefined, 260)] }, 2 * MINUTE + 12_000),
    row({ event_type: "monitor.down", channel_id: "ch_bark_info", rule_id: "rule_monitor", rule_name: "Monitors", outcome: "sent", title: "Monitor down: HK relay port on [cd]-hetzner-fsn", body: "tcp 203.0.113.80:443 refused 3 checks in a row.", attempts: [attempt(6 * MINUTE, true)] }, 6 * MINUTE),
    row({ event_type: "monitor.recovered", channel_id: "ch_bark_info", rule_id: "rule_monitor", rule_name: "Monitors", outcome: "sent", title: "Monitor recovered: HK relay port on [cd]-hetzner-fsn", body: "Up again after 4 min.", attempts: [attempt(2 * MINUTE, true)] }, 2 * MINUTE),
    row({ event_type: "agent.stalled", channel_id: "ch_bark_info", outcome: "sent", title: "Agent stalled on [cd]-bandwagon-dc6", body: "lattice-agent has not finished a poll in 7 minutes; its last task was a sing-box reload.", attempts: [attempt(15 * MINUTE, true)] }, 15 * MINUTE),
    row({ event_type: "agent.recovered", channel_id: "ch_bark_info", outcome: "sent", title: "Agent recovered on [cd]-bandwagon-dc6", attempts: [attempt(9 * MINUTE, true)] }, 9 * MINUTE),
    row({ event_type: "node.online", channel_id: "ch_bark_urgent", rule_id: "rule_offline", rule_name: "Node offline", outcome: "sent", title: "Lattice node online: [cd]-mkcloud-hr-iplc", body: "[cd]-mkcloud-hr-iplc (node_hr) is back after 18 min.", attempts: [attempt(60 * MINUTE, true)] }, 60 * MINUTE),
    row({ event_type: "probe.down", channel_id: "ch_bark_info", outcome: "sent", title: "Outbound probe failed: hk-relay via [cd]-LegendVPS-SG-EVO", body: "3 of 3 probes timed out after 5 s.", attempts: [attempt(38 * MINUTE, true)] }, 38 * MINUTE),
    row({ event_type: "cluster.rebalanced", channel_id: "ch_bark_info", outcome: "sent", title: "Something the console has never heard of", attempts: [attempt(4 * 60 * MINUTE, true)] }, 4 * 60 * MINUTE),
    row({ event_type: "generic", channel_id: "ch_bark_info", outcome: "sent", title: "Lattice: disk usage 91% on lattice-control", attempts: [attempt(5 * 60 * MINUTE, true)] }, 5 * 60 * MINUTE),
    row({ event_type: "deploy.finished", source: "webhook", source_id: "wh_deploy", source_ref: "dl_wh_deploy_0", channel_id: "ch_bark_info", rule_id: "rule_backup", rule_name: "Backups", outcome: "sent", title: "Deployed docs.example.org", attempts: [attempt(70 * MINUTE, true)] }, 70 * MINUTE),
  ];
  if (flags.get("sent") === "incidents") {
    const until = new Date(Date.now() + 40 * MINUTE).toISOString().replace(/\.\d{3}Z$/, "Z");
    const morning = new Date(Date.now() + 7 * 60 * MINUTE).toISOString().replace(/\.\d{3}Z$/, "Z");
    rows.push(
      row({ event_type: "service.down", source_id: "inc_svc_hel", outcome: "suppressed", reason: `held by maintenance window "Kernel upgrade" until ${until}`, title: "sing-box inactive on [cd]-hetzner-hel", body: "[cd]-hetzner-hel (node_hel): sing-box has been inactive since 2026-10-03T09:41:00Z." }, 7 * MINUTE),
      row({ event_type: "node.offline", source_id: "inc_off_mac", outcome: "suppressed", reason: "flapping (5 reopenings within 30m), at most one message an hour", title: "Lattice node offline: [cd]-mac-air" }, 18 * MINUTE),
      row({ event_type: "monitor.down", channel_id: "ch_bark_info", rule_id: "rule_quota", rule_name: "VPN quota and expiry", outcome: "planned", held_until: morning, title: "Monitor down: HK relay port on [cd]-hetzner-fsn" }, 3 * MINUTE),
      row({ event_type: "service.down", channel_id: "ch_bark_urgent", rule_id: "rule_offline", rule_name: "Node offline", outcome: "sent", bark_level: "critical", title: "sing-box inactive on [cd]-bandwagon-dc6", attempts: [attempt(11 * MINUTE, true)] }, 11 * MINUTE),
      row({ event_type: "node.offline", channel_id: "ch_bark_info", rule_id: "rule_quota", rule_name: "VPN quota and expiry", outcome: "suppressed", held_until: iso(-5 * 60 * MINUTE), settled_at: iso(-5 * 60 * MINUTE), reason: "withdrawn when quiet hours ended: the incident was resolved, acknowledged or snoozed meanwhile", title: "Lattice node offline: [cd]-xuezhang-jp-NAT", body: "[cd]-xuezhang-jp-NAT (node_xjp): no heartbeat since 2026-10-03T01:12:00Z.", incident_ids: ["inc_off_xjp"] }, 8 * 60 * MINUTE),
      row({ event_type: "node.online", channel_id: "ch_bark_info", rule_id: "rule_quota", rule_name: "VPN quota and expiry", outcome: "suppressed", held_until: iso(-5 * 60 * MINUTE), settled_at: iso(-5 * 60 * MINUTE), reason: "withdrawn when quiet hours ended: the open message it answers was withdrawn too", title: "Lattice node online: [cd]-xuezhang-jp-NAT", body: "[cd]-xuezhang-jp-NAT (node_xjp) is back after 41 min.", incident_ids: ["inc_off_xjp"] }, 7 * 60 * MINUTE),
      // A recovery kept from a rule that never sent the open message it answers (lattice-server
      // notifyWithheldRecovery): one row per rule, no channel, naming the incidents left out.
      row({ event_type: "node.online", rule_id: "rule_quota", rule_name: "VPN quota and expiry", outcome: "suppressed", reason: "withheld: the open message it answers never reached this rule", title: "Lattice node online: [cd]-cloudcone-la", body: "[cd]-cloudcone-la (node_cla) is reporting again after 4m.", incident_ids: ["inc_off_cla"] }, 9 * MINUTE),
    );
  }
  if (flags.get("sent") === "many") {
    for (let i = 0; i < 608; i += 1) {
      rows.push(row({ event_type: i % 3 ? "ssh.login" : "monitor.recovered", channel_id: "ch_bark_info", outcome: "sent", title: `SSH login on node ${i}`, attempts: [attempt((30 + i) * 60 * MINUTE, true)] }, (30 + i) * 60 * MINUTE));
    }
  }
  return rows;
}

// Newest first, as the server returns them.
const ROWS: NotifyDelivery[] = flags.get("sent") === "empty" ? [] : fixtureRows().sort((a, b) => b.created_at.localeCompare(a.created_at));

/**
 * What a slice P server's catalogue answers: the contract's table, a type
 * newer than this console (probe.down, in a category the console has no
 * words for, with a glyph it cannot draw) and the operator's webhook types.
 */
const SERVER_CATALOGUE: NotifyCatalogueResponse = {
  categories: [...FALLBACK_CATALOGUE.categories, { id: "probes", label: "Probes" }],
  types: [
    ...FALLBACK_CATALOGUE.types,
    { type: "probe.down", category: "probes", severity: "warning", recovery: false, icon: "radar", description: "An outbound probe failed" },
  ],
  patterns: FALLBACK_CATALOGUE.patterns,
  webhook_types: [
    { type: "backup.finished", category: "webhooks", severity: "info", recovery: false, icon: "webhook", description: "Inbound webhook nas backup" },
    { type: "deploy.finished", category: "webhooks", severity: "info", recovery: false, icon: "webhook", description: "Inbound webhook site deploy" },
  ],
};

const SERVER_MODE = flags.get("server");

/** The catalogue read: 404 from a server before slice P. */
export function cataloguePage(): Promise<NotifyCatalogueResponse> {
  if (SERVER_MODE === "old") return delay(undefined).then(() => Promise.reject(new ApiError(404, "not_found", "not found")));
  return delay(structuredClone(SERVER_CATALOGUE));
}

/**
 * The four fields the server computes from event_type at read time
 * (lattice-server notify_catalogue.go); here the same lookup over the
 * fixture catalogue. Which rows carry them follows ?server (see the header).
 */
function presented(delivery: NotifyDelivery, index: number): NotifyDelivery {
  const carries = SERVER_MODE === "new" || (SERVER_MODE !== "old" && index % 2 === 0);
  if (!carries) return delivery;
  const { entry } = catalogueMatch(delivery.event_type, SERVER_CATALOGUE, { webhook: delivery.source === "webhook" });
  return { ...delivery, category: entry.category, severity: entry.severity, recovery: entry.recovery, icon: entry.icon };
}

export function sentPage(query: NotifyDeliveriesQuery): NotifyDeliveriesResponse {
  const limit = query.limit ?? 500;
  const deliveries = ROWS.filter(
    (d) =>
      (!query.outcome || d.outcome === query.outcome) &&
      (!query.channel_id || d.channel_id === query.channel_id) &&
      (!query.event_type || d.event_type === query.event_type),
  ).slice(0, limit);
  return {
    deliveries: deliveries.map((d) => presented({ ...d, attempts: d.attempts?.map((a) => ({ ...a })) }, ROWS.indexOf(d))),
    stored: ROWS.length,
    durable: flags.get("sent") !== "memory",
    max: 1000,
    floor: 50,
  };
}

/**
 * A stored-channel test: Bark urgent refuses (HTTP 400) unless `?test=ok`,
 * every other channel delivers. The channel's health moves the way the
 * server's does: a pass clears a failing channel, a failure only updates the
 * last failure and never starts the failing window.
 */
export function testStoredChannel(id: string): NotifyChannelTestResponse {
  const channel = NOTIFY_CHANNELS.find((c) => c.id === id);
  const ok = id !== "ch_bark_urgent" || flags.get("test") === "ok";
  const at = iso(0);
  const delivery = row(
    {
      event_type: "notify.test",
      source: "operator",
      role: "test",
      channel_id: id,
      outcome: ok ? "sent" : "failed",
      reason: ok ? undefined : "upstream status 400",
      title: "Lattice test",
      body: `Test message for the ${channel?.kind ?? "bark"} channel "${channel?.name ?? id}", sent from Notifications at ${at}. If you can read this, the channel works.`,
      attempts: [ok ? attempt(0, true, undefined, undefined, 290) : attempt(0, false, "upstream_4xx", 400, 310)],
    },
    0,
  );
  ROWS.unshift(delivery);
  const prev = channel?.health ?? { state: "unknown", consecutive_failures: 0 };
  const health = ok
    ? { state: "ok", last_attempt_at: at, last_ok_at: at, consecutive_failures: 0 }
    : { ...prev, state: prev.state === "failing" ? "failing" : "degraded", last_attempt_at: at, last_failure_at: at, last_failure_kind: "upstream_4xx", last_status_code: 400 };
  if (channel) channel.health = health;
  return { ok, delivery, health };
}
