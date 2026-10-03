<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { useOwnedRoute } from "@/composables/useOwnedRoute";
import { toast } from "@/lib/toast";
import {
  Bell,
  CalendarClock,
  CornerDownRight,
  GitBranch,
  Moon,
  TriangleAlert,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  Unplug,
} from "lucide-vue-next";
import {
  api,
  unwrap,
  type MachineView,
  type Node,
  type NotifyChannelUpsertRequest,
  type NotifyChannelView,
  type NotifyDelivery,
  type NotifyKind,
  type NotifyRuleUpsertRequest,
  type NotifyRuleView,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { formatDay } from "@/views/fleet/inventoryEditorModel";
import { reminderCoverage, reminderMachineName, ruleRoutesRenewals } from "@/views/fleet/reminderModel";
import {
  DEFAULT_OFFLINE_MINUTES,
  formatOfflineDelay,
  nodeOfflinePolicy,
  ruleRoutesNodeOffline,
} from "@/views/platform/nodeOfflineModel";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  buildConfig as buildConfigFor,
  channelDeleteImpact as channelDeleteImpactFor,
  channelHealthLine,
  channelSaveGate,
  configComplete as configCompleteFor,
  failingChannels,
  fallbackChoices,
  fallbackForSave,
  type FailureCause,
  type HealthLine,
  fromSelectValue,
  KIND_FIELDS,
  KIND_OPTIONS,
  SELECT_DEFAULT,
  toSelectValue,
  type FieldDef,
  BARK_LEVELS,
  ESCALATE_MAX_MINUTES,
  ESCALATE_MIN_MINUTES,
  ruleIncidentDraft,
  ruleIncidentErrors,
  ruleIncidentRequest,
  ruleIncidentSummary,
  type RuleIncidentDraft,
} from "./notificationsModel";
import {
  parseSentOutcome,
  SENT_LIMIT,
  SENT_OUTCOMES,
  sentCause,
  sentEventChoices,
  sentNote,
  sentOccurrences,
  sentQuery,
  sentState,
  sentTone,
  type SentOutcomeFilter,
} from "./notifySentModel";
import {
  channelFallbackChoices,
  channelFallbackForSave,
  witnessAttention,
  type WitnessAttention,
} from "./witnessModel";
import NotificationsWitnessCard from "./NotificationsWitnessCard.vue";
import { useLayer } from "@/composables/useLayer";
import { writeLayer } from "@/composables/layerModel";
import type { QueryRecord } from "@/components/common/tableUrlState";
import { useQueryParam } from "@/composables/useQueryParam";
import { useRouteOpen } from "@/composables/useRouteOpen";

import PageHeader from "@/components/common/PageHeader.vue";
import AttentionList, { type AttentionItem } from "@/components/common/AttentionList.vue";
import LayerTabs, { type LayerTab } from "@/components/common/LayerTabs.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import ProofLine, { type ProofSegment } from "@/components/common/ProofLine.vue";
import RowMenu, { type RowMenuItem } from "@/components/common/RowMenu.vue";
import { useProof } from "@/composables/useProof";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import ObjectSheet from "@/components/common/ObjectSheet.vue";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from "@/components/ui/dialog";

type RulePreset = {
  key: "quota" | "monitor" | "ssh";
  events: string;
  title: string;
  body: string;
};

// Every event type the server sends, typed or classified. ssh.pressure_window
// is left out on purpose: it is recorded, never notified. The two notify.*
// types report a channel's own delivery health.
const EVENT_OPTIONS = [
  "*",
  "monitor.down",
  "monitor.recovered",
  "service.down",
  "service.recovered",
  "node.offline",
  "node.online",
  "ssh.login",
  "ssh.compromise_suspected",
  "auth.2fa_limit",
  "proxy.quota",
  "proxy.expiry",
  "inventory.renewal",
  "notify.channel_failing",
  "notify.channel_ok",
];
// renderNotifyTemplate substitutes exactly three variables: event_type, title,
// and body. Anything else is left in the delivered message verbatim, which is
// how these presets used to ship literal "{{message}}" to Telegram.
const RULE_PRESETS: RulePreset[] = [
  {
    key: "quota",
    events: "proxy.quota, proxy.expiry",
    title: "{{event_type}}: {{title}}",
    body: "{{body}}",
  },
  {
    key: "monitor",
    events: "monitor.down, monitor.recovered",
    title: "{{event_type}}: {{title}}",
    body: "{{body}}",
  },
  {
    key: "ssh",
    events: "ssh.login",
    title: "SSH login: {{title}}",
    body: "{{body}}",
  },
];

const { t } = useI18n();
const auth = useAuthStore();
// The notify split (2026-09): notify:admin governs channels, rules and
// webhooks; notify:send is dispatch only and gates just the test-send below.
const canManage = computed(() => auth.can("notify:admin"));
const canSend = computed(() => auth.can("notify:send"));

/*
 * Two layers (design 23, section 3.4): Routing (channels and rules) and Sent,
 * the outbox's delivery log. Reading deliveries needs notify:admin, as the
 * channel list does.
 */
type Layer = "routing" | "sent";
const layers = computed<Layer[]>(() => (canManage.value ? ["routing", "sent"] : ["routing"]));
const layer = useLayer<Layer>(() => layers.value, () => "routing");

// BARE ARRAY endpoint: do NOT unwrap.
const channelsQuery = useAsyncData((signal) => api.notify.channels({ signal }), { pollInterval: 12000 });
const channels = computed(() => channelsQuery.data.value ?? []);
const rulesQuery = useAsyncData((signal) => api.notify.rules({ signal }), { pollInterval: 12000 });
const rules = computed(() => rulesQuery.data.value?.rules ?? []);
// The control-plane witness: notify:admin reads it, as it does the channel list.
const witnessQuery = useAsyncData(
  (signal) => (canManage.value ? api.notify.witness({ signal }) : Promise.resolve(undefined)),
  { pollInterval: 15_000 },
);
/** Whether each read has landed once; a count from a read that never did is not shown. */
const channelsRead = computed(() => channelsQuery.data.value !== undefined);
const rulesRead = computed(() => rulesQuery.data.value !== undefined);

/** Why the rule presets cannot open, or nothing when they can. */
const presetBlock = computed<string | undefined>(() => {
  if (!channelsRead.value) return t("platform.notifications.presetsChannelsUnread");
  if (sortedChannels.value.length === 0) return t("platform.notifications.presetsNeedChannel");
  return undefined;
});

/*
 * The proof line (design 23, section 3.1): channels and rules as last read.
 * Both reads speak for the line, so a failed rules read never leaves a
 * channel count standing in for the whole page.
 */
const proof = useProof([channelsQuery, rulesQuery]);
const proofSegments = computed<ProofSegment[]>(() => {
  const parts: ProofSegment[] = [
    { key: "channels", text: t("platform.notifications.proof.channels", { n: channels.value.length }, channels.value.length) },
    { key: "rules", text: t("platform.notifications.proof.rules", { n: rules.value.length }, rules.value.length) },
  ];
  const off = channels.value.filter((channel) => !channel.enabled).length + rules.value.filter((rule) => !rule.enabled).length;
  if (off) parts.push({ key: "off", tone: "muted", text: t("platform.notifications.proof.off", { n: off }) });
  return parts;
});

/* One menu per row (design 23, section 3.6): Edit, then Delete after the separator. */
function channelMenu(channel: NotifyChannelView): RowMenuItem[] {
  return [
    { key: "test", label: t("platform.notifications.testStored"), icon: Send, run: () => void testStoredChannel(channel) },
    { key: "edit", label: t("common.actions.edit"), icon: Pencil, run: () => openEdit(channel) },
    { key: "delete", label: t("common.actions.delete"), icon: Trash2, danger: true, run: () => (deleteTarget.value = channel) },
  ];
}
function ruleMenu(rule: NotifyRuleView): RowMenuItem[] {
  return [
    { key: "edit", label: t("common.actions.edit"), icon: Pencil, run: () => openRuleEdit(rule) },
    { key: "delete", label: t("common.actions.delete"), icon: Trash2, danger: true, run: () => (deleteRuleTarget.value = rule) },
  ];
}

// Machines, for the line under each rule that routes inventory.renewal: how
// many machines it reaches and when the next reminder goes out. Read only
// with inventory:read; without it the line says so instead of guessing.
const canReadInventory = computed(() => auth.can("inventory:read"));
const machinesQuery = useAsyncData<MachineView[] | undefined>(
  (signal) =>
    canReadInventory.value
      ? api.machines.list({ signal }).then((r) => unwrap(r, "machines"))
      : Promise.resolve(undefined),
  { pollInterval: 60_000 },
);
const coverage = computed(() =>
  machinesQuery.data.value ? reminderCoverage(machinesQuery.data.value, formatDay(new Date())) : undefined,
);

function reminderWhen(inDays: number, at: string): string {
  if (inDays <= 0) return t("fleet.inventory.list.whenToday");
  if (inDays === 1) return t("fleet.inventory.list.whenTomorrow");
  return t("fleet.inventory.list.whenDate", { date: at });
}

/**
 * One line for a rule that routes renewals: whom it reaches and what goes out
 * next. `warn` marks an enabled rule through which no reminder will go out
 * (no dated machine, every reminder off, or nothing scheduled): the fix is in
 * Inventory, so the line says so there instead of reading as healthy.
 */
function renewalLine(rule: NotifyRuleView): { text: string; warn: boolean } {
  if (!canReadInventory.value) return { text: t("platform.notifications.renewals.noAccess"), warn: false };
  const c = coverage.value;
  if (!c) {
    return {
      text: machinesQuery.error.value
        ? t("platform.notifications.renewals.failed")
        : t("platform.notifications.renewals.loading"),
      warn: false,
    };
  }
  if (c.covered === 0 && c.off > 0) return { text: t("platform.notifications.renewals.noneOn", { n: c.off }), warn: rule.enabled };
  if (c.covered === 0) return { text: t("platform.notifications.renewals.noDates"), warn: rule.enabled };
  const covers = rule.enabled ? "platform.notifications.renewals.covers" : "platform.notifications.renewals.coversDisabled";
  const parts = [t(covers, { n: c.covered }, c.covered)];
  if (c.off > 0) parts.push(t("platform.notifications.renewals.off", { n: c.off }, c.off));
  // Nothing goes out through a disabled rule, so it has no next reminder to name.
  if (!rule.enabled) return { text: parts.join(" "), warn: false };
  if (!c.next) {
    parts.push(t("platform.notifications.renewals.none"));
    return { text: parts.join(" "), warn: true };
  }
  const { machine, reminder } = c.next;
  const args = {
    when: reminderWhen(reminder.inDays, reminder.at),
    name: reminderMachineName(machine),
    offset: reminder.offset,
    // vue-i18n picks a plural form from a numeric `count`, which here counts
    // machines, so the days are pluralised as their own phrase.
    days: t("platform.notifications.renewals.days", { n: reminder.offset }, reminder.offset),
    renewal: reminder.renewal,
    count: c.sameDay,
  };
  if (reminder.offset < 0) {
    parts.push(t(reminder.inDays > 0 ? "platform.notifications.renewals.nextAfterDate" : "platform.notifications.renewals.nextOverdue", args));
  } else {
    parts.push(t(c.sameDay > 1 ? "platform.notifications.renewals.nextMany" : "platform.notifications.renewals.next", args));
  }
  return { text: parts.join(" "), warn: false };
}

