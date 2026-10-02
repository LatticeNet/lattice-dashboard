/**
 * Webhooks fixtures for the netplat harness (dev/netplat-webhooks.html).
 *
 * Production on 2026-09-30: 0 webhooks, 2 notify channels (Bark urgent and
 * Bark info) and 4 rules. That is the default. `?webhooks=dense` adds three
 * invented webhooks: one healthy, one whose event no rule routes, one whose
 * last call was rejected; `?channels=0` takes the channels away.
 *
 * Channel health (the notification outbox, dev/netplat-notifications.html):
 * by default Bark urgent is failing on HTTP 400 and Bark info delivers;
 * `?channels=4` adds a Telegram fallback no rule has used yet and a Discord
 * channel whose last send timed out, so every health state is on screen;
 * `?health=ok` makes every channel healthy; `?health=none` drops health, as
 * a server older than the outbox answers.
 */
import type { NotifyChannelView, NotifyRuleView, NotifyWebhookDelivery, NotifyWebhookView } from "@/lib/api/index";

import { DAY, HOUR, MINUTE, flags, iso } from "./netplatFixture";

const HEALTH_FAILING = {
  state: "failing",
  last_attempt_at: iso(-4 * MINUTE),
  last_ok_at: iso(-2 * DAY - 3 * HOUR),
  last_failure_at: iso(-4 * MINUTE),
  last_failure_kind: "upstream_4xx",
  last_status_code: 400,
  consecutive_failures: 4,
  failing_since: iso(-38 * MINUTE),
};
const HEALTH_OK = (ago: number) => ({ state: "ok", last_attempt_at: iso(-ago), last_ok_at: iso(-ago), consecutive_failures: 0 });

function health(id: string): NotifyChannelView["health"] {
  if (flags.get("health") === "none") return undefined;
  if (flags.get("health") === "ok") return HEALTH_OK(3 * MINUTE);
  switch (id) {
    case "ch_bark_urgent":
      return { ...HEALTH_FAILING };
    case "ch_tg_fallback":
      return { state: "unknown", consecutive_failures: 0 };
    case "ch_discord":
      return { state: "degraded", last_attempt_at: iso(-2 * MINUTE), last_ok_at: iso(-3 * HOUR), last_failure_at: iso(-2 * MINUTE), last_failure_kind: "timeout", consecutive_failures: 0, failing_since: iso(-2 * MINUTE) };
    default:
      return HEALTH_OK(3 * MINUTE);
  }
}

const baseChannels: NotifyChannelView[] = [
  { id: "ch_bark_urgent", name: "Bark urgent", kind: "bark", config_keys: ["device_key", "server"], enabled: true, created_at: iso(-90 * DAY), updated_at: iso(-30 * DAY) },
  { id: "ch_bark_info", name: "Bark info", kind: "bark", config_keys: ["device_key", "server"], enabled: true, created_at: iso(-90 * DAY), updated_at: iso(-30 * DAY) },
];
const extraChannels: NotifyChannelView[] = [
  { id: "ch_tg_fallback", name: "Telegram fallback (official relay, second device key for the weekend rotation)", kind: "telegram", config_keys: ["chat_id", "token"], enabled: true, created_at: iso(-2 * DAY), updated_at: iso(-2 * DAY) },
  { id: "ch_discord", name: "war-room-discord", kind: "discord", config_keys: ["webhook_url"], enabled: true, created_at: iso(-20 * DAY), updated_at: iso(-20 * DAY) },
];

export const NOTIFY_CHANNELS: NotifyChannelView[] =
  flags.get("channels") === "0"
    ? []
    : [...baseChannels, ...(flags.get("channels") === "4" ? extraChannels : [])].map((channel) => ({ ...channel, health: health(channel.id) }));

export const NOTIFY_RULES: NotifyRuleView[] = [
  { id: "rule_offline", name: "Node offline", event_types: ["node.offline"], channel_ids: ["ch_bark_urgent"], enabled: true, created_at: iso(-90 * DAY), updated_at: iso(-20 * DAY), fallback_channel_id: flags.get("channels") === "4" ? "ch_tg_fallback" : undefined },
  { id: "rule_expiry", name: "Machine renewals", event_types: ["inventory.renewal"], channel_ids: ["ch_bark_info"], enabled: true, created_at: iso(-60 * DAY), updated_at: iso(-20 * DAY) },
  { id: "rule_quota", name: "VPN quota and expiry", event_types: ["proxy.quota", "proxy.expiry"], channel_ids: ["ch_bark_info"], enabled: true, created_at: iso(-60 * DAY), updated_at: iso(-20 * DAY) },
  { id: "rule_backup", name: "Backups", event_types: ["backup.finished"], channel_ids: ["ch_bark_info"], enabled: true, created_at: iso(-30 * DAY), updated_at: iso(-10 * DAY) },
];

export const WEBHOOKS: NotifyWebhookView[] =
  flags.get("webhooks") === "dense"
    ? [
        { id: "wh_backup", name: "nas backup", event_type: "backup.finished", title_template: "Backup of {{data.host}}", body_template: "{{data.detail}}", enabled: true, path: "/hooks/wh_backup", last_used_at: iso(-6 * HOUR), created_at: iso(-30 * DAY), updated_at: iso(-30 * DAY) },
        { id: "wh_deploy", name: "site deploy", event_type: "deploy.finished", title_template: "Deployed {{data.site}}", enabled: true, path: "/hooks/wh_deploy", last_used_at: iso(-2 * DAY), created_at: iso(-12 * DAY), updated_at: iso(-12 * DAY) },
        { id: "wh_cert", name: "cert renew", event_type: "cert.renewed", title_template: "Renewed {{data.domain}}", enabled: true, path: "/hooks/wh_cert", last_used_at: iso(-40 * MINUTE), created_at: iso(-5 * DAY), updated_at: iso(-5 * DAY) },
      ]
    : [];

export function deliveriesFor(id: string): NotifyWebhookDelivery[] {
  if (id === "wh_backup") {
    return [0, 1, 2].map((index) => ({ id: `dl_${id}_${index}`, webhook_id: id, event_type: "backup.finished", outcome: "accepted", title: "Backup of nas-home", source_ip: "203.0.113.25", fields: 2, bytes: 88, channels: 1, delivered: 1, created_at: iso(-(6 + index * 24) * HOUR) }));
  }
  if (id === "wh_deploy") {
    return [{ id: `dl_${id}_0`, webhook_id: id, event_type: "deploy.finished", outcome: "no_route", reason: "no enabled rule matches deploy.finished", title: "Deployed docs", source_ip: "198.51.100.40", fields: 1, bytes: 40, channels: 0, delivered: 0, created_at: iso(-2 * DAY) }];
  }
  if (id === "wh_cert") {
    return [{ id: `dl_${id}_0`, webhook_id: id, outcome: "rejected", reason: "signature mismatch", source_ip: "198.51.100.77", fields: 0, bytes: 0, channels: 0, delivered: 0, created_at: iso(-40 * MINUTE) }];
  }
  return [];
}
