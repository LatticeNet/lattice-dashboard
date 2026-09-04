/**
 * An in-memory stand-in for `@/lib/api`, wired in by vite.harness.config.ts
 * through a resolve alias so the production config and bundle never see it.
 *
 *   LATTICE_HARNESS=notifications pnpm exec vite --config vite.harness.config.ts
 *   open http://127.0.0.1:5185/dev/notifications.html
 *
 * Everything the real barrel exports is re-exported unchanged; only `api` is
 * replaced, and only the calls NotificationsView makes are implemented.
 * Anything else throws, loudly, so a new call path is noticed rather than
 * silently fed nothing.
 *
 * The channel upsert validates the way lattice-server's buildChannel does:
 * a Bark level outside the accepted set answers 400 with the server's own
 * message, and the stored config is replaced whole, so config_keys after a
 * save show exactly what the console sent.
 */
import { ApiError } from "@/lib/api/client";
import type {
  NotifyChannelUpsertRequest,
  NotifyChannelView,
  NotifyRuleUpsertRequest,
  NotifyRuleView,
  NotifyTestRequest,
  Principal,
} from "@/lib/api/index";

export * from "@/lib/api/index";

const NOW = Date.now();
const LATENCY_MS = 120;
const DAY = 86_400_000;
const BARK_LEVELS = ["active", "timeSensitive", "passive", "critical"];

function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function delay<T>(value: T, ms = LATENCY_MS): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

const principal: Principal = {
  actor_id: "cdcd",
  username: "cdcd",
  scopes: ["notify:send", "node:read"],
  server_allowlist: [],
  csrf_token: "harness",
};

interface StoredChannel extends NotifyChannelView {
  config: Record<string, string>;
}

function channel(
  id: string,
  name: string,
  kind: string,
  config: Record<string, string>,
  enabled: boolean,
  ageMs: number,
): StoredChannel {
  return {
    id,
    name,
    kind,
    config,
    config_keys: Object.keys(config),
    enabled,
    created_at: iso(-ageMs - 3 * DAY),
    updated_at: iso(-ageMs),
  };
}

const channels: StoredChannel[] = [
  // Saved before level, group and url existed: base_url and key only.
  channel("nch_bark_cdcd", "phone-cdcd", "bark", { base_url: "https://api.day.app", key: "redacted" }, true, 41 * DAY),
  channel(
    "nch_bark_oncall",
    "phone-oncall-weekend",
    "bark",
    { base_url: "https://bark.lattice.example", key: "redacted", level: "timeSensitive", group: "fleet / oncall / weekend rotation (2026-09, europe-west, backup pager)", url: "https://lattice.example/alerts" },
    true,
    2 * DAY,
  ),
  channel("nch_tg_ops", "ops-alerts", "telegram", { token: "redacted", chat_id: "-1001234567890" }, true, 12 * DAY),
  channel("nch_discord", "war-room-discord", "discord", { webhook_url: "redacted" }, false, 90 * DAY),
];

const rules: NotifyRuleView[] = [
  {
    id: "nrl_monitor_phone",
    name: "monitor-to-phone",
    event_types: ["monitor.down", "monitor.recovered"],
    channel_ids: ["nch_bark_cdcd", "nch_bark_oncall"],
    title_template: "{{event_type}}: {{title}}",
    body_template: "{{body}}",
    enabled: true,
    created_at: iso(-30 * DAY),
    updated_at: iso(-30 * DAY),
  },
];

let seq = 1;

function view(c: StoredChannel): NotifyChannelView {
  const { config: _config, ...rest } = c;
  return { ...rest, config_keys: Object.keys(c.config) };
}

function validateBark(config: Record<string, string>): void {
  if (!config.base_url || !config.key) {
    throw new ApiError(400, "bad_request", "bark requires config.base_url and config.key");
  }
  const level = config.level ?? "";
  if (level !== "" && !BARK_LEVELS.includes(level)) {
    throw new ApiError(400, "bad_request", `bark config.level must be one of ${BARK_LEVELS.join(", ")}`);
  }
}

const unimplemented = new Proxy(
  {},
  {
    get(_target, prop) {
      return () => Promise.reject(new Error(`fake api: ${String(prop)} is not implemented in the harness`));
    },
  },
);

export const api = {
  auth: {
    me: () => delay(principal),
  },
  notify: {
    channels: () => delay(channels.map(view)),
    upsertChannel: async (input: NotifyChannelUpsertRequest) => {
      await delay(undefined);
      if (input.kind === "bark") validateBark(input.config);
      const existing = channels.find((c) => c.id === input.id);
      if (existing) {
        existing.name = input.name;
        existing.kind = input.kind;
        existing.config = { ...input.config };
        existing.config_keys = Object.keys(existing.config);
        existing.enabled = input.enabled ?? existing.enabled;
        existing.updated_at = iso(0);
        return view(existing);
      }
      const created = channel(`nch_new_${seq++}`, input.name, input.kind, { ...input.config }, input.enabled ?? true, 0);
      channels.push(created);
      return view(created);
    },
    deleteChannel: async (id: string) => {
      await delay(undefined);
      const at = channels.findIndex((c) => c.id === id);
      if (at < 0) throw new ApiError(404, "not_found", "channel not found");
      channels.splice(at, 1);
      return { ok: true };
    },
    test: async (input: NotifyTestRequest) => {
      await delay(undefined, 400);
      if (input.channel === "bark") validateBark(input.config);
      if (/unreachable/.test(input.config.base_url ?? "")) {
        throw new ApiError(502, "upstream", "bark: POST https://unreachable.example/push: dial tcp: connection refused");
      }
      return { ok: true, channel: input.channel };
    },
    rules: () => delay({ rules: rules.map((r) => ({ ...r })) }),
    upsertRule: async (input: NotifyRuleUpsertRequest) => {
      await delay(undefined);
      const existing = rules.find((r) => r.id === input.id);
      const next: NotifyRuleView = {
        id: existing?.id ?? `nrl_new_${seq++}`,
        name: input.name,
        event_types: input.event_types,
        channel_ids: input.channel_ids,
        title_template: input.title_template,
        body_template: input.body_template,
        enabled: input.enabled ?? true,
        created_at: existing?.created_at ?? iso(0),
        updated_at: iso(0),
      };
      if (existing) Object.assign(existing, next);
      else rules.push(next);
      return { ...next };
    },
    deleteRule: async (id: string) => {
      await delay(undefined);
      const at = rules.findIndex((r) => r.id === id);
      if (at < 0) throw new ApiError(404, "not_found", "rule not found");
      rules.splice(at, 1);
      return { ok: true };
    },
  },
  nodes: unimplemented,
  approvals: unimplemented,
  security: unimplemented,
};