// Nodes, for the line under each rule that routes node.offline: which delay
// each node pages after, which never page, and which carry a delay tag the
// server ignores. Read only with node:read.
const canReadNodes = computed(() => auth.can("node:read"));
const nodesQuery = useAsyncData<Node[] | undefined>(
  (signal) =>
    canReadNodes.value
      ? api.nodes.list({ signal }).then((r) => (Array.isArray(r) ? r : r.nodes ?? []))
      : Promise.resolve(undefined),
  { pollInterval: 60_000 },
);
const offlinePolicy = computed(() => (nodesQuery.data.value ? nodeOfflinePolicy(nodesQuery.data.value) : undefined));

const LIST_CAP = 8;
function capList(items: string[]): string {
  if (items.length <= LIST_CAP) return items.join(", ");
  return t("platform.notifications.offline.andMore", { list: items.slice(0, LIST_CAP).join(", "), n: items.length - LIST_CAP });
}

/**
 * One line for a rule that routes node.offline: the default delay and whom it
 * covers, the nodes that wait longer or never page, and any delay tag the
 * server will ignore (`warn`), since that node silently uses the default.
 */
function offlineLine(rule: NotifyRuleView): { text: string; warn: boolean } {
  if (!canReadNodes.value) return { text: t("platform.notifications.offline.noAccess"), warn: false };
  const policy = offlinePolicy.value;
  if (!policy) {
    return {
      text: nodesQuery.error.value ? t("platform.notifications.offline.failed") : t("platform.notifications.offline.loading"),
      warn: false,
    };
  }
  const delay = formatOfflineDelay(DEFAULT_OFFLINE_MINUTES);
  const key = rule.enabled ? "platform.notifications.offline.covers" : "platform.notifications.offline.coversDisabled";
  const parts = [t(key, { delay, n: policy.defaultCount }, policy.defaultCount)];
  if (policy.delayed.length > 0) {
    parts.push(t("platform.notifications.offline.delayed", {
      list: capList(policy.delayed.map((d) => `${d.name} (${formatOfflineDelay(d.minutes)})`)),
    }));
  }
  if (policy.quiet.length > 0) parts.push(t("platform.notifications.offline.quiet", { list: capList(policy.quiet) }));
  if (policy.invalid.length > 0) {
    parts.push(t("platform.notifications.offline.invalid", {
      list: capList(policy.invalid.map((i) => `${i.name} (${i.tag})`)),
    }));
    return { text: parts.join(" "), warn: true };
  }
  return { text: parts.join(" "), warn: false };
}

/**
 * One line for a rule with quiet hours or an escalation that is not the
 * default (30 minutes at critical); undefined for the defaults, which most
 * rules keep.
 */
function ruleIncidentLine(rule: NotifyRuleView): string | undefined {
  const summary = ruleIncidentSummary(rule);
  const parts: string[] = [];
  if (summary.quiet) parts.push(t("platform.notifications.incidents.quietLine", summary.quiet));
  if (summary.escalation === "off") parts.push(t("platform.notifications.incidents.escalationOffLine"));
  else if (typeof summary.escalation === "object") {
    parts.push(t("platform.notifications.incidents.escalationLine", { n: summary.escalation.minutes, level: summary.escalation.level }));
  }
  return parts.length ? parts.join(" · ") : undefined;
}

function ruleHasDetail(rule: NotifyRuleView): boolean {
  return ruleRoutesRenewals(rule) || ruleRoutesNodeOffline(rule) || !!ruleIncidentLine(rule);
}

const sortedChannels = computed(() =>
  [...channels.value].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
);
const sortedRules = computed(() =>
  [...rules.value].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
);

const channelColumns = computed<DataTableColumn<NotifyChannelView>[]>(() => [
  { key: "name", label: t("platform.notifications.colName"), sortable: true, searchable: true, value: (c) => c.name || c.id },
  { key: "health", label: t("platform.notifications.colHealth"), wrap: true },
  { key: "kind", label: t("platform.notifications.colKind"), sortable: true, searchable: true },
  { key: "config_keys", label: t("platform.notifications.colConfiguredKeys") },
  { key: "enabled", label: t("platform.notifications.colStatus"), sortable: true },
  { key: "updated_at", label: t("platform.notifications.colUpdated"), sortable: true, class: "text-xs text-muted-foreground" },
  { key: "actions", label: "", class: "w-12", pin: "end" },
]);

const ruleColumns = computed<DataTableColumn<NotifyRuleView>[]>(() => [
  { key: "name", label: t("platform.notifications.colRule"), sortable: true, searchable: true, value: (r) => r.name || r.id },
  { key: "event_types", label: t("platform.notifications.colEvents") },
  { key: "channel_ids", label: t("platform.notifications.colChannels") },
  { key: "templates", label: t("platform.notifications.colTemplates") },
  { key: "enabled", label: t("platform.notifications.colStatus"), sortable: true },
  { key: "actions", label: "", class: "w-12", pin: "end" },
]);

// ── Channel health ───────────────────────────────────────────────────────────

function causeText(cause?: FailureCause): string {
  if (!cause) return t("platform.notifications.cause.failed");
  return t(`platform.notifications.cause.${cause.key}`, { status: cause.status ?? "" });
}

function healthText(line: HealthLine): string {
  switch (line.state) {
    case "ok":
      return t("platform.notifications.health.ok", { when: formatRelativeTime(line.at) });
    case "degraded":
      return t("platform.notifications.health.degraded", { when: formatRelativeTime(line.at) });
    case "failing":
      return t("platform.notifications.health.failing", { since: formatDateTime(line.at), n: line.failures }, line.failures);
    case "unknown":
      return t("platform.notifications.health.unknown");
    default:
      return t("platform.notifications.health.unreported");
  }
}

/** The line under a channel that hands its critical messages to another one. */
function channelFallbackLine(channel: NotifyChannelView): string | undefined {
  const id = channel.fallback_channel_id;
  if (!id) return undefined;
  return channelKnown(id)
    ? t("platform.notifications.channelFallback.badge", { name: channelName(id) })
    : t("platform.notifications.channelFallback.gone", { id });
}

/** How often a channel has handed a critical message on, and to whom. */
function channelHandedLine(channel: NotifyChannelView): string | undefined {
  const h = channel.health;
  if (!h?.fallbacks || !h.last_fallback_at) return undefined;
  const id = h.last_fallback_channel_id ?? "";
  return t(
    "platform.notifications.channelFallback.handed",
    { n: h.fallbacks, name: channelKnown(id) ? channelName(id) : id, when: formatRelativeTime(h.last_fallback_at) },
    h.fallbacks,
  );
}

/** A channel whose last sends failed carries the cause under its row, at the table's width. */
function channelHasHealthDetail(channel: NotifyChannelView): boolean {
  const state = channelHealthLine(channel.health).state;
  return state === "failing" || state === "degraded";
}

/** One attention row per witness problem, worst first (witnessModel.witnessAttention). */
function witnessAttentionItem(item: WitnessAttention): AttentionItem {
  const node = item.node.node_name;
  const line = item.line;
  const since = line.since ? formatDateTime(line.since) : "";
  const report = item.node.report;
  const key = `witness:${item.kind}:${item.node.node_id}`;
  const base = { key, tone: item.tone, claim: t(`platform.notifications.witness.attention.${item.kind}`, { node }) };
  switch (item.kind) {
    case "down":
      return { ...base, proof: t("platform.notifications.witness.attention.downProof", { since }) };
    case "failing":
      return { ...base, proof: t("platform.notifications.witness.attention.failingProof", { since, n: line.failures ?? 0, detail: line.detail ?? "" }, line.failures ?? 0) };
    case "networkDown":
      return { ...base, proof: t("platform.notifications.witness.attention.networkDownProof", { since }) };
    case "notReporting":
      return { ...base, proof: t("platform.notifications.witness.attention.notReportingProof", { when: item.node.reported_at ? formatDateTime(item.node.reported_at) : "" }) };
    case "stopped":
      return { ...base, proof: t("platform.notifications.witness.attention.stoppedProof", { when: line.at ? formatDateTime(line.at) : "" }) };
    case "pushFailed":
      return {
        ...base,
        proof: t("platform.notifications.witness.attention.pushFailedProof", {
          when: report?.last_push_at ? formatDateTime(report.last_push_at) : "",
          error: report?.last_push_error || t("platform.notifications.witness.push.refusedNoReason"),
        }),
      };
    case "planFailed":
      return {
        ...base,
        proof: item.node.last_failed?.reason,
        action: item.node.last_failed
          ? { label: t("platform.notifications.witness.attention.open"), to: { name: "approvals", query: { open: item.node.last_failed.approval_id } } }
          : undefined,
      };
    default:
      return base;
  }
}

/** A failing channel is a claim with a fix beside it: test it after correcting the key. */
const attentionItems = computed<AttentionItem[]>(() => [
  ...witnessAttention(witnessQuery.data.value?.nodes ?? []).filter((item) => item.tone === "danger").map(witnessAttentionItem),
  ...failingChannels(channels.value).map((channel) => {
    const line = channelHealthLine(channel.health);
    return {
      key: `failing:${channel.id}`,
      tone: "danger" as const,
      claim: t("platform.notifications.attention.failing", { name: channel.name || channel.id }),
      proof: t(
        "platform.notifications.attention.failingProof",
        { since: formatDateTime(line.at), n: line.failures, cause: causeText(line.cause) },
        line.failures,
      ),
      action: canManage.value
        ? { label: t("platform.notifications.testStored"), run: () => void testStoredChannel(channel) }
        : undefined,
    };
  }),
  ...witnessAttention(witnessQuery.data.value?.nodes ?? []).filter((item) => item.tone !== "danger").map(witnessAttentionItem),
]);

const testingChannelId = ref<string | undefined>();

/**
 * Tests a stored channel server-side. The answer is 200 either way, with the
 * classified cause on a failure; the health it returns is what the table shows
 * once the channel list is read again, and the test lands in the Sent log.
 */
async function testStoredChannel(channel: NotifyChannelView): Promise<void> {
  if (!canManage.value || testingChannelId.value) return;
  const name = channel.name || channel.id;
  testingChannelId.value = channel.id;
  try {
    const res = await api.notify.testChannel(channel.id);
    if (res.ok) toast.success(t("platform.notifications.testStoredDelivered", { name }));
    else toast.error(t("platform.notifications.testStoredFailed", { name, cause: causeText(sentCause(res.delivery)) }));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.notifications.testStoredError"));
  } finally {
    testingChannelId.value = undefined;
    channelsQuery.refresh();
    if (layer.value === "sent") sentQueryState.refresh();
  }
}

// ── Sent log ─────────────────────────────────────────────────────────────────

/* Filters live in the address, so the attention list can open one channel's failures. */
const sentOutcome = useQueryParam<SentOutcomeFilter>("outcome", {
  parse: (raw) => parseSentOutcome(raw),
  format: (value) => (value === "all" ? undefined : value),
});
const textCodec = { parse: (raw: unknown) => (typeof raw === "string" ? raw : ""), format: (value: string) => value || undefined };
const sentChannel = useQueryParam<string>("channel", textCodec);
const sentEvent = useQueryParam<string>("event", textCodec);

const sentQueryState = useAsyncData(
  (signal) =>
    layer.value === "sent" && canManage.value
      ? api.notify.deliveries(sentQuery({ outcome: sentOutcome.value, channel: sentChannel.value, event: sentEvent.value }), { signal })
      : Promise.resolve(undefined),
  { pollInterval: 15_000 },
);
watch(
  () => layer.value,
  () => void sentQueryState.refresh(),
);
// A changed filter shows the table loading rather than the previous filter's rows.
watch([() => sentOutcome.value, () => sentChannel.value, () => sentEvent.value], () => {
  sentQueryState.data.value = undefined;
  void sentQueryState.refresh();
});
const sentRows = computed<NotifyDelivery[]>(() => sentQueryState.data.value?.deliveries ?? []);
const sentRead = computed(() => sentQueryState.data.value !== undefined);
const sentFiltered = computed(() => sentOutcome.value !== "all" || !!sentChannel.value || !!sentEvent.value);
const sentEventOptions = computed(() => sentEventChoices(EVENT_OPTIONS, sentRows.value, sentEvent.value));

/* One write for all three filters, for the reason openChannelSent gives. */
function clearSentFilters(): void {
  const query: QueryRecord = { ...owned.query() };
  delete query.outcome;
  delete query.channel;
  delete query.event;
  owned.replace(query);
}

const sentProof = useProof([sentQueryState]);
const sentProofSegments = computed<ProofSegment[]>(() => {
  const page = sentQueryState.data.value;
  if (!page) return [];
  const parts: ProofSegment[] = [
    { key: "stored", text: t("platform.notifications.sent.proofStored", { n: page.stored }) },
  ];
  if (page.deliveries.length >= SENT_LIMIT) {
    parts.push({ key: "shown", text: t("platform.notifications.sent.proofShown", { n: page.deliveries.length }) });
  }
  parts.push(
    page.durable
      ? { key: "kept", tone: "muted", text: t("platform.notifications.sent.proofDurable", { max: page.max, floor: page.floor }) }
      : { key: "kept", tone: "muted", text: t("platform.notifications.sent.proofMemory") },
  );
  return parts;
});

/* The Routing count appears only when a channel is failing, tinted, since it asks for action. */
const layerTabs = computed<LayerTab<Layer>[]>(() => {
  const failing = failingChannels(channels.value).length;
  return [
    {
      value: "routing",
      label: t("platform.notifications.layers.routing"),
      count: failing || undefined,
      tone: failing ? "destructive" : "default",
    },
    { value: "sent", label: t("platform.notifications.layers.sent") },
  ];
});

/*
 * One navigation for the layer and the filter: two writes in a row would
 * each start from the address before the other landed, and the second would
 * drop the first.
 */
function openChannelSent(channelId: string): void {
  const query: QueryRecord = { ...owned.query(), channel: channelId };
  delete query.outcome;
  delete query.event;
  delete query.open;
  owned.push(writeLayer(query, "sent", "routing"));
}

const sentColumns = computed<DataTableColumn<NotifyDelivery>[]>(() => [
  { key: "created_at", label: t("platform.notifications.sent.colTime"), sortable: true, class: "w-40" },
  {
    key: "message",
    label: t("platform.notifications.sent.colMessage"),
    searchable: true,
    wrap: true,
    value: (d) => `${d.event_type} ${d.title ?? ""} ${d.body ?? ""}`,
  },
  {
    key: "channel",
    label: t("platform.notifications.sent.colChannel"),
    searchable: true,
    value: (d) => d.channel_name || d.channel_id || "",
  },
  { key: "outcome", label: t("platform.notifications.sent.colOutcome"), wrap: true },
]);

function sentBadgeVariant(d: NotifyDelivery): "destructive" | "warning" | "secondary" {
  const tone = sentTone(sentState(d));
  return tone === "quiet" ? "secondary" : tone;
}

function sentChannelLabel(d: NotifyDelivery): string {
  if (!d.channel_id) return t("platform.notifications.sent.noChannel");
  const current = channels.value.find((channel) => channel.id === d.channel_id);
  const name = current?.name || d.channel_name || d.channel_id;
  // A channel deleted since keeps the name it had when the row was planned.
  return channelsRead.value && !current ? t("platform.notifications.sent.channelDeleted", { name }) : name;
}

function sentNoteText(d: NotifyDelivery): string {
  const note = sentNote(d);
  if (!note) return "";
  if (!("key" in note)) return note.raw;
  const params = { ...note.params };
  if (typeof params.until === "string") params.until = formatDateTime(params.until);
  return t(`platform.notifications.sent.note.${note.key}`, params);
}

/** Rows that carry a sentence under them: why it failed, a note, how often an unrouted event repeated, or what a fallback stood in for. */
function sentHasDetail(d: NotifyDelivery): boolean {
  const state = sentState(d);
  return (
    ((state === "failed" || state === "retrying") && !!sentCause(d)) ||
    !!sentNote(d) ||
    !!sentOccurrences(d) ||
    (d.role === "fallback" && !!d.fallback_for)
  );
}

function sentOccurrencesText(d: NotifyDelivery): string {
  const seen = sentOccurrences(d);
  return seen ? t("platform.notifications.sent.occurrences", { n: seen.count, when: formatRelativeTime(seen.last) }) : "";
}

/* A row opens in the object sheet (design 23, section 3.5): the message, the receipts and where it came from. */
const sheet = useRouteOpen();
const openDelivery = computed(() => (layer.value === "sent" ? sentRows.value.find((d) => d.id === sheet.openId.value) : undefined));
const sheetState = computed<"ready" | "loading" | "gone" | "failed">(() => {
  if (openDelivery.value) return "ready";
  if (!sentRead.value) return sentQueryState.error.value ? "failed" : "loading";
  return "gone";
});

function sentOrigin(d: NotifyDelivery): string {
  const via = ["server", "plugin", "webhook", "operator"].includes(d.source) ? d.source : "server";
  const parts = [t(`platform.notifications.sent.via.${via}`, { id: d.source_id ?? "" })];
  if (d.rule_name || d.rule_id) parts.push(t("platform.notifications.sent.rule", { name: d.rule_name || d.rule_id }));
  else if (d.role !== "test" && d.outcome !== "no_route" && d.source !== "operator") parts.push(t("platform.notifications.sent.everyChannel"));
  return parts.join(" · ");
}

// ── Create / edit dialog ─────────────────────────────────────────────────────
const formOpen = ref(false);
const saving = ref(false);
const testing = ref(false);
const editingId = ref<string | undefined>();

const formName = ref("");
const formKind = ref<NotifyKind>("telegram");
// Kind the channel was loaded with. Switching kind while editing invalidates the
// stored config, so the new kind's required fields must be entered in full.
const editingKind = ref<NotifyKind | undefined>();
const formEnabled = ref(true);
const formConfig = ref<Record<string, string>>({});
const formTitle = ref("");
const formBody = ref("");
// Keys the server holds for the channel being edited. Values never come back,
// so this is the only trace the form has of a stored level, group or url.
const storedKeys = ref<string[]>([]);
const clearAcknowledged = ref(false);
/** The channel's critical fallback, and whether it had one, so clearing it sends "". */
const formFallback = ref("");
const formHadFallback = ref(false);
const formFallbackChoices = computed(() => channelFallbackChoices(sortedChannels.value, editingId.value));
/** The events a channel fallback carries, as the server names them. */
const criticalEvents = computed(() => channels.value.find((c) => c.critical_event_types?.length)?.critical_event_types ?? ["node.offline", "service.down", "ssh.compromise_suspected"]);

const activeFields = computed<FieldDef[]>(() => KIND_FIELDS[formKind.value]);

function resetConfigForKind(): void {
  const next: Record<string, string> = {};
  for (const field of KIND_FIELDS[formKind.value]) next[field.key] = "";
  formConfig.value = next;
}

function openCreate(): void {
  if (!canManage.value) return;
  editingId.value = undefined;
  editingKind.value = undefined;
  formName.value = "";
  formKind.value = "telegram";
  formEnabled.value = true;
  formTitle.value = "";
  formBody.value = "";
  storedKeys.value = [];
  clearAcknowledged.value = false;
  formFallback.value = "";
  formHadFallback.value = false;
  resetConfigForKind();
  formOpen.value = true;
}

function openEdit(channel: NotifyChannelView): void {
  if (!canManage.value) return;
  editingId.value = channel.id;
  formName.value = channel.name;
  formKind.value = (KIND_OPTIONS.includes(channel.kind as NotifyKind)
    ? channel.kind
    : "telegram") as NotifyKind;
  editingKind.value = formKind.value;
  formEnabled.value = channel.enabled;
  formTitle.value = "";
  formBody.value = "";
  storedKeys.value = [...(channel.config_keys ?? [])];
  clearAcknowledged.value = false;
  formFallback.value = channel.fallback_channel_id ?? "";
  formHadFallback.value = !!channel.fallback_channel_id;
  resetConfigForKind();
  formOpen.value = true;
}

function onKindChange(): void {
  clearAcknowledged.value = false;
  resetConfigForKind();
}

const configComplete = computed(() => configCompleteFor(activeFields.value, formConfig.value));

// Secrets are write-only: the server never returns them, so an edit starts with
// empty fields and a blank field means "leave the stored value alone". Demanding
// every secret again just to rename a channel or flip `enabled` is what made
// Save permanently unreachable on edit. Changing the kind is the exception: the
// stored config belongs to the old kind and cannot carry over.
const kindChanged = computed(() => !!editingId.value && formKind.value !== editingKind.value);
const secretsOptional = computed(() => !!editingId.value && !kindChanged.value);

// Stored optional keys the form leaves blank are replaced away on save, with
// no error to say so. The gate lists them and keeps Save out of reach until
// the operator either re-enters them or acknowledges the clear.
const saveGate = computed(() =>
  channelSaveGate({
    fields: activeFields.value,
    storedKeys: editingId.value ? storedKeys.value : [],
    config: formConfig.value,
    kindChanged: kindChanged.value,
    clearAcknowledged: clearAcknowledged.value,
  }),
);
const isStored = (key: string): boolean => !!editingId.value && !kindChanged.value && storedKeys.value.includes(key);

const canSubmit = computed(
  () => !!formName.value.trim() && (secretsOptional.value || configComplete.value) && !saveGate.value.blocked,
);

function buildConfig(): Record<string, string> {
  return buildConfigFor(activeFields.value, formConfig.value);
}

async function submitForm(): Promise<void> {
  if (!canSubmit.value || !canManage.value) return;
  saving.value = true;
  try {
    const req: NotifyChannelUpsertRequest = {
      id: editingId.value,
      name: formName.value.trim(),
      kind: formKind.value,
      config: buildConfig(),
      enabled: formEnabled.value,
      fallback_channel_id: channelFallbackForSave(formFallback.value, editingId.value, formHadFallback.value),
    };
    await api.notify.upsertChannel(req);
    toast.success(editingId.value ? t("platform.notifications.channelUpdated") : t("platform.notifications.channelCreated"));
    formOpen.value = false;
    channelsQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.notifications.saveFailed"));
  } finally {
    saving.value = false;
  }
}

async function sendTest(): Promise<void> {
  if (!canSend.value) return;
  if (!configComplete.value) {
    toast.error(t("platform.notifications.enterRequiredFields"));
    return;
  }
  testing.value = true;
  try {
    const res = await api.notify.test({
      channel: formKind.value,
      config: buildConfig(),
      title: formTitle.value.trim() || undefined,
      body: formBody.value.trim() || undefined,
    });
    if (res.ok) toast.success(t("platform.notifications.testDelivered", { channel: res.channel }));
    else toast.error(t("platform.notifications.testDeliveryFailed"));
  } catch (error) {
    // Delivery failure surfaces as 502 from the API; message is human-readable.
    toast.error(error instanceof Error ? error.message : t("platform.notifications.testDeliveryFailed"));
  } finally {
    testing.value = false;
  }
}

// ── Delete confirmation ──────────────────────────────────────────────────────
const deleteTarget = ref<NotifyChannelView | undefined>();
const deleting = ref(false);

/** What a channel delete stops, as lines (notificationsModel.channelDeleteImpact). */
const channelDeleteImpact = computed<{ lines: string[]; typed: boolean }>(() => {
  const target = deleteTarget.value;
  if (!target) return { lines: [], typed: false };
  const name = target.name || target.id;
  const impact = channelDeleteImpactFor(target, rulesRead.value ? rules.value : undefined, channels.value);
  const lines = impact.lines.map((line) => {
    switch (line.kind) {
      case "silenced":
        return t("platform.notifications.deleteImpact.silenced", { rule: line.rule, events: line.events });
      case "kept":
        return t("platform.notifications.deleteImpact.kept", { rule: line.rule, others: line.others.join(", ") });
      case "noRules":
        return t("platform.notifications.deleteImpact.noRules", { name });
      case "unrouted":
        return t("platform.notifications.deleteImpact.unrouted", { name });
      case "rulesUnread":
        return t("platform.notifications.deleteImpact.rulesUnread");
    }
  });
  return { lines, typed: impact.typed };
});

async function confirmDelete(): Promise<void> {
  if (!deleteTarget.value) return;
  deleting.value = true;
  try {
    await api.notify.deleteChannel(deleteTarget.value.id);
    toast.success(t("platform.notifications.channelDeleted"));
    deleteTarget.value = undefined;
    channelsQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.notifications.deleteFailed"));
  } finally {
    deleting.value = false;
  }
}

// ── Routing rules ───────────────────────────────────────────────────────────
const ruleOpen = ref(false);
const ruleSaving = ref(false);
const ruleEditingId = ref<string | undefined>();
const ruleName = ref("");
const ruleEvents = ref("monitor.down");
const ruleChannelIds = ref<string[]>([]);
const ruleTitleTemplate = ref("");
const ruleBodyTemplate = ref("");
const ruleEnabled = ref(true);
const ruleFallback = ref("");
/** Whether the rule being edited had a fallback, so clearing it sends "". */
const ruleHadFallback = ref(false);
const deleteRuleTarget = ref<NotifyRuleView | undefined>();
// Escalation and quiet hours (lattice-server incidents.go). The original is
// what the rule held, so a save sends only what the operator changed.
const browserZone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
})();
const ruleIncident = ref<RuleIncidentDraft>(ruleIncidentDraft(undefined, browserZone));
const ruleIncidentOriginal = ref<RuleIncidentDraft>(ruleIncidentDraft(undefined, browserZone));
function knownTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
const ruleIncidentErrorList = computed(() => ruleIncidentErrors(ruleIncident.value, knownTimeZone));
const timeZoneChoices = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
})();
function resetRuleIncident(rule?: NotifyRuleView): void {
  ruleIncident.value = ruleIncidentDraft(rule, browserZone);
  ruleIncidentOriginal.value = ruleIncidentDraft(rule, browserZone);
}
const ruleFallbackChoices = computed(() => fallbackChoices(sortedChannels.value, ruleChannelIds.value));
const deletingRule = ref(false);

function openRuleCreate(): void {
  if (!canManage.value) return;
  ruleEditingId.value = undefined;
  ruleName.value = "";
  ruleEvents.value = "monitor.down";
  ruleChannelIds.value = sortedChannels.value[0]?.id ? [sortedChannels.value[0].id] : [];
  ruleTitleTemplate.value = "";
  ruleBodyTemplate.value = "";
  ruleEnabled.value = true;
  ruleFallback.value = "";
  ruleHadFallback.value = false;
  resetRuleIncident();
  ruleOpen.value = true;
}

function openRulePreset(preset: RulePreset): void {
  if (!canManage.value) return;
  ruleEditingId.value = undefined;
  ruleName.value = t(`platform.notifications.presets.${preset.key}`);
  ruleEvents.value = preset.events;
  ruleChannelIds.value = sortedChannels.value[0]?.id ? [sortedChannels.value[0].id] : [];
  ruleTitleTemplate.value = preset.title;
  ruleBodyTemplate.value = preset.body;
  ruleEnabled.value = true;
  ruleFallback.value = "";
  ruleHadFallback.value = false;
  resetRuleIncident();
  ruleOpen.value = true;
}

function openRuleEdit(rule: NotifyRuleView): void {
  if (!canManage.value) return;
  ruleEditingId.value = rule.id;
  ruleName.value = rule.name;
  ruleEvents.value = (rule.event_types ?? ["*"]).join(", ");
  ruleChannelIds.value = [...(rule.channel_ids ?? [])];
  ruleTitleTemplate.value = rule.title_template ?? "";
  ruleBodyTemplate.value = rule.body_template ?? "";
  ruleEnabled.value = rule.enabled;
  ruleFallback.value = rule.fallback_channel_id ?? "";
  ruleHadFallback.value = !!rule.fallback_channel_id;
  resetRuleIncident(rule);
  ruleOpen.value = true;
}

function parseRuleEvents(input: string): string[] {
  return input
    .split(",")
    .map((event) => event.trim())
    .filter(Boolean);
}

function channelName(id: string): string {
  return sortedChannels.value.find((channel) => channel.id === id)?.name || id;
}

/** A rule can still name a channel that was deleted; the server skips it. */
function channelKnown(id: string): boolean {
  return channels.value.some((channel) => channel.id === id);
}

function toggleRuleChannel(id: string, checked: boolean): void {
  const next = ruleChannelIds.value.filter((current) => current !== id);
  ruleChannelIds.value = checked ? [...next, id] : next;
  // A channel that becomes one of the rule's own cannot also be its fallback.
  if (checked && ruleFallback.value === id) ruleFallback.value = "";
}

const canSubmitRule = computed(
  () =>
    !!ruleName.value.trim() &&
    parseRuleEvents(ruleEvents.value).length > 0 &&
    ruleChannelIds.value.length > 0 &&
    ruleIncidentErrorList.value.length === 0,
);

async function submitRule(): Promise<void> {
  if (!canSubmitRule.value || !canManage.value) return;
  ruleSaving.value = true;
  try {
    const req: NotifyRuleUpsertRequest = {
      id: ruleEditingId.value,
      name: ruleName.value.trim(),
      event_types: parseRuleEvents(ruleEvents.value),
      channel_ids: ruleChannelIds.value,
      title_template: ruleTitleTemplate.value.trim() || undefined,
      body_template: ruleBodyTemplate.value.trim() || undefined,
      enabled: ruleEnabled.value,
      fallback_channel_id: fallbackForSave(ruleFallback.value, ruleChannelIds.value, ruleHadFallback.value),
      ...ruleIncidentRequest(ruleIncident.value, ruleIncidentOriginal.value),
    };
    await api.notify.upsertRule(req);
    toast.success(ruleEditingId.value ? t("platform.notifications.ruleUpdated") : t("platform.notifications.ruleCreated"));
    ruleOpen.value = false;
    rulesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.notifications.ruleSaveFailed"));
  } finally {
    ruleSaving.value = false;
  }
}

/*
 * Webhooks links here with ?newRule=<event type> for a webhook no rule
 * routes: the rule form opens with that event filled in once the channel
 * read settles (it preselects the first channel; a failed read leaves the
 * picker saying so), and the key leaves the address so a reload does not
 * reopen it. A caller who cannot manage rules is told so instead.
 */
const owned = useOwnedRoute();
watch(
  [() => owned.query().newRule, () => channelsQuery.data.value, () => channelsQuery.error.value],
  ([event, list, error]) => {
    if (typeof event !== "string" || !event || !owned.owns()) return;
    if (list === undefined && !error) return;
    const query = { ...owned.query() };
    delete query.newRule;
    owned.replace(query);
    if (!canManage.value) {
      toast.info(t("platform.notifications.newRuleNoAccess"));
      return;
    }
    openRuleCreate();
    ruleEvents.value = event;
  },
  { immediate: true },
);

async function confirmDeleteRule(): Promise<void> {
  if (!deleteRuleTarget.value) return;
  deletingRule.value = true;
  try {
    await api.notify.deleteRule(deleteRuleTarget.value.id);
    toast.success(t("platform.notifications.ruleDeleted"));
    deleteRuleTarget.value = undefined;
    rulesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.notifications.ruleDeleteFailed"));
  } finally {
    deletingRule.value = false;
  }
}
</script>

<template>
  <div class="p-4 sm:p-6 space-y-6">
    <PageHeader :title="$t('platform.notifications.title')">
      <template #description>
        <p class="text-sm text-muted-foreground">{{ $t('platform.notifications.description') }}</p>
        <ProofLine v-bind="proof" :segments="proofSegments" @retry="() => { channelsQuery.refresh(); rulesQuery.refresh(); }" />
      </template>
      <template #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="channelsQuery.refreshing.value || rulesQuery.refreshing.value"
          @click="() => { channelsQuery.refresh(); rulesQuery.refresh(); }"
        >
          <RefreshCw aria-hidden="true" :class="cn('size-4', (channelsQuery.refreshing.value || rulesQuery.refreshing.value) && 'animate-spin')" />
          {{ $t('common.actions.refresh') }}
        </Button>
        <Button v-if="canManage" variant="outline" size="sm" @click="openRuleCreate">
          <GitBranch aria-hidden="true" class="size-4" />
          {{ $t('platform.notifications.newRule') }}
        </Button>
        <Button v-if="canManage" size="sm" @click="openCreate">
          <Plus aria-hidden="true" class="size-4" />
          {{ $t('platform.notifications.newChannel') }}
        </Button>
      </template>
    </PageHeader>

    <LayerTabs v-if="layers.length > 1" v-model="layer" :tabs="layerTabs" :label="$t('platform.notifications.layers.label')" />

    <template v-if="layer === 'routing'">
    <AttentionList :items="attentionItems" :title="$t('platform.notifications.attention.title')" />

    <NotificationsWitnessCard
      v-if="canManage"
      :status="witnessQuery.data.value"
      :loading="witnessQuery.loading.value"
      :error="witnessQuery.error.value"
      :channels="sortedChannels"
      :can-manage="canManage"
      @refresh="witnessQuery.refresh()"
      @filed="witnessQuery.refresh()"
    />

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Bell aria-hidden="true" class="size-4 text-muted-foreground" />
          {{ $t('platform.notifications.channelsTitle') }}
        </CardTitle>
        <CardDescription>
          {{ channelsRead ? $t('platform.notifications.channelsCount', { count: channels.length }, channels.length) : $t('platform.notifications.channelsUnread') }}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataTable
          state-key="channels"
          :columns="channelColumns"
          :rows="sortedChannels"
          :row-key="(channel) => channel.id"
          :loading="channelsQuery.loading.value"
          :error="channelsQuery.error.value"
          :has-data="channelsQuery.data.value !== undefined"
          :row-expanded="channelHasHealthDetail"
          :page-size="0"
          :show-summary="false"
          :searchable="sortedChannels.length > 6"
          :expression-filter="false"
          :search-placeholder="$t('platform.shared.searchNames')"
          :empty-title="$t('platform.notifications.emptyTitle')"
          :empty-description="$t('platform.notifications.emptyDescription')"
          :no-match-title="$t('platform.shared.noMatchesTitle')"
          :no-match-description="$t('platform.shared.noMatchesDescription')"
          @retry="channelsQuery.refresh"
        >
          <template #cell-name="{ row }">
            <div class="font-medium max-md:truncate">{{ row.name || row.id }}</div>
            <div v-if="channelFallbackLine(row)" class="mt-1 flex items-start gap-1 text-xs text-muted-foreground" data-testid="channel-fallback">
              <CornerDownRight class="mt-px size-3.5 shrink-0" aria-hidden="true" />
              <span class="min-w-0 break-words">{{ channelFallbackLine(row) }}</span>
            </div>
          </template>
          <template #cell-kind="{ row }">
            <Badge variant="outline" class="font-mono text-[11px]">{{ row.kind }}</Badge>
          </template>
          <template #cell-health="{ row }">
            <div class="max-w-xs" data-testid="channel-health" :data-state="channelHealthLine(row.health).state">
              <div v-if="channelHealthLine(row.health).state === 'failing'" class="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Badge variant="destructive">{{ $t('platform.notifications.health.failingBadge') }}</Badge>
                <span class="text-xs text-destructive">{{ healthText(channelHealthLine(row.health)) }}</span>
              </div>
              <p
                v-else
                :class="cn('flex items-start gap-1.5 text-xs', channelHealthLine(row.health).tone === 'warning' ? 'text-warning-text' : 'text-muted-foreground')"
              >
                <TriangleAlert v-if="channelHealthLine(row.health).tone === 'warning'" class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>{{ healthText(channelHealthLine(row.health)) }}</span>
              </p>
              <p v-if="channelHandedLine(row)" class="mt-1 text-xs text-muted-foreground" data-testid="channel-handed">{{ channelHandedLine(row) }}</p>
            </div>
          </template>
          <template #row-detail="{ row }">
            <p
              :class="cn('flex items-start gap-2 text-xs', channelHealthLine(row.health).tone === 'danger' ? 'text-destructive' : 'text-warning-text')"
              data-testid="channel-health-cause"
            >
              <TriangleAlert class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>
                {{ $t('platform.notifications.health.lastFailure', { cause: causeText(channelHealthLine(row.health).cause) }) }}
                <button
                  v-if="canManage"
                  type="button"
                  class="rounded-sm font-medium underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-primary pointer-coarse:py-1"
                  @click="openChannelSent(row.id)"
                >{{ $t('platform.notifications.attention.showSent') }}</button>
              </span>
            </p>
          </template>
          <template #cell-config_keys="{ row }">
            <div class="flex flex-wrap gap-1">
              <Badge
                v-for="key in row.config_keys"
                :key="key"
                variant="outline"
                class="font-mono text-[10px]"
              >
                {{ key }}
              </Badge>
              <span v-if="row.config_keys.length === 0" class="text-xs text-muted-foreground">{{ $t('common.misc.none') }}</span>
            </div>
          </template>
          <template #cell-enabled="{ row }">
            <!-- Enabled is the normal state and stays quiet text; only a turned-off row carries a badge. -->
            <span v-if="row.enabled" class="text-xs text-muted-foreground">{{ $t('common.status.enabled') }}</span>
            <Badge v-else variant="secondary">{{ $t('common.status.disabled') }}</Badge>
          </template>
          <template #cell-updated_at="{ row }">
            <span class="text-xs text-muted-foreground">{{ formatDateTime(row.updated_at) }}</span>
          </template>
          <template #cell-actions="{ row }">
            <RowMenu v-if="canManage" :name="row.name || row.id" :items="channelMenu(row)" />
          </template>
        </DataTable>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <GitBranch aria-hidden="true" class="size-4 text-muted-foreground" />
          {{ $t('platform.notifications.rulesTitle') }}
        </CardTitle>
        <CardDescription>
          {{ $t('platform.notifications.rulesDescription') }}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div v-if="canManage" class="mb-4 rounded-md border border-border p-3">
          <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p class="text-sm font-medium">{{ $t('platform.notifications.presetsTitle') }}</p>
              <p class="text-xs text-muted-foreground">{{ $t('platform.notifications.presetsDescription') }}</p>
              <p v-if="presetBlock" class="text-xs text-muted-foreground" data-testid="presets-blocked">{{ presetBlock }}</p>
            </div>
            <div class="flex flex-wrap gap-2">
              <Button
                v-for="preset in RULE_PRESETS"
                :key="preset.key"
                variant="outline"
                size="sm"
                :disabled="!!presetBlock"
                :title="presetBlock"
                @click="openRulePreset(preset)"
              >
                <Plus class="size-4" aria-hidden="true" />
                {{ $t(`platform.notifications.presets.${preset.key}`) }}
              </Button>
            </div>
          </div>
        </div>
        <DataTable
          state-key="rules"
          :columns="ruleColumns"
          :rows="sortedRules"
          :row-key="(rule) => rule.id"
          :loading="rulesQuery.loading.value"
          :error="rulesQuery.error.value"
          :has-data="rulesQuery.data.value !== undefined"
          :row-expanded="ruleHasDetail"
          :page-size="0"
          :show-summary="false"
          :searchable="sortedRules.length > 6"
          :expression-filter="false"
          :search-placeholder="$t('platform.shared.searchNames')"
          :empty-title="$t('platform.notifications.rulesEmptyTitle')"
          :empty-description="$t('platform.notifications.rulesEmptyDescription')"
          :no-match-title="$t('platform.shared.noMatchesTitle')"
          :no-match-description="$t('platform.shared.noMatchesDescription')"
          @retry="rulesQuery.refresh"
        >
          <template #cell-name="{ row }">
            <div class="font-medium max-md:truncate">{{ row.name || row.id }}</div>
            <div class="mt-1 font-mono text-xs text-muted-foreground max-md:truncate">{{ row.id }}</div>
          </template>
          <template #row-detail="{ row }">
            <p
              v-if="ruleRoutesRenewals(row)"
              :class="cn('flex items-start gap-2 text-xs', renewalLine(row).warn ? 'text-warning-text' : 'text-muted-foreground')"
              data-testid="renewal-coverage"
            >
              <TriangleAlert v-if="renewalLine(row).warn" class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <CalendarClock v-else class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>
                {{ renewalLine(row).text }}
                <RouterLink
                  v-if="renewalLine(row).warn"
                  :to="{ name: 'inventory', query: { group: 'renewal' } }"
                  class="rounded-sm font-medium underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >{{ $t('platform.notifications.renewals.openInventory') }}</RouterLink>
              </span>
            </p>
            <p
              v-if="ruleRoutesNodeOffline(row)"
              :class="cn('flex items-start gap-2 text-xs', offlineLine(row).warn ? 'text-warning-text' : 'text-muted-foreground', ruleRoutesRenewals(row) && 'mt-1.5')"
              data-testid="offline-coverage"
            >
              <TriangleAlert v-if="offlineLine(row).warn" class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <Unplug v-else class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>{{ offlineLine(row).text }}</span>
            </p>
            <p
              v-if="ruleIncidentLine(row)"
              :class="cn('flex items-start gap-2 text-xs text-muted-foreground', (ruleRoutesRenewals(row) || ruleRoutesNodeOffline(row)) && 'mt-1.5')"
              data-testid="rule-incident-options"
            >
              <Moon class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>{{ ruleIncidentLine(row) }}</span>
            </p>
          </template>
          <template #cell-event_types="{ row }">
            <div class="flex flex-wrap gap-1">
              <Badge v-for="event in (row.event_types ?? [])" :key="event" variant="outline" class="font-mono text-[10px]">{{ event }}</Badge>
            </div>
          </template>
          <template #cell-channel_ids="{ row }">
            <div class="flex flex-wrap gap-1">
              <span v-if="!channelsRead" class="text-xs text-muted-foreground">{{ $t('platform.notifications.ruleChannelsUnread', { n: (row.channel_ids ?? []).length }, (row.channel_ids ?? []).length) }}</span>
              <template v-else>
                <Badge v-for="id in (row.channel_ids ?? [])" :key="id" :variant="channelKnown(id) ? 'secondary' : 'outline'">{{ channelKnown(id) ? channelName(id) : $t('platform.notifications.channelGone', { id }) }}</Badge>
                <span
                  v-if="row.fallback_channel_id"
                  class="inline-flex items-center gap-1 text-xs text-muted-foreground"
                  data-testid="rule-fallback"
                >
                  <CornerDownRight class="size-3.5" aria-hidden="true" />
                  {{ channelKnown(row.fallback_channel_id)
                    ? $t('platform.notifications.fallback.badge', { name: channelName(row.fallback_channel_id) })
                    : $t('platform.notifications.fallback.gone', { id: row.fallback_channel_id }) }}
                </span>
              </template>
            </div>
          </template>
          <template #cell-templates="{ row }">
            <div class="text-xs text-muted-foreground">
              <div>{{ row.title_template || $t('platform.notifications.defaultTitleTemplate') }}</div>
              <div>{{ row.body_template || $t('platform.notifications.defaultBodyTemplate') }}</div>
            </div>
          </template>
          <template #cell-enabled="{ row }">
            <!-- Enabled is the normal state and stays quiet text; only a turned-off row carries a badge. -->
            <span v-if="row.enabled" class="text-xs text-muted-foreground">{{ $t('common.status.enabled') }}</span>
            <Badge v-else variant="secondary">{{ $t('common.status.disabled') }}</Badge>
          </template>
          <template #cell-actions="{ row }">
            <RowMenu v-if="canManage" :name="row.name || row.id" :items="ruleMenu(row)" />
          </template>
        </DataTable>
      </CardContent>
    </Card>
    </template>

    <Card v-else-if="layer === 'sent'" data-testid="sent-log">
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Send aria-hidden="true" class="size-4 text-muted-foreground" />
          {{ $t('platform.notifications.sent.title') }}
        </CardTitle>
        <CardDescription class="space-y-1">
          <span class="block">{{ $t('platform.notifications.sent.description') }}</span>
          <ProofLine v-bind="sentProof" :segments="sentProofSegments" @retry="sentQueryState.refresh()" />
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataTable
          state-key="sent"
          :columns="sentColumns"
          :rows="sentRows"
          :row-key="(d) => d.id"
          :loading="sentQueryState.loading.value"
          :error="sentQueryState.error.value"
          :has-data="sentRead"
          :row-expanded="sentHasDetail"
          :row-click="(d, el) => sheet.open(d.id, el)"
          :active-row-id="sheet.openId.value"
          :page-size="50"
          narrow-layout="cards"
          :show-summary="false"
          :searchable="true"
          :expression-filter="false"
          :search-placeholder="$t('platform.notifications.sent.searchPlaceholder')"
          :empty-title="sentFiltered ? $t('platform.shared.noMatchesTitle') : $t('platform.notifications.sent.emptyTitle')"
          :empty-description="sentFiltered ? $t('platform.shared.noMatchesDescription') : $t('platform.notifications.sent.emptyDescription')"
          :no-match-title="$t('platform.shared.noMatchesTitle')"
          :no-match-description="$t('platform.shared.noMatchesDescription')"
          @retry="sentQueryState.refresh"
        >
          <template #toolbar>
            <div class="grid grid-cols-2 items-end gap-2 sm:flex sm:flex-wrap">
              <div class="grid min-w-0 gap-1">
                <Label for="sent-outcome" class="text-xs text-muted-foreground">{{ $t('platform.notifications.sent.filterOutcome') }}</Label>
                <Select v-model="sentOutcome">
                  <SelectTrigger id="sent-outcome" class="h-9 w-full min-w-0 pointer-coarse:h-11 sm:w-40" data-testid="sent-outcome">
                    <SelectValue class="min-w-0 overflow-hidden" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="outcome in SENT_OUTCOMES" :key="outcome" :value="outcome">
                      {{ $t(`platform.notifications.sent.outcomeFilter.${outcome}`) }}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div class="grid min-w-0 gap-1">
                <Label for="sent-channel" class="text-xs text-muted-foreground">{{ $t('platform.notifications.sent.filterChannel') }}</Label>
                <Select
                  :model-value="sentChannel || SELECT_DEFAULT"
                  @update:model-value="(value) => (sentChannel = fromSelectValue(String(value ?? '')))"
                >
                  <SelectTrigger id="sent-channel" class="h-9 w-full min-w-0 pointer-coarse:h-11 sm:w-44" data-testid="sent-channel">
                    <SelectValue class="min-w-0 overflow-hidden" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem :value="SELECT_DEFAULT">{{ $t('platform.notifications.sent.allChannels') }}</SelectItem>
                    <SelectItem v-for="channel in sortedChannels" :key="channel.id" :value="channel.id">
                      {{ channel.name || channel.id }}
                    </SelectItem>
                    <SelectItem v-if="sentChannel && channelsRead && !channelKnown(sentChannel)" :value="sentChannel">
                      {{ $t('platform.notifications.channelGone', { id: sentChannel }) }}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div class="col-span-2 grid min-w-0 gap-1">
                <Label for="sent-event" class="text-xs text-muted-foreground">{{ $t('platform.notifications.sent.filterEvent') }}</Label>
                <Select
                  :model-value="sentEvent || SELECT_DEFAULT"
                  @update:model-value="(value) => (sentEvent = fromSelectValue(String(value ?? '')))"
                >
                  <SelectTrigger id="sent-event" class="h-9 w-full min-w-0 pointer-coarse:h-11 sm:w-52" data-testid="sent-event">
                    <SelectValue class="min-w-0 overflow-hidden" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem :value="SELECT_DEFAULT">{{ $t('platform.notifications.sent.allEvents') }}</SelectItem>
                    <SelectItem v-for="event in sentEventOptions" :key="event" :value="event">
                      <span class="font-mono text-xs">{{ event }}</span>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button v-if="sentFiltered" variant="ghost" size="sm" class="col-span-2 h-9 justify-self-start pointer-coarse:h-11" data-testid="sent-clear" @click="clearSentFilters">
                {{ $t('platform.notifications.sent.clearFilters') }}
              </Button>
            </div>
          </template>
          <template #cell-created_at="{ row }">
            <span class="text-xs tabular text-muted-foreground" :title="formatDateTime(row.created_at)">{{ formatRelativeTime(row.created_at) }}</span>
          </template>
          <template #cell-message="{ row }">
            <div class="min-w-0 max-w-xl">
              <Badge variant="outline" class="h-auto max-w-full whitespace-normal break-all text-left font-mono text-[10px]">{{ row.event_type }}</Badge>
              <p class="mt-1 text-sm text-foreground max-md:break-words">{{ row.title || row.event_type }}</p>
              <p class="mt-0.5 text-xs text-muted-foreground max-md:break-words">{{ sentOrigin(row) }}</p>
            </div>
          </template>
          <template #cell-channel="{ row }">
            <div class="flex flex-wrap items-center gap-1.5">
              <span class="text-sm">{{ sentChannelLabel(row) }}</span>
              <Badge v-if="row.role === 'fallback' || row.role === 'test'" variant="outline" class="text-[10px]">{{ $t(`platform.notifications.sent.role.${row.role}`) }}</Badge>
            </div>
          </template>
          <template #cell-outcome="{ row }">
            <div class="flex flex-col items-start gap-1" data-testid="sent-outcome-cell" :data-state="sentState(row)">
              <span v-if="sentTone(sentState(row)) === 'quiet'" class="text-xs text-muted-foreground">{{ $t(`platform.notifications.sent.state.${sentState(row)}`) }}</span>
              <Badge v-else :variant="sentBadgeVariant(row)">{{ $t(`platform.notifications.sent.state.${sentState(row)}`) }}</Badge>
              <span v-if="(row.attempts?.length ?? 0) > 1" class="text-xs tabular text-muted-foreground">
                {{ $t('platform.notifications.sent.attempts', { n: row.attempts?.length ?? 0 }, row.attempts?.length ?? 0) }}
              </span>
              <span v-if="sentState(row) === 'retrying' && row.next_attempt_at" class="text-xs text-muted-foreground">
                {{ $t('platform.notifications.sent.nextTry', { when: formatRelativeTime(row.next_attempt_at) }) }}
              </span>
            </div>
          </template>
          <template #row-detail="{ row }">
            <div class="space-y-1 text-xs text-muted-foreground" data-testid="sent-detail">
              <p v-if="(sentState(row) === 'failed' || sentState(row) === 'retrying') && sentCause(row)" class="text-destructive">
                {{ causeText(sentCause(row)) }}
              </p>
              <p v-if="sentNote(row)">{{ sentNoteText(row) }}</p>
              <p v-if="sentOccurrences(row)" data-testid="sent-occurrences">{{ sentOccurrencesText(row) }}</p>
              <p v-if="row.role === 'fallback' && row.fallback_for">{{ $t(row.fallback_of ? 'platform.notifications.sent.fallbackOf' : 'platform.notifications.sent.fallbackFor', { names: row.fallback_for }) }}</p>
            </div>
          </template>
        </DataTable>
      </CardContent>
    </Card>

    <ObjectSheet
      v-if="layer === 'sent'"
      :open="!!sheet.openId.value"
      :title="openDelivery ? (openDelivery.title || openDelivery.event_type) : (sheet.openId.value ?? '')"
      :subtitle="openDelivery ? `${openDelivery.event_type} · ${sentChannelLabel(openDelivery)}` : undefined"
      :state="sheetState"
      :error="sentQueryState.error.value?.message ?? null"
      :return-focus="sheet.returnFocus"
      :gone-title="$t('platform.notifications.sent.sheet.goneTitle')"
      :gone-description="$t('platform.notifications.sent.sheet.goneDescription')"
      @close="sheet.close"
      @retry="sentQueryState.refresh()"
    >
      <div v-if="openDelivery" class="space-y-5 text-sm" data-testid="sent-sheet">
        <div class="flex flex-wrap items-center gap-2">
          <span v-if="sentTone(sentState(openDelivery)) === 'quiet'" class="text-sm font-medium">{{ $t(`platform.notifications.sent.state.${sentState(openDelivery)}`) }}</span>
          <Badge v-else :variant="sentBadgeVariant(openDelivery)">{{ $t(`platform.notifications.sent.state.${sentState(openDelivery)}`) }}</Badge>
          <Badge v-if="openDelivery.role === 'fallback' || openDelivery.role === 'test'" variant="outline">{{ $t(`platform.notifications.sent.role.${openDelivery.role}`) }}</Badge>
          <span v-if="(openDelivery.attempts?.length ?? 0) > 0" class="text-xs tabular text-muted-foreground">
            {{ $t('platform.notifications.sent.attempts', { n: openDelivery.attempts?.length ?? 0 }, openDelivery.attempts?.length ?? 0) }}
          </span>
        </div>
        <div v-if="sentHasDetail(openDelivery)" class="space-y-1 text-sm">
          <p v-if="(sentState(openDelivery) === 'failed' || sentState(openDelivery) === 'retrying') && sentCause(openDelivery)" class="text-destructive">
            {{ causeText(sentCause(openDelivery)) }}
          </p>
          <p v-if="sentNote(openDelivery)" class="text-muted-foreground">{{ sentNoteText(openDelivery) }}</p>
          <p v-if="sentOccurrences(openDelivery)" class="text-muted-foreground">{{ sentOccurrencesText(openDelivery) }}</p>
          <p v-if="openDelivery.role === 'fallback' && openDelivery.fallback_for" class="text-muted-foreground">{{ $t(openDelivery.fallback_of ? 'platform.notifications.sent.fallbackOf' : 'platform.notifications.sent.fallbackFor', { names: openDelivery.fallback_for }) }}</p>
          <p v-if="sentState(openDelivery) === 'retrying' && openDelivery.next_attempt_at" class="text-muted-foreground">
            {{ $t('platform.notifications.sent.nextTry', { when: formatRelativeTime(openDelivery.next_attempt_at) }) }}
          </p>
        </div>

        <section class="space-y-1.5">
          <h3 class="text-xs font-medium text-muted-foreground">{{ $t('platform.notifications.sent.sheet.message') }}</h3>
          <p v-if="openDelivery.truncated" class="text-xs text-muted-foreground" data-testid="sent-truncated">{{ $t('platform.notifications.sent.sheet.truncated') }}</p>
          <div class="rounded-md border border-border px-3 py-2">
            <p class="font-medium break-words">{{ openDelivery.title || openDelivery.event_type }}</p>
            <p v-if="openDelivery.body" class="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">{{ openDelivery.body }}</p>
            <p v-else class="mt-1 text-xs text-muted-foreground">{{ $t('platform.notifications.sent.sheet.noBody') }}</p>
          </div>
        </section>

        <section v-if="openDelivery.attempts?.length" class="space-y-1.5">
          <h3 class="text-xs font-medium text-muted-foreground">{{ $t('platform.notifications.sent.receipts') }}</h3>
          <ol class="divide-y divide-border rounded-md border border-border" data-testid="sent-receipts">
            <li v-for="(attempt, index) in openDelivery.attempts" :key="index" class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-3 py-2 text-xs">
              <span class="tabular text-muted-foreground">{{ formatDateTime(attempt.at) }}</span>
              <span :class="attempt.ok ? 'text-foreground' : 'text-destructive'">{{ attempt.ok ? $t('platform.notifications.sent.receiptOk') : causeText(sentCause({ attempts: [attempt] })) }}</span>
              <span class="tabular text-muted-foreground">{{ $t('platform.notifications.sent.receiptMs', { ms: attempt.duration_ms }) }}</span>
            </li>
          </ol>
        </section>

        <section class="space-y-1.5">
          <h3 class="text-xs font-medium text-muted-foreground">{{ $t('platform.notifications.sent.sheet.details') }}</h3>
          <dl class="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
            <dt class="text-muted-foreground">{{ $t('platform.notifications.sent.sheet.origin') }}</dt>
            <dd class="break-words">{{ sentOrigin(openDelivery) }}</dd>
            <dt class="text-muted-foreground">{{ $t('platform.notifications.sent.colChannel') }}</dt>
            <dd class="break-words">{{ sentChannelLabel(openDelivery) }}<span v-if="openDelivery.channel_kind" class="text-muted-foreground"> · {{ openDelivery.channel_kind }}</span></dd>
            <dt class="text-muted-foreground">{{ $t(sentOccurrences(openDelivery) ? 'platform.notifications.sent.sheet.firstSeen' : 'platform.notifications.sent.sheet.created') }}</dt>
            <dd class="tabular">{{ formatDateTime(openDelivery.created_at) }}</dd>
            <template v-if="sentOccurrences(openDelivery)">
              <dt class="text-muted-foreground">{{ $t('platform.notifications.sent.sheet.lastSeen') }}</dt>
              <dd class="tabular">{{ formatDateTime(sentOccurrences(openDelivery)?.last ?? openDelivery.created_at) }}</dd>
            </template>
            <template v-if="openDelivery.settled_at && !sentOccurrences(openDelivery)">
              <dt class="text-muted-foreground">{{ $t('platform.notifications.sent.sheet.settled') }}</dt>
              <dd class="tabular">{{ formatDateTime(openDelivery.settled_at) }}</dd>
            </template>
            <dt class="text-muted-foreground">{{ $t('platform.notifications.sent.sheet.eventId') }}</dt>
            <dd class="break-all font-mono">{{ openDelivery.event_id }}</dd>
            <dt class="text-muted-foreground">{{ $t('platform.notifications.sent.sheet.deliveryId') }}</dt>
            <dd class="break-all font-mono">{{ openDelivery.id }}</dd>
            <template v-if="openDelivery.fallback_of">
              <dt class="text-muted-foreground">{{ $t('platform.notifications.sent.sheet.standsFor') }}</dt>
              <dd>
                <button
                  type="button"
                  class="rounded-sm text-left font-medium underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-primary pointer-coarse:py-1"
                  data-testid="sent-stands-for"
                  @click="sheet.open(openDelivery.fallback_of)"
                >{{ $t('platform.notifications.sent.sheet.failedDelivery') }}</button>
              </dd>
            </template>
          </dl>
        </section>
      </div>
    </ObjectSheet>

    <!-- Create / edit dialog -->
    <Dialog v-model:open="formOpen">
      <DialogScrollContent class="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{{ editingId ? $t('platform.notifications.editChannelTitle') : $t('platform.notifications.newChannelTitle') }}</DialogTitle>
          <DialogDescription>
            {{ $t('platform.notifications.formHint') }}
          </DialogDescription>
        </DialogHeader>

        <form class="space-y-4" @submit.prevent="submitForm">
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="ch-name">{{ $t('platform.notifications.nameLabel') }}</Label>
              <Input id="ch-name" v-model="formName" required placeholder="ops-alerts" />
            </div>
            <div class="grid gap-2">
              <Label for="ch-kind">{{ $t('platform.notifications.kindLabel') }}</Label>
              <Select v-model="formKind" @update:model-value="onKindChange">
                <SelectTrigger id="ch-kind">
                  <SelectValue :placeholder="$t('platform.notifications.selectKind')" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="kind in KIND_OPTIONS" :key="kind" :value="kind">
                    {{ kind }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div class="space-y-3 rounded-md border border-border p-3">
            <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('platform.notifications.kindConfig', { kind: formKind }) }}</p>
            <div v-for="field in activeFields" :key="field.key" class="grid gap-2">
              <Label :for="`cfg-${field.key}`">
                {{ $t(field.label) }}
                <span v-if="field.required && !secretsOptional" class="text-destructive">*</span>
                <span v-else-if="field.required" class="text-xs font-normal text-muted-foreground">
                  ({{ $t('common.misc.keepBlank') }})
                </span>
                <span v-else-if="isStored(field.key)" class="text-xs font-normal text-warning">
                  ({{ $t('platform.notifications.storedOptionalHint') }})
                </span>
                <span v-else class="text-xs font-normal text-muted-foreground">
                  ({{ $t('common.misc.optional') }})
                </span>
              </Label>
              <Select
                v-if="field.options"
                :model-value="toSelectValue(formConfig[field.key] ?? '')"
                @update:model-value="(value) => (formConfig[field.key] = fromSelectValue(String(value ?? '')))"
              >
                <SelectTrigger :id="`cfg-${field.key}`">
                  <SelectValue :placeholder="isStored(field.key) ? $t('platform.notifications.storedPlaceholder') : $t(field.placeholder)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem :value="SELECT_DEFAULT">{{ $t(field.placeholder) }}</SelectItem>
                  <SelectItem v-for="option in field.options" :key="option" :value="option">
                    {{ option }}
                  </SelectItem>
                </SelectContent>
              </Select>
              <Input
                v-else
                :id="`cfg-${field.key}`"
                v-model="formConfig[field.key]"
                :placeholder="isStored(field.key) && !field.required
                  ? $t('platform.notifications.storedPlaceholder')
                  : secretsOptional && field.required
                    ? $t('common.misc.keepBlank')
                    : (field.placeholder.startsWith('platform.') ? $t(field.placeholder) : field.placeholder)"
                autocomplete="off"
              />
              <p v-if="field.hint" class="text-xs text-muted-foreground">{{ $t(field.hint) }}</p>
            </div>
            <p v-if="kindChanged" class="text-xs text-warning">
              {{ $t('platform.notifications.kindChangedHint') }}
            </p>
            <p v-else-if="editingId" class="text-xs text-muted-foreground">
              {{ $t('platform.notifications.replaceConfigHint') }}
            </p>
            <label
              v-if="saveGate.dropped.length > 0"
              class="flex cursor-pointer items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-sm"
            >
              <Checkbox v-model="clearAcknowledged" class="mt-0.5" />
              <span>{{ $t('platform.notifications.clearStoredLabel', { keys: saveGate.dropped.join(', ') }) }}</span>
            </label>
          </div>

          <label class="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox v-model="formEnabled" />
            <span>{{ $t('platform.notifications.enabledLabel') }}</span>
          </label>

          <div v-if="formFallbackChoices.length > 0 || formFallback" class="grid min-w-0 gap-2">
            <Label for="ch-fallback">{{ $t('platform.notifications.channelFallback.label') }}</Label>
            <Select
              :model-value="formFallback || SELECT_DEFAULT"
              @update:model-value="(value) => (formFallback = fromSelectValue(String(value ?? '')))"
            >
              <SelectTrigger id="ch-fallback" class="min-w-0 sm:w-80" data-testid="channel-fallback-select">
                <SelectValue class="min-w-0 overflow-hidden" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem :value="SELECT_DEFAULT">{{ $t('platform.notifications.channelFallback.none') }}</SelectItem>
                <SelectItem v-for="channel in formFallbackChoices" :key="channel.id" :value="channel.id">
                  {{ channel.name || channel.id }} · {{ channel.kind }}
                </SelectItem>
                <SelectItem v-if="formFallback && !channelKnown(formFallback)" :value="formFallback">
                  {{ $t('platform.notifications.channelGone', { id: formFallback }) }}
                </SelectItem>
              </SelectContent>
            </Select>
            <p class="text-xs text-muted-foreground">{{ $t('platform.notifications.channelFallback.hint', { events: criticalEvents.join(', ') }) }}</p>
          </div>

          <div class="space-y-3 rounded-md border border-dashed border-border p-3">
            <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('platform.notifications.sendTest') }}</p>
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div class="grid gap-2">
                <Label for="test-title">{{ $t('platform.notifications.testTitleLabel') }}</Label>
                <Input id="test-title" v-model="formTitle" :placeholder="$t('platform.notifications.testTitlePlaceholder')" />
              </div>
              <div class="grid gap-2">
                <Label for="test-body">{{ $t('platform.notifications.testBodyLabel') }}</Label>
                <Input id="test-body" v-model="formBody" :placeholder="$t('platform.notifications.testBodyPlaceholder')" />
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              :disabled="testing || !configComplete || !canSend"
              :title="!canSend ? $t('platform.notifications.sendScopeMissing') : undefined"
              @click="sendTest"
            >
              <RefreshCw v-if="testing" aria-hidden="true" class="size-4 animate-spin" />
              <Send v-else aria-hidden="true" class="size-4" />
              {{ $t('platform.notifications.sendTest') }}
            </Button>
            <p class="text-xs text-muted-foreground">
              {{ $t('platform.notifications.testThroughConfigHint') }}
            </p>
          </div>

          <DialogFooter>
            <DialogClose as-child>
              <Button type="button" variant="outline">{{ $t('common.actions.cancel') }}</Button>
            </DialogClose>
            <Button type="submit" :disabled="saving || !canSubmit">
              <RefreshCw v-if="saving" aria-hidden="true" class="size-4 animate-spin" />
              <Plus v-else-if="!editingId" aria-hidden="true" class="size-4" />
              <Pencil v-else aria-hidden="true" class="size-4" />
              {{ editingId ? $t('common.actions.save') : $t('common.actions.create') }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <!-- Rule dialog -->
    <Dialog v-model:open="ruleOpen">
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ ruleEditingId ? $t('platform.notifications.editRuleTitle') : $t('platform.notifications.newRuleTitle') }}</DialogTitle>
          <DialogDescription>
            {{ $t('platform.notifications.ruleFormHint') }}
          </DialogDescription>
        </DialogHeader>

        <form class="space-y-4" @submit.prevent="submitRule">
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="rule-name">{{ $t('platform.notifications.ruleNameLabel') }}</Label>
              <Input id="rule-name" v-model="ruleName" required placeholder="critical-monitor-alerts" />
            </div>
            <div class="grid gap-2">
              <Label for="rule-events">{{ $t('platform.notifications.ruleEventsLabel') }}</Label>
              <Input id="rule-events" v-model="ruleEvents" required placeholder="monitor.down, monitor.recovered" />
            </div>
          </div>

          <div class="space-y-2 rounded-md border border-border p-3">
            <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('platform.notifications.availableEvents') }}</p>
            <div class="flex flex-wrap gap-1">
              <Badge v-for="event in EVENT_OPTIONS" :key="event" variant="outline" class="font-mono text-[10px]">{{ event }}</Badge>
            </div>
            <p class="text-xs text-muted-foreground">{{ $t('platform.notifications.ruleEventsHint') }}</p>
            <p class="text-xs text-muted-foreground">{{ $t('platform.notifications.nodeOfflineHint') }}</p>
            <p class="text-xs text-muted-foreground">{{ $t('platform.notifications.channelFailingHint') }}</p>
          </div>

          <div class="space-y-2 rounded-md border border-border p-3">
            <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('platform.notifications.ruleChannelsLabel') }}</p>
            <div v-if="sortedChannels.length > 0" class="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label
                v-for="channel in sortedChannels"
                :key="channel.id"
                class="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"
              >
                <Checkbox
                  :model-value="ruleChannelIds.includes(channel.id)"
                  @update:model-value="(v) => toggleRuleChannel(channel.id, v === true)"
                />
                <span class="min-w-0">
                  <span class="block truncate font-medium" :title="channel.name || channel.id">{{ channel.name || channel.id }}</span>
                  <span
                    class="block truncate text-xs text-muted-foreground"
                    :title="`${channel.kind} · ${channel.id}`"
                  >{{ channel.kind }} · {{ channel.id }}</span>
                </span>
              </label>
            </div>
            <p v-else-if="!channelsRead" class="text-sm text-muted-foreground" data-testid="rule-channels-unread">{{ $t('platform.notifications.ruleFormChannelsUnread') }}</p>
            <p v-else class="text-sm text-muted-foreground">{{ $t('platform.notifications.createChannelFirst') }}</p>
          </div>

          <div v-if="sortedChannels.length > 1 || ruleFallback" class="grid min-w-0 gap-2">
            <Label for="rule-fallback">{{ $t('platform.notifications.fallback.label') }}</Label>
            <Select
              :model-value="ruleFallback || SELECT_DEFAULT"
              @update:model-value="(value) => (ruleFallback = fromSelectValue(String(value ?? '')))"
            >
              <!-- A long channel name must not set the dialog's width: the value clips inside the trigger. -->
              <SelectTrigger id="rule-fallback" class="min-w-0 sm:w-80" data-testid="rule-fallback-select">
                <SelectValue class="min-w-0 overflow-hidden" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem :value="SELECT_DEFAULT">{{ $t('platform.notifications.fallback.none') }}</SelectItem>
                <SelectItem v-for="channel in ruleFallbackChoices" :key="channel.id" :value="channel.id">
                  {{ channel.name || channel.id }} · {{ channel.kind }}
                </SelectItem>
                <SelectItem v-if="ruleFallback && !channelKnown(ruleFallback)" :value="ruleFallback">
                  {{ $t('platform.notifications.channelGone', { id: ruleFallback }) }}
                </SelectItem>
              </SelectContent>
            </Select>
            <p class="text-xs text-muted-foreground">{{ $t('platform.notifications.fallback.hint') }}</p>
          </div>

          <!-- What happens to an incident this rule routes: re-sent when nobody acknowledges it, held at night. -->
          <fieldset class="space-y-3 rounded-md border border-border p-3" data-testid="rule-incident-fields">
            <legend class="px-1 text-xs font-medium uppercase text-muted-foreground">{{ $t('platform.notifications.incidents.legend') }}</legend>
            <label class="flex cursor-pointer items-start gap-2 text-sm pointer-coarse:min-h-11 pointer-coarse:items-center">
              <Checkbox v-model="ruleIncident.escalate" class="mt-0.5 pointer-coarse:mt-0" />
              <span>{{ $t('platform.notifications.incidents.escalate') }}</span>
            </label>
            <div v-if="ruleIncident.escalate" class="grid grid-cols-1 gap-3 ps-6 sm:grid-cols-2">
              <div class="grid gap-1.5">
                <Label for="rule-escalate-after" class="text-xs">{{ $t('platform.notifications.incidents.after') }}</Label>
                <Input
                  id="rule-escalate-after"
                  v-model="ruleIncident.afterMinutes"
                  type="number"
                  inputmode="numeric"
                  :min="ESCALATE_MIN_MINUTES"
                  :max="ESCALATE_MAX_MINUTES"
                  step="1"
                  class="sm:w-32"
                  :aria-invalid="ruleIncidentErrorList.includes('after') || undefined"
                />
              </div>
              <div class="grid min-w-0 gap-1.5">
                <Label for="rule-escalate-level" class="text-xs">{{ $t('platform.notifications.incidents.level') }}</Label>
                <Select v-model="ruleIncident.barkLevel">
                  <SelectTrigger id="rule-escalate-level" class="min-w-0 sm:w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="level in BARK_LEVELS" :key="level" :value="level">{{ $t(`platform.notifications.incidents.levels.${level}`) }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p class="text-xs text-muted-foreground">{{ $t('platform.notifications.incidents.escalateHint') }}</p>
            <p v-if="ruleIncidentErrorList.includes('after')" class="text-xs text-destructive">
              {{ $t('platform.notifications.incidents.errors.after', { min: ESCALATE_MIN_MINUTES, max: ESCALATE_MAX_MINUTES }) }}
            </p>

            <label class="flex cursor-pointer items-start gap-2 border-t border-border pt-3 text-sm pointer-coarse:min-h-11 pointer-coarse:items-center">
              <Checkbox v-model="ruleIncident.quiet" class="mt-0.5 pointer-coarse:mt-0" />
              <span>{{ $t('platform.notifications.incidents.quiet') }}</span>
            </label>
            <div v-if="ruleIncident.quiet" class="grid grid-cols-2 gap-3 ps-6 sm:grid-cols-[8rem_8rem_minmax(0,1fr)]">
              <div class="grid gap-1.5">
                <Label for="rule-quiet-start" class="text-xs">{{ $t('platform.notifications.incidents.from') }}</Label>
                <Input id="rule-quiet-start" v-model="ruleIncident.quietStart" type="time" :aria-invalid="ruleIncidentErrorList.some((e) => e === 'quietTimes' || e === 'quietSame') || undefined" />
              </div>
              <div class="grid gap-1.5">
                <Label for="rule-quiet-end" class="text-xs">{{ $t('platform.notifications.incidents.to') }}</Label>
                <Input id="rule-quiet-end" v-model="ruleIncident.quietEnd" type="time" :aria-invalid="ruleIncidentErrorList.some((e) => e === 'quietTimes' || e === 'quietSame') || undefined" />
              </div>
              <div class="col-span-2 grid min-w-0 gap-1.5 sm:col-span-1">
                <Label for="rule-quiet-zone" class="text-xs">{{ $t('platform.notifications.incidents.zone') }}</Label>
                <Input
                  id="rule-quiet-zone"
                  v-model="ruleIncident.quietZone"
                  list="rule-quiet-zones"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="Asia/Shanghai"
                  :aria-invalid="ruleIncidentErrorList.includes('quietZone') || undefined"
                />
                <datalist id="rule-quiet-zones">
                  <option v-for="zone in timeZoneChoices" :key="zone" :value="zone" />
                </datalist>
              </div>
            </div>
            <p class="text-xs text-muted-foreground">{{ $t('platform.notifications.incidents.quietHint') }}</p>
            <p v-for="error in ruleIncidentErrorList.filter((e) => e !== 'after')" :key="error" class="text-xs text-destructive">
              {{ $t(`platform.notifications.incidents.errors.${error}`) }}
            </p>
          </fieldset>

          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="rule-title-template">{{ $t('platform.notifications.titleTemplateLabel') }}</Label>
              <Input id="rule-title-template" v-model="ruleTitleTemplate" placeholder="[{{event_type}}] {{title}}" />
            </div>
            <div class="grid gap-2">
              <Label for="rule-body-template">{{ $t('platform.notifications.bodyTemplateLabel') }}</Label>
              <Input id="rule-body-template" v-model="ruleBodyTemplate" placeholder="{{body}}" />
            </div>
          </div>
          <p class="text-xs text-muted-foreground">{{ $t('platform.notifications.templateVarsHint') }}</p>

          <label class="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox v-model="ruleEnabled" />
            <span>{{ $t('platform.notifications.ruleEnabledLabel') }}</span>
          </label>

          <DialogFooter>
            <DialogClose as-child>
              <Button type="button" variant="outline">{{ $t('common.actions.cancel') }}</Button>
            </DialogClose>
            <Button type="submit" :disabled="ruleSaving || !canSubmitRule">
              <RefreshCw v-if="ruleSaving" aria-hidden="true" class="size-4 animate-spin" />
              <GitBranch v-else aria-hidden="true" class="size-4" />
              {{ ruleEditingId ? $t('common.actions.save') : $t('common.actions.create') }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <!-- Delete confirmation -->
    <ConfirmDialog
      :open="!!deleteTarget"
      :title="$t('platform.notifications.deleteChannelTitle')"
      :description="$t('platform.notifications.deleteChannelConfirm', { name: deleteTarget?.name || deleteTarget?.id })"
      :impact="channelDeleteImpact.lines"
      :typed-confirm="channelDeleteImpact.typed ? deleteTarget?.name || deleteTarget?.id : undefined"
      :confirm-label="$t('common.actions.delete')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="deleting"
      @update:open="(v) => { if (!v) deleteTarget = undefined; }"
      @confirm="confirmDelete"
    />

    <!-- Delete rule confirmation -->
    <ConfirmDialog
      :open="!!deleteRuleTarget"
      :title="$t('platform.notifications.deleteRuleTitle')"
      :description="$t('platform.notifications.deleteRuleConfirm', { name: deleteRuleTarget?.name || deleteRuleTarget?.id })"
      :confirm-label="$t('common.actions.delete')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="deletingRule"
      @update:open="(v) => { if (!v) deleteRuleTarget = undefined; }"
      @confirm="confirmDeleteRule"
    />
  </div>
</template>
