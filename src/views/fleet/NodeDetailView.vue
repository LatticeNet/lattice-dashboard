<script setup lang="ts">
/**
 * NodeDetailView: the deep-linkable, full-page node detail (route
 * `node-detail`, path `/nodes/:id`). Replaces the cramped `?node=` modal that
 * used to live in NodesView: a whole node card now navigates here.
 *
 * The server exposes NO single-node GET, so v1 sources the node by finding it in
 * the polled `api.nodes.list()` (~5s, same cadence as the other fleet views) and
 * synthesizes an in-session sparkline from the shared {@link useMetricBuffer}.
 * Side panels (groups / DDNS / agent-updates / audit) are softened on 403 so a
 * read-only operator sees a quiet section rather than an error wall.
 */
import { computed, watch, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter, type RouteLocationRaw } from "vue-router";
import { toast } from "vue-sonner";
import {
  Activity,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Boxes,
  Clock,
  Crown,
  DownloadCloud,
  FolderTree,
  Gauge,
  Globe,
  Info,
  KeyRound,
  MapPin,
  Pencil,
  Power,
  RadioTower,
  RefreshCw,
  RotateCw,
  Server,
  ListOrdered,
  ScrollText,
  ShieldCheck,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-vue-next";
import {
  api,
  unwrap,
  ApiError,
  isAgentUpdateNoopError,
  type AgentLaunchConfig,
  type AgentRuntimeConfig,
  type Node,
  type GroupView,
  type DDNSView,
  type AgentUpdatePolicy,
  type AuditEvent,
  type ApprovalView,
  type TaskResult,
  type TaskView,
  type NodeDeletePlanView,
  type NodeCapability,
  type NodeCapabilityEffective,
} from "@/lib/api";
import {
  buildNodeTimeline,
  groupByDay,
  type TimelineEntry,
} from "./nodeTimelineModel";
import { buildNodeQueue, type NodeQueueEntry } from "./nodeTaskQueueModel";
import { leaseAttemptLabel, stalledText, taskStateStyle } from "@/lib/taskLease";
import { useAsyncData } from "@/composables/useAsyncData";
import { useMetricBuffer } from "@/composables/useMetricBuffer";
import { useAuthStore } from "@/stores/auth";
import { hasNeverReported, statusMeta } from "@/lib/status";
import { describeNodeStatus, isReporting, metricFreshness, nodeStatusReason, nodeStatusSince } from "@/lib/nodeStatus";
import { groupColor } from "@/lib/groupColors";
import {
  formatBytes,
  formatBytesPerSec,
  formatDateTime,
  formatRelativeTime,
  formatDuration,
  NO_VALUE,
  shortId,
} from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import DataState from "@/components/common/DataState.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import CopyButton from "@/components/common/CopyButton.vue";
import MetricBar from "@/components/common/MetricBar.vue";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from "@/components/ui/dialog";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const nodeId = computed(() => String(route.params.id ?? ""));

const canAdminNodes = computed(() => auth.can("node:admin"));
const canPlanUpdates = computed(() => auth.can("node:admin") && auth.can("network:plan"));
const canOpenTerminal = computed(() => auth.can("terminal:open"));

/** Treat 403 as "section not visible" rather than a hard error (per OverviewView). */
function soften<T>(fetcher: (signal: AbortSignal) => Promise<T>) {
  return async (signal: AbortSignal): Promise<T | undefined> => {
    try {
      return await fetcher(signal);
    } catch (e) {
      if (e instanceof ApiError && e.isForbidden) return undefined;
      throw e;
    }
  };
}

/* ----------------------------------------------------------------- */
/* Data sources: node list is the spine; the rest are softened side   */
/* panels keyed off this node's id.                                    */
/* ----------------------------------------------------------------- */
const nodesQuery = useAsyncData((signal) => api.nodes.list({ signal }).then((r) => unwrap(r, "nodes")), {
  pollInterval: 5000,
});

const groupsQuery = useAsyncData<GroupView[] | undefined>(
  soften((signal) => api.groups.list({ signal }).then((r) => r.groups)),
);

const ddnsQuery = useAsyncData<DDNSView[] | undefined>(soften((signal) => api.ddns.list({ signal })));

/**
 * Capability enrolment: which capabilities are allowed to act on this node.
 *
 * This is the page that owns the decision, because it is a decision about the
 * node and not about whatever form happens to be open elsewhere. Excluding in
 * particular belongs here: it needs a reason, and a reason typed into a
 * capability's own screen tends to describe that screen rather than the machine.
 */
/**
 * The effective answer per capability for this node, not just the stored
 * records. A node can be allowed with no record at all, because its own older
 * configuration already says so - sing-box discovery switched on puts a node in
 * scope for sing-box management without anyone enrolling it. Listing only
 * records would show that as "not decided", which reads as blocked.
 */
const capabilitiesQuery = useAsyncData<NodeCapabilityEffective[] | undefined>(
  soften((signal) => api.nodes.nodeCapabilities(nodeId.value, { signal }).then((r) => r.effective ?? [])),
);

const nodeCapabilities = computed(() => capabilitiesQuery.data.value ?? []);

function capabilityState(capability: string): NodeCapabilityEffective | undefined {
  return nodeCapabilities.value.find((c) => c.capability === capability);
}

interface CapabilityRow {
  capability: string;
  record?: NodeCapabilityEffective;
  enforced: boolean;
}

const allCapabilityRows = computed<CapabilityRow[]>(() =>
  nodeCapabilities.value.map((c) => ({
    capability: c.capability,
    record: c,
    enforced: c.enforced,
  })),
);

/**
 * What is worth an operator's attention: the capabilities whose gate is live,
 * plus anything already decided.
 *
 * Listing all fifteen would put fourteen inert rows beside the one that
 * currently decides anything, each offering Enrol and Exclude buttons that
 * change nothing observable. That reads as fifteen equal decisions and it is
 * not one - it is one decision and fourteen placeholders. The rest stay one
 * click away for whoever is preparing the next capability's rollout.
 */
const capabilityRows = computed(() =>
  allCapabilityRows.value.filter((row) => row.enforced || row.record?.state),
);
const dormantCapabilityRows = computed(() =>
  allCapabilityRows.value.filter((row) => !row.enforced && !row.record?.state),
);
const showDormantCapabilities = ref(false);

/**
 * How one capability's answer reads. Four cases, and they are genuinely
 * different work: explicitly excluded (someone decided against it), explicitly
 * enrolled, allowed because the node is already configured for it, and nobody
 * has decided. Collapsing the third into the fourth is what made a working
 * sing-box node look blocked.
 */
function capabilityBadge(record?: NodeCapabilityEffective): {
  variant: "success" | "destructive" | "outline" | "secondary";
  label: string;
} {
  if (record?.state === "excluded") {
    return { variant: "destructive", label: t("fleet.nodes.detail.capabilities.state.excluded") };
  }
  if (record?.state === "enrolled") {
    return { variant: "success", label: t("fleet.nodes.detail.capabilities.state.enrolled") };
  }
  if (record?.allowed && record.source === "derived") {
    return { variant: "secondary", label: t("fleet.nodes.detail.capabilities.state.fromConfig") };
  }
  return { variant: "outline", label: t("fleet.nodes.detail.capabilities.state.undecided") };
}

/** The sentence under the capability name: the operator's own reason when they
 *  recorded one, otherwise why the gate would answer the way it does. */
function capabilityNote(record?: NodeCapabilityEffective): string {
  if (!record) return "";
  if (record.record_reason) return record.record_reason;
  if (record.source === "derived") {
    return record.allowed
      ? t("fleet.nodes.detail.capabilities.derivedAllowed")
      : t("fleet.nodes.detail.capabilities.derivedDenied");
  }
  if (record.state) return "";
  if (!record.enforced) return t("fleet.nodes.detail.capabilities.notEnforced");
  return "";
}

const capabilityPending = ref("");
const excludeOpen = ref(false);
const excludeCapability = ref("");
const excludeReason = ref("");

async function setCapability(capability: string, state: "enrolled" | "excluded" | "", reason?: string) {
  if (capabilityPending.value) return;
  capabilityPending.value = capability;
  try {
    await api.nodes.setCapability({ node_id: nodeId.value, capability, state, reason });
    toast.success(t("fleet.nodes.detail.capabilities.saved"));
    capabilitiesQuery.refresh();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  } finally {
    capabilityPending.value = "";
  }
}

function openExclude(capability: string) {
  excludeCapability.value = capability;
  excludeReason.value = capabilityState(capability)?.reason ?? "";
  excludeOpen.value = true;
}

async function confirmExclude() {
  if (!excludeReason.value.trim()) return;
  const capability = excludeCapability.value;
  excludeOpen.value = false;
  await setCapability(capability, "excluded", excludeReason.value.trim());
  excludeReason.value = "";
}

const agentUpdatesQuery = useAsyncData<AgentUpdatePolicy[] | undefined>(
  soften((signal) => api.agentUpdates.list({ signal }).then((r) => unwrap(r, "policies"))),
);

const auditQuery = useAsyncData<AuditEvent[] | undefined>(
  soften((signal) => api.audit.query({ node_id: nodeId.value, limit: 40 }, { signal }).then((r) => r.events ?? [])),
  { pollInterval: 15000 },
);

// The timeline's other two sources. Both are soft: a node page must still
// render when the operator cannot read tasks or approvals, and the timeline
// then simply shows fewer kinds of event rather than an error.
// Filtered by the server. The unfiltered list is every task the fleet has ever
// run and it grows without bound: measured at 3.2s on this fleet, on a page that
// polls it every twenty seconds and then throws away all but one node's rows.
const nodeTasksQuery = useAsyncData<TaskView[] | undefined>(
  soften((signal) => api.tasks.listForNode(nodeId.value, 100, { signal }).then((r) => unwrap(r, "tasks"))),
  { pollInterval: 20000 },
);
const nodeResultsQuery = useAsyncData<TaskResult[] | undefined>(
  soften((signal) => api.tasks.results({ node_id: nodeId.value, limit: 40 }, { signal }).then((r) => unwrap(r, "results"))),
  { pollInterval: 20000 },
);
const nodeApprovalsQuery = useAsyncData<ApprovalView[] | undefined>(
  soften((signal) => api.approvals.list(undefined, { signal }).then((r) => unwrap(r, "approvals"))),
  { pollInterval: 20000 },
);

const node = computed<Node | undefined>(() =>
  (nodesQuery.data.value ?? []).find((n) => n.id === nodeId.value),
);

const launchAllowExec = ref(false);
const launchAllowRootExec = ref(false);
const launchNoExec = ref(false);
const launchAllowTerminal = ref(false);
const launchTerminalTransport = ref<"poll" | "stream">("stream");
const launchSSHAlerts = ref(false);
const launchPlatform = ref<"linux" | "manual">("linux");
const reconfigurePending = ref(false);
const reconfigureResult = ref<{ command: string; commands?: Record<string, string>; agent_launch?: AgentLaunchConfig } | undefined>();

function seedLaunchDraft(n?: Node) {
  const launch = n?.agent_launch;
  launchAllowExec.value = !!launch?.allow_exec;
  launchAllowRootExec.value = !!launch?.allow_root_exec;
  launchNoExec.value = !!launch?.no_exec;
  launchAllowTerminal.value = !!launch?.allow_terminal;
  launchTerminalTransport.value = launch?.terminal_transport === "poll" ? "poll" : "stream";
  launchSSHAlerts.value = !!launch?.ssh_alerts;
  reconfigureResult.value = undefined;
}

watch(
  () => node.value?.id,
  () => seedLaunchDraft(node.value),
  { immediate: true },
);

function launchPayload(): AgentLaunchConfig {
  return {
    allow_exec: launchAllowExec.value,
    allow_root_exec: launchAllowRootExec.value,
    no_exec: launchNoExec.value,
    allow_terminal: launchAllowTerminal.value,
    terminal_transport: launchAllowTerminal.value ? launchTerminalTransport.value : undefined,
    ssh_alerts: launchSSHAlerts.value,
  };
}

type AgentProfileLike = AgentLaunchConfig | AgentRuntimeConfig | null | undefined;
type LaunchSnapshot = {
  allowExec: boolean;
  allowRootExec: boolean;
  noExec: boolean;
  terminal: "off" | "poll" | "stream";
  sshAlerts: boolean;
};

function launchSnapshot(profile: AgentProfileLike): LaunchSnapshot {
  const allowTerminal = !!profile?.allow_terminal && !profile?.no_exec;
  return {
    allowExec: !!profile?.allow_exec && !profile?.no_exec,
    allowRootExec: !!profile?.allow_root_exec && !!profile?.allow_exec && !profile?.no_exec,
    noExec: !!profile?.no_exec,
    terminal: allowTerminal ? (profile?.terminal_transport === "stream" ? "stream" : "poll") : "off",
    sshAlerts: !!profile?.ssh_alerts,
  };
}

const launchSnapshotKeys: Array<keyof LaunchSnapshot> = [
  "allowExec",
  "allowRootExec",
  "noExec",
  "terminal",
  "sshAlerts",
];

function launchValueLabel(value: LaunchSnapshot[keyof LaunchSnapshot]): string {
  if (typeof value === "boolean") return value ? t("fleet.nodes.detail.launch.enabled") : t("fleet.nodes.detail.launch.disabled");
  return String(value || t("common.misc.none"));
}

function launchSnapshotSummary(snapshot?: LaunchSnapshot): string {
  if (!snapshot) return t("fleet.nodes.detail.launch.runtimeUnknownHint");
  const parts = [
    snapshot.noExec ? "no-exec" : snapshot.allowExec ? "exec" : "no task exec",
    snapshot.allowRootExec ? "root" : "no root",
    `terminal:${snapshot.terminal}`,
  ];
  return parts.join(" · ");
}

function taskSandboxSummary(runtime?: AgentRuntimeConfig | null): string {
  if (!runtime?.task_sandbox) return t("fleet.nodes.detail.launch.taskSandboxUnknown");
  return runtime.task_sandbox;
}

function taskSandboxFeatures(runtime?: AgentRuntimeConfig | null): string {
  const features = runtime?.task_sandbox_features?.filter(Boolean) ?? [];
  return features.length ? features.join(" · ") : t("fleet.nodes.detail.launch.taskSandboxNoFeatures");
}

const savedLaunchSnapshot = computed(() => launchSnapshot(node.value?.agent_launch));
const runtimeLaunchSnapshot = computed(() => (node.value?.agent_runtime ? launchSnapshot(node.value.agent_runtime) : undefined));
const draftLaunchSnapshot = computed(() => launchSnapshot(launchPayload()));
const launchDirty = computed(() => JSON.stringify(savedLaunchSnapshot.value) !== JSON.stringify(draftLaunchSnapshot.value));
const launchRuntimeDrift = computed(
  () => !!runtimeLaunchSnapshot.value && JSON.stringify(runtimeLaunchSnapshot.value) !== JSON.stringify(savedLaunchSnapshot.value),
);
const launchDiffSummary = computed(() => {
  const before = savedLaunchSnapshot.value;
  const after = draftLaunchSnapshot.value;
  const diffs = launchSnapshotKeys
    .filter((key) => before[key] !== after[key])
    .map((key) => `${key}: ${launchValueLabel(before[key])} -> ${launchValueLabel(after[key])}`);
  return diffs.length ? diffs.join("; ") : t("fleet.nodes.detail.launch.noDraftChanges");
});

const reconfigureCommand = computed(() => {
  const result = reconfigureResult.value;
  if (!result) return "";
  return result.commands?.[launchPlatform.value] || result.command;
});

function extractEnvAssignment(command: string, key: string): string {
  const match = command.match(new RegExp(`${key}=('([^']*)'|"([^"]*)"|([^\\s;]+))`));
  return match?.[2] || match?.[3] || match?.[4] || "";
}

const reconfigureCommandNodeId = computed(() => extractEnvAssignment(reconfigureCommand.value, "LATTICE_NODE_ID"));
const reconfigureCommandMismatch = computed(
  () => !!reconfigureCommand.value && !!node.value?.id && !!reconfigureCommandNodeId.value && reconfigureCommandNodeId.value !== node.value.id,
);

async function generateReconfigureCommand() {
  const id = node.value?.id;
  if (!id) return;
  reconfigurePending.value = true;
  try {
    reconfigureResult.value = await api.nodes.reconfigureCommand({
      node_id: id,
      agent_launch: launchPayload(),
    });
    toast.success(t("fleet.nodes.detail.launch.toastGenerated"));
    await nodesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.nodes.detail.launch.toastFailed"));
  } finally {
    reconfigurePending.value = false;
  }
}

/** List has loaded but no node carries this id → render a "not found" state. */
const notFound = computed(
  () => nodesQuery.data.value !== undefined && !nodesQuery.loading.value && !node.value,
);

/** One reading for the badge, the sparkline colour and the terminal gate: the status word. */
const statusInfo = computed(() => describeNodeStatus(node.value ?? {}));
const meta = computed(() => statusMeta(statusInfo.value.health));
/** The agent is in contact: online or degraded. Disabled outranks a live agent. */
const isLive = computed(() => statusInfo.value.reporting);

const statusBadge = computed(() => ({
  variant: meta.value.badgeVariant,
  label: t(statusInfo.value.labelKey),
}));

/**
 * The server's account of the word: since when, and the one sentence naming
 * the evidence. A node offline since 2026-08-27 and one that never reported
 * used to print the same badge with nothing to tell them apart.
 */
const statusSince = computed(() => (node.value ? nodeStatusSince(node.value) : undefined));
const statusReason = computed(() => (node.value ? nodeStatusReason(node.value) : ""));

/**
 * Whether the resource card is reporting a measurement or a memory.
 *
 * It used to print CPU, throughput and a twelve-day uptime for a machine last
 * heard from six days earlier, under a heading that said "Live status". The
 * numbers are still worth showing; the heading and the description now say
 * which of the three cases the card is in.
 */
const metricSample = computed(() => metricFreshness(node.value ?? {}, !!node.value?.metrics));
const metricsAreLive = computed(() => metricSample.value === "live");
const noSample = computed(() => metricSample.value === "none");
const statusCardTitle = computed(() =>
  metricsAreLive.value ? t("fleet.nodes.detail.liveStatus") : t("fleet.nodes.detail.lastKnownStatus"),
);
const statusCardDesc = computed(() => {
  if (metricsAreLive.value) return t("fleet.nodes.detail.liveStatusDesc");
  if (noSample.value) return t("fleet.nodes.detail.noStatusDesc");
  return t("fleet.nodes.detail.lastKnownStatusDesc", {
    time: formatRelativeTime(node.value?.metrics?.collected_at ?? node.value?.last_seen),
  });
});

/* Feed each poll into the shared ring so the sparkline accrues history. */
const metricBuffer = useMetricBuffer();
watch(
  () => nodesQuery.data.value,
  (list) => {
    for (const n of list ?? []) metricBuffer.record(n.id, n.metrics);
  },
  { immediate: true },
);

/* ----------------------------------------------------------------- */
/* In-session CPU sparkline (inline SVG, CSP-safe, same approach as    */
/* NodeCard) from the shared metric buffer.                            */
/* ----------------------------------------------------------------- */
const SPARK_W = 240;
const SPARK_H = 44;
const cpuSeries = computed(() =>
  metricBuffer
    .series(nodeId.value, "cpu")
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v)),
);
const hasSpark = computed(() => cpuSeries.value.length >= 2);
const sparkPoints = computed(() => {
  const vs = cpuSeries.value;
  if (vs.length < 2) return "";
  const pad = 3;
  const usable = SPARK_H - pad * 2;
  const max = Math.max(100, ...vs);
  const min = 0;
  const span = max - min || 1;
  return vs
    .map((v, i) => {
      const x = (i / (vs.length - 1)) * SPARK_W;
      const y = pad + (1 - (v - min) / span) * usable;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
});

/* ----------------------------------------------------------------- */
/* Derived side-panel data.                                            */
/* ----------------------------------------------------------------- */
const groupBadges = computed(() => {
  const ids = node.value?.group_ids ?? [];
  const all = groupsQuery.data.value ?? [];
  return ids
    .map((id) => {
      const g = all.find((x) => x.id === id);
      return { id, name: g?.name ?? id, color: g?.color, leader: !!g && g.leader_id === nodeId.value };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
});

/** Cross-link a group chip to the Groups page with that group pre-selected. */
function goToGroup(id: string) {
  router.push({ name: "groups", query: { selected: id } });
}

function goToGroups() {
  router.push({ name: "groups" });
}

const displayTags = computed(() =>
  [...(node.value?.tags ?? [])].sort((a, b) => a.localeCompare(b)),
);

const nodeDdns = computed(() =>
  (ddnsQuery.data.value ?? []).filter((d) => d.node_id === nodeId.value),
);

const updatePolicy = computed(() =>
  (agentUpdatesQuery.data.value ?? []).find((p) => p.node_id === nodeId.value),
);
const agentAppliedVersionMismatch = computed(() => {
  const current = node.value?.agent_version?.trim();
  const applied = updatePolicy.value?.last_applied_version?.trim();
  return !!current && !!applied && current !== applied;
});
const activeAgentUpdateError = computed(() => {
  const error = updatePolicy.value?.last_error?.trim();
  if (!error) return "";
  const current = node.value?.agent_version?.trim();
  const applied = updatePolicy.value?.last_applied_version?.trim();
  const target = updatePolicy.value?.target_version?.trim();
  if (current && applied && current === applied) return "";
  if (current && target && target !== "latest" && current === target) return "";
  return error;
});
const updateTarget = ref("latest");
const updateAuto = ref(false);
const updateDraftTouched = ref(false);
const updateDraftNodeId = ref("");
const updateDraftSeedKey = ref("");

function updatePolicySeedKey(policy: AgentUpdatePolicy | undefined, id: string) {
  return [
    id,
    policy?.target_version ?? "",
    policy?.enabled ? "1" : "0",
    policy?.auto_plan ? "1" : "0",
    policy?.last_planned_at ?? "",
    policy?.last_applied_version ?? "",
    policy?.last_error ?? "",
  ].join("|");
}

function seedUpdateDraft(policy: AgentUpdatePolicy | undefined, id: string) {
  updateTarget.value = policy?.target_version || "latest";
  updateAuto.value = !!policy?.enabled && !!policy?.auto_plan;
  updateDraftTouched.value = false;
  updateDraftNodeId.value = id;
  updateDraftSeedKey.value = updatePolicySeedKey(policy, id);
}

function touchUpdateDraft() {
  updateDraftTouched.value = true;
}

/**
 * Say "never checked in" rather than formatting the server's zero time, which
 * renders as a six-figure number of days ago. The reading itself lives in
 * `@/lib/status`; this used to be a private copy of it in each of three views.
 */
function lastSeenText(node: Node): string {
  if (hasNeverReported(node)) return t("fleet.nodes.list.neverSeen");
  return t("fleet.nodes.list.lastSeen", { time: formatRelativeTime(node.last_seen) });
}

const savedUpdateSummary = computed(() => {
  const policy = updatePolicy.value;
  if (!policy) return t("fleet.nodes.detail.noUpdatePolicy");
  return `${policy.target_version || "latest"} · ${policy.enabled && policy.auto_plan ? t("fleet.nodes.detail.autoPlan") : t("common.status.disabled")}`;
});

const draftUpdateSummary = computed(() => `${updateTarget.value.trim() || "latest"} · ${updateAuto.value ? t("fleet.nodes.detail.autoPlan") : t("common.status.disabled")}`);

const updateDirty = computed(() => {
  const policy = updatePolicy.value;
  const savedTarget = policy?.target_version || "latest";
  const savedAuto = !!policy?.enabled && !!policy?.auto_plan;
  return (updateTarget.value.trim() || "latest") !== savedTarget || updateAuto.value !== savedAuto;
});

watch(
  [updatePolicy, () => node.value?.id],
  ([policy, id]) => {
    if (!id) return;
    const seedKey = updatePolicySeedKey(policy, id);
    if (updateDraftNodeId.value !== id) {
      seedUpdateDraft(policy, id);
      return;
    }
    if (seedKey === updateDraftSeedKey.value) return;
    if (!updateDraftTouched.value) seedUpdateDraft(policy, id);
  },
  { immediate: true },
);

const auditEvents = computed(() => auditQuery.data.value ?? []);

/**
 * What happened to this machine, in order, from every source that records it.
 * Audit alone answered "what did the server log"; the question an operator
 * arrives with is "what happened here", and a task run, the approval that
 * authorised it and the audit line it produced are three records of one story.
 */
const timeline = computed(() =>
  buildNodeTimeline({
    nodeId: nodeId.value,
    audit: auditEvents.value,
    tasks: nodeTasksQuery.data.value ?? [],
    results: nodeResultsQuery.data.value ?? [],
    approvals: nodeApprovalsQuery.data.value ?? [],
    limit: timelineExpanded.value ? 100 : 12,
  }),
);
const timelineDays = computed(() => groupByDay(timeline.value));

// What has not run yet on this machine. The timeline answers what already
// happened; when a node has been down, the question is what is stacked up
// against it and in what order it will be taken.
const nodeQueue = computed(() => buildNodeQueue(nodeTasksQuery.data.value ?? [], nodeId.value));

/** Translated fragments for the lease line, including the duration units. */
function leaseText() {
  return {
    leasedFor: (age: string) => t("operations.tasks.leasedFor", { age }),
    attemptOf: (attempt: number, max: number) => t("operations.tasks.attemptOf", { attempt, max }),
    duration: {
      days: (n: number) => t("common.duration.days", { n }),
      hours: (n: number) => t("common.duration.hours", { n }),
      minutes: (n: number) => t("common.duration.minutes", { n }),
      seconds: (n: number) => t("common.duration.seconds", { n }),
    },
    stalledNoLease: t("operations.tasks.stalledNoLease"),
  };
}

/**
 * "leased 41 min, attempt 2 of 3", or the whole account of a stall said once.
 * Empty on a server too old to count attempts.
 */
function queueLeaseLabel(entry: NodeQueueEntry): string {
  const text = leaseText();
  return entry.stalled ? stalledText(entry.lease, text) : leaseAttemptLabel(entry.lease, text);
}

/** The state this entry is in, in the vocabulary the Tasks page uses. */
function queueState(entry: NodeQueueEntry): "stalled" | "leased" | "queued" {
  if (entry.stalled) return "stalled";
  if (entry.running) return "leased";
  return "queued";
}

/**
 * Badge for a queue entry. The colour comes from the shared task-state table,
 * not from a private one: this used to paint Stalled red while the Tasks page
 * painted it amber, and Running amber while Tasks painted it grey.
 */
function queueBadge(entry: NodeQueueEntry): { variant: ReturnType<typeof taskStateStyle>["variant"]; label: string } {
  const labels = {
    stalled: "fleet.nodes.detail.queueStalled",
    leased: "fleet.nodes.detail.queueRunning",
    queued: "fleet.nodes.detail.queueWaiting",
  } as const;
  const state = queueState(entry);
  return { variant: taskStateStyle(state).variant, label: t(labels[state]) };
}
const timelineExpanded = ref(false);
const timelineHasMore = computed(
  () =>
    !timelineExpanded.value &&
    buildNodeTimeline({
      nodeId: nodeId.value,
      audit: auditEvents.value,
      tasks: nodeTasksQuery.data.value ?? [],
      results: nodeResultsQuery.data.value ?? [],
      approvals: nodeApprovalsQuery.data.value ?? [],
    }).length > timeline.value.length,
);

/** Icon per source, so the eye can separate kinds without reading. */
function timelineIcon(kind: TimelineEntry["kind"]) {
  if (kind === "task") return SquareTerminal;
  if (kind === "approval") return ShieldCheck;
  return ScrollText;
}

/** allow/ok are quiet; deny/failed/rejected are the ones worth finding. */
function outcomeVariant(outcome: string): "default" | "secondary" | "destructive" | "outline" {
  if (["deny", "failed", "rejected", "cancelled"].includes(outcome)) return "destructive";
  if (["allow", "ok", "applied", "finished", "approved"].includes(outcome)) return "secondary";
  return "outline";
}

/**
 * Where a timeline entry leads, with the record's own id along for the ride.
 * A bare /approvals drops the operator into a list of hundreds and asks them to
 * find again the row they just clicked; the destination reads ?selected and
 * selects it.
 */
function timelineHref(entry: TimelineEntry): RouteLocationRaw | undefined {
  if (!entry.ref) return undefined;
  return {
    name: entry.ref.kind === "task" ? "tasks" : "approvals",
    query: { selected: entry.ref.id },
  };
}

function decisionVariant(d: string): "success" | "destructive" | "secondary" {
  if (d === "allow") return "success";
  if (d === "deny") return "destructive";
  return "secondary";
}

function geoSourceLabel(source?: string): string {
  if (source === "auto") return t("fleet.nodes.detail.geoSourceAuto");
  if (source === "operator" || !source) return t("fleet.nodes.detail.geoSourceOperator");
  return source;
}

const hasGeo = computed(() => {
  const g = node.value?.geo;
  return !!g && Object.values(g).some((v) => v !== undefined && v !== "" && v !== null);
});

/* ----------------------------------------------------------------- */
/* Navigation + mutations.                                             */
/* ----------------------------------------------------------------- */
function goBack() {
  router.push({ name: "nodes" });
}

function openTerminal() {
  if (!canOpenTerminal.value || !node.value || !isReporting(node.value)) return;
  router.push({ name: "terminal", query: { node_id: node.value.id, connect: "1" } });
}

function refreshAll() {
  nodesQuery.refresh();
  auditQuery.refresh();
  groupsQuery.refresh();
  ddnsQuery.refresh();
  agentUpdatesQuery.refresh();
}

/* ----------------------------------------------------------------- */
/* Cross-links to the vertical function views, pre-scoped to this     */
/* node via ?node=<id> (the seed-watchers on those views select it).  */
/* ----------------------------------------------------------------- */
function goToInventory() {
  if (node.value) router.push({ name: "inventory", query: { node: node.value.id } });
}
function goToMonitoring() {
  if (node.value) router.push({ name: "monitoring", query: { node: node.value.id } });
}
/* ----------------------------------------------------------------- */
/* Identity editing (name / role / tags). Operator-owned; gated on    */
/* node:admin like the other admin controls. The form seeds once per  */
/* node id so the 5s poll never clobbers an in-progress edit.         */
/* ----------------------------------------------------------------- */
const editName = ref("");
const editRole = ref("");
const editTags = ref<string[]>([]);
const editComment = ref("");
const editAgentSourceAllowlist = ref("");
const editPurity = ref("");
const editQuality = ref("");
const editInventoryNotes = ref("");
const tagDraft = ref("");
const identityPending = ref(false);

watch(
  () => node.value?.id,
  () => {
    editName.value = node.value?.name ?? "";
    editRole.value = node.value?.role ?? "";
    editTags.value = [...(node.value?.tags ?? [])].sort((a, b) => a.localeCompare(b));
    editComment.value = node.value?.comment ?? "";
    editAgentSourceAllowlist.value = [...(node.value?.agent_source_allowlist ?? [])].join("\n");
    editPurity.value = node.value?.inventory?.purity_percent?.toString() ?? "";
    editQuality.value = node.value?.inventory?.quality ?? "";
    editInventoryNotes.value = node.value?.inventory?.notes ?? "";
    tagDraft.value = "";
  },
  { immediate: true },
);

/** Parsed purity draft: undefined when empty, NaN when invalid (blocks Save). */
const purityDraft = computed<number | undefined>(() => {
  const raw = editPurity.value.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) return Number.NaN;
  return parsed;
});
const purityInvalid = computed(() => Number.isNaN(purityDraft.value));

function addTag() {
  const v = tagDraft.value.trim();
  if (v && !editTags.value.includes(v)) {
    editTags.value = [...editTags.value, v].sort((a, b) => a.localeCompare(b));
  }
  tagDraft.value = "";
}

function removeTag(tag: string) {
  editTags.value = editTags.value.filter((t) => t !== tag);
}

function parseAgentSourceAllowlistDraft(): string[] {
  return editAgentSourceAllowlist.value
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

/** True when the form differs from the persisted identity (gates Save). */
const identityDirty = computed(() => {
  const n = node.value;
  if (!n) return false;
  const tags = [...(n.tags ?? [])].sort((a, b) => a.localeCompare(b));
  const tagsEqual =
    editTags.value.length === tags.length && editTags.value.every((t, i) => t === tags[i]);
  const persistedSources = [...(n.agent_source_allowlist ?? [])].sort((a, b) => a.localeCompare(b));
  const draftSources = parseAgentSourceAllowlistDraft().sort((a, b) => a.localeCompare(b));
  const sourcesEqual =
    draftSources.length === persistedSources.length &&
    draftSources.every((source, i) => source === persistedSources[i]);
  const inv = n.inventory ?? undefined;
  const purityEqual =
    (purityDraft.value === undefined && inv?.purity_percent === undefined) ||
    purityDraft.value === inv?.purity_percent;
  return (
    editName.value.trim() !== (n.name ?? "") ||
    editRole.value.trim() !== (n.role ?? "") ||
    editComment.value.trim() !== (n.comment ?? "") ||
    !tagsEqual ||
    !sourcesEqual ||
    !purityEqual ||
    editQuality.value.trim() !== (inv?.quality ?? "") ||
    editInventoryNotes.value.trim() !== (inv?.notes ?? "")
  );
});

async function saveIdentity() {
  if (!node.value || !canAdminNodes.value || purityInvalid.value) return;
  identityPending.value = true;
  try {
    const res = await api.nodes.update({
      node_id: node.value.id,
      name: editName.value.trim(),
      role: editRole.value.trim(),
      comment: editComment.value.trim(),
      tags: editTags.value,
      agent_source_allowlist: parseAgentSourceAllowlistDraft(),
      // Always sent: the form is seeded from the persisted value, so this is
      // replace-semantics; an all-empty object clears the inventory record.
      inventory: {
        purity_percent: purityDraft.value,
        quality: editQuality.value.trim() || undefined,
        notes: editInventoryNotes.value.trim() || undefined,
      },
    });
    editName.value = res.name;
    editRole.value = res.role;
    editComment.value = res.comment ?? "";
    editTags.value = [...(res.tags ?? [])].sort((a, b) => a.localeCompare(b));
    editAgentSourceAllowlist.value = [...(res.agent_source_allowlist ?? [])].join("\n");
    editPurity.value = res.inventory?.purity_percent?.toString() ?? "";
    editQuality.value = res.inventory?.quality ?? "";
    editInventoryNotes.value = res.inventory?.notes ?? "";
    toast.success(t("fleet.nodes.detail.identitySaved"));
    await nodesQuery.refresh();
  } catch (error) {
    if (error instanceof ApiError && error.isForbidden) {
      toast.error(t("fleet.nodes.detail.identityForbidden"));
    } else {
      toast.error(error instanceof Error ? error.message : t("fleet.nodes.detail.identitySaveFailed"));
    }
  } finally {
    identityPending.value = false;
  }
}

function displayInternalAddress(value?: string, publicValue?: string): string {
  if (!value) return t("common.misc.none");
  if (publicValue && value === publicValue) return t("fleet.nodes.detail.sameAsPublic");
  return value;
}

function copyableInternalAddress(value?: string, publicValue?: string): string {
  if (!value || (publicValue && value === publicValue)) return "";
  return value;
}

function hostKernel(facts?: Node["host_facts"]): string {
  return facts?.kernel_version || facts?.kernel || "";
}

const pending = ref(false);
const debugPending = ref(false);
const planningUpdate = ref(false);
const updateNoopOpen = ref(false);
const updateNoopMessage = ref("");
const savingUpdatePolicy = ref(false);
const resolvingGeo = ref(false);
const rotatedToken = ref<{ node_id: string; token: string } | undefined>();

/* Disabling a node and rotating its token both take effect the moment they run,
   so each is gated behind a confirm naming the node. Re-enabling is not
   destructive and still runs straight away. */
const disableOpen = ref(false);
const rotateOpen = ref(false);
const nodeLabel = computed(() => node.value?.name || node.value?.id || "");

function requestDisable(disabled: boolean) {
  if (!disabled) {
    void setDisabled(false);
    return;
  }
  disableOpen.value = true;
}

async function confirmDisable() {
  try {
    await setDisabled(true);
  } finally {
    disableOpen.value = false;
  }
}

async function confirmRotateToken() {
  try {
    await rotateToken();
  } finally {
    rotateOpen.value = false;
  }
}

async function setDisabled(disabled: boolean) {
  if (!node.value) return;
  pending.value = true;
  try {
    await api.nodes.disable(node.value.id, disabled);
    toast.success(disabled ? t("fleet.nodes.toast.nodeDisabled") : t("fleet.nodes.toast.nodeEnabled"));
    await nodesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.nodes.toast.updateFailed"));
  } finally {
    pending.value = false;
  }
}

async function rotateToken() {
  if (!node.value) return;
  pending.value = true;
  rotatedToken.value = undefined;
  try {
    rotatedToken.value = await api.nodes.rotateToken(node.value.id);
    toast.success(t("fleet.nodes.toast.tokenRotated"));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.nodes.toast.rotationFailed"));
  } finally {
    pending.value = false;
  }
}

/* ----------------------------------------------------------------- */
/* Hard delete (irreversible cascade). The flow previews the impact    */
/* via deletePlan, then gates the confirm button behind a type-the-    */
/* name check before calling delete and routing back to the fleet.     */
/* ----------------------------------------------------------------- */
const deleteOpen = ref(false);
const deletePending = ref(false);
const deletePlanning = ref(false);
const deletePlan = ref<NodeDeletePlanView | undefined>();
const deleteNameInput = ref("");

/** Count fields rendered as "label: N" rows, in cascade order. Only nonzero
 *  rows show, so a node with no dependents reads as a clean delete. */
const DELETE_COUNT_FIELDS: { key: string; field: keyof NodeDeletePlanView }[] = [
  { key: "tasksStripped", field: "tasks_stripped" },
  { key: "tasksDeleted", field: "tasks_deleted" },
  { key: "taskResults", field: "task_results" },
  { key: "ddnsProfiles", field: "ddns_profiles" },
  { key: "machineProfiles", field: "machine_profiles" },
  { key: "nftInputs", field: "nft_inputs" },
  { key: "dnsDeployments", field: "dns_deployments" },
  { key: "netPolicies", field: "net_policies" },
  { key: "netPeerRulesStripped", field: "net_peer_rules_stripped" },
  { key: "groupPolicyRulesStripped", field: "group_policy_rules_stripped" },
  { key: "geoRoutingStripped", field: "geo_routing_stripped" },
  { key: "geoRoutingDeleted", field: "geo_routing_deleted" },
  { key: "agentUpdatePolicies", field: "agent_update_policies" },
  { key: "monitorsStripped", field: "monitors_stripped" },
  { key: "monitorResults", field: "monitor_results" },
  { key: "logSources", field: "log_sources" },
  { key: "groups", field: "groups" },
  { key: "approvals", field: "approvals" },
  { key: "tunnels", field: "tunnels" },
  // These were reported by the server and never shown. A delete preview that
  // under-reports is worse than none: it is the one screen whose entire job is
  // telling the operator what disappears.
  { key: "proxyNodeProfiles", field: "proxy_node_profiles" },
  { key: "proxyUsageSnapshots", field: "proxy_usage_snapshots" },
  { key: "guardRealitySnapshots", field: "guard_reality_snapshots" },
  { key: "guardBindings", field: "guard_bindings" },
  { key: "managedLines", field: "managed_lines" },
  { key: "lineChainAttemptsReleased", field: "line_chain_attempts_released" },
  { key: "lineChainDefinitionsDeleted", field: "line_chain_definitions_deleted" },
  { key: "lineChainTargetsDrifted", field: "line_chain_targets_drifted" },
  { key: "lineChainLeaseConflicts", field: "line_chain_lease_conflicts" },
  { key: "terminalSessions", field: "terminal_sessions" },
];

const deleteImpactRows = computed(() => {
  const plan = deletePlan.value;
  if (!plan) return [];
  return DELETE_COUNT_FIELDS.map((f) => ({
    key: f.key,
    label: t(`fleet.nodes.detail.deleteCounts.${f.key}`),
    count: Number(plan[f.field] ?? 0),
  })).filter((r) => r.count > 0);
});

/** Confirm is gated until the typed value exactly matches what the prompt asks
 *  for: the node name, or its id when the node has no name (matches the prompt
 *  copy, which falls back to id). */
const deleteNameMatches = computed(
  () =>
    !!node.value &&
    deleteNameInput.value.trim() === (node.value.name || node.value.id),
);

async function openDeleteDialog() {
  if (!node.value || !canAdminNodes.value) return;
  deleteNameInput.value = "";
  deletePlan.value = undefined;
  deleteOpen.value = true;
  deletePlanning.value = true;
  try {
    deletePlan.value = await api.nodes.deletePlan(node.value.id);
  } catch (error) {
    // The dialog still opens; the operator can confirm without the preview.
    toast.error(error instanceof Error ? error.message : t("fleet.nodes.detail.deletePlanFailed"));
  } finally {
    deletePlanning.value = false;
  }
}

async function deleteNode() {
  if (!node.value || !canAdminNodes.value || !deleteNameMatches.value) return;
  deletePending.value = true;
  try {
    await api.nodes.delete(node.value.id);
    toast.success(t("fleet.nodes.toast.nodeDeleted"));
    deleteOpen.value = false;
    goBack();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.nodes.toast.deleteFailed"));
  } finally {
    deletePending.value = false;
  }
}

function onDeleteOpenChange(value: boolean) {
  if (deletePending.value) return;
  deleteOpen.value = value;
  if (!value) {
    deleteNameInput.value = "";
    deletePlan.value = undefined;
  }
}

async function setNodeDebug(enabled: boolean, collect?: boolean) {
  if (!node.value || !canAdminNodes.value) return;
  debugPending.value = true;
  try {
    await api.nodes.setDebug(node.value.id, enabled, collect);
    toast.success(t("fleet.nodes.toast.debugUpdated"));
    await nodesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.nodes.toast.debugFailed"));
  } finally {
    debugPending.value = false;
  }
}

// Per-node public-IP discovery override editor. "inherit" maps to the empty
// server mode (clear the override). The form seeds once per node id so a 5s
// poll never clobbers an in-progress edit.
const ipMode = ref<"inherit" | "auto" | "static" | "resolver" | "script">("inherit");
const ipStaticV4 = ref("");
const ipStaticV6 = ref("");
const ipResolvers = ref("");
const ipScript = ref("");
const ipConfigPending = ref(false);
const canSaveIPConfig = computed(() => {
  if (ipMode.value !== "script") return true;
  return !!ipScript.value.trim() || !!node.value?.ip_config?.script_sha256;
});

watch(
  () => node.value?.id,
  () => {
    const c = node.value?.ip_config;
    ipMode.value = c?.mode ? c.mode : "inherit";
    ipStaticV4.value = c?.static_ipv4 ?? "";
    ipStaticV6.value = c?.static_ipv6 ?? "";
    ipResolvers.value = (c?.resolvers ?? []).join("\n");
    ipScript.value = "";
  },
  { immediate: true },
);

async function saveIPConfig() {
  if (!node.value || !canAdminNodes.value) return;
  ipConfigPending.value = true;
  try {
    await api.nodes.ipConfig({
      node_id: node.value.id,
      mode: ipMode.value === "inherit" ? "" : ipMode.value,
      static_ipv4: ipStaticV4.value.trim(),
      static_ipv6: ipStaticV6.value.trim(),
      resolvers: ipResolvers.value
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
      script: ipMode.value === "script" ? ipScript.value : undefined,
    });
    toast.success(t("fleet.nodes.detail.ipConfig.saved"));
    await nodesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.nodes.detail.ipConfig.saveFailed"));
  } finally {
    ipConfigPending.value = false;
  }
}

// Clearing drops the override and saves immediately, so it asks first.
const clearIPOpen = ref(false);

async function clearIPConfig() {
  ipMode.value = "inherit";
  try {
    await saveIPConfig();
  } finally {
    clearIPOpen.value = false;
  }
}

function officialUpdateRequest(autoPlan = updateAuto.value) {
  return {
    node_id: node.value?.id ?? "",
    enabled: true,
    auto_plan: autoPlan,
    target_version: updateTarget.value.trim() || "latest",
  };
}

async function saveAutoUpdate() {
  if (!node.value || !canAdminNodes.value) return;
  savingUpdatePolicy.value = true;
  try {
    await api.agentUpdates.upsert(officialUpdateRequest(updateAuto.value));
    toast.success(t("fleet.nodes.detail.updatePolicySaved"));
    updateDraftTouched.value = false;
    await agentUpdatesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.nodes.detail.updatePolicySaveFailed"));
  } finally {
    savingUpdatePolicy.value = false;
  }
}

async function planUpdate(force = false) {
  if (!node.value || !canPlanUpdates.value) return;
  planningUpdate.value = true;
  try {
    await api.agentUpdates.upsert(officialUpdateRequest(updateAuto.value));
    updateDraftTouched.value = false;
    await api.agentUpdates.plan(node.value.id, force || undefined);
    toast.success(t("fleet.nodes.detail.updatePlanned"));
    updateNoopOpen.value = false;
    await agentUpdatesQuery.refresh();
  } catch (error) {
    if (isAgentUpdateNoopError(error) && !force) {
      updateNoopMessage.value = error.message || t("fleet.nodes.detail.nodeAlreadyTarget");
      updateNoopOpen.value = true;
      await agentUpdatesQuery.refresh();
    } else {
      toast.error(error instanceof Error ? error.message : t("fleet.nodes.detail.updatePlanFailed"));
    }
  } finally {
    planningUpdate.value = false;
  }
}

function forcePlanUpdate() {
  void planUpdate(true);
}

async function resolveGeo() {
  if (!node.value || !canAdminNodes.value) return;
  resolvingGeo.value = true;
  try {
    const res = await api.nodes.resolveGeo({ node_id: node.value.id, overwrite: true });
    const results = res.results ?? [];
    if (results.some((r) => r.status === "resolver_disabled")) {
      toast.error(t("fleet.map.toast.resolverDisabled"));
      return;
    }
    const updated = results.filter((r) => r.status === "updated").length;
    if (updated > 0) {
      toast.success(t("fleet.map.toast.resolved", { count: updated }));
      await nodesQuery.refresh();
      return;
    }
    if (results.some((r) => r.status === "no_public_ip")) {
      toast.error(t("fleet.map.toast.resolveNoPublicIp", { count: 1 }));
      return;
    }
    toast.info(t("fleet.map.toast.resolveNoop"));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.map.toast.resolveFailed"));
  } finally {
    resolvingGeo.value = false;
  }
}
</script>

<template>
  <!-- Resolved node: full page with a sticky header over a 2-column body. -->
  <div v-if="node">
    <div class="sticky top-0 z-20 border-b border-border bg-background px-6 py-4">
      <PageHeader :title="node.name || node.id" :section="$t('nav.sections.fleet')">
        <template #status>
          <FreshnessLabel :last-updated="nodesQuery.lastUpdated.value" />
        </template>
        <template #actions>
          <Button variant="ghost" size="sm" @click="goBack">
            <ArrowLeft class="size-4" aria-hidden="true" />
            {{ $t('fleet.nodes.detail.backToNodes') }}
          </Button>
          <Button
            v-if="canOpenTerminal"
            size="sm"
            :disabled="!isReporting(node)"
            @click="openTerminal"
          >
            <SquareTerminal class="size-4" aria-hidden="true" />
            {{ $t('fleet.nodes.list.openTerminal') }}
          </Button>
          <Button variant="outline" size="sm" :disabled="nodesQuery.refreshing.value" @click="refreshAll">
            <RotateCw :class="cn('size-4', nodesQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
            {{ $t('common.actions.refresh') }}
          </Button>
        </template>
      </PageHeader>

      <!-- Identity row: status / role / tags / groups, last-seen. -->
      <div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
        <Badge :variant="statusBadge.variant">{{ statusBadge.label }}</Badge>
        <span v-if="statusSince" class="text-xs text-muted-foreground" :title="statusSince">
          {{ $t('fleet.nodes.detail.statusSince', { time: formatRelativeTime(statusSince) }) }}
        </span>
        <Badge v-if="node.role" variant="secondary">{{ node.role }}</Badge>
        <Badge v-for="tag in displayTags" :key="tag" variant="outline">{{ tag }}</Badge>
        <button
          v-for="g in groupBadges"
          :key="g.id"
          type="button"
          :class="cn(
            'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            groupColor(g.color).border,
            groupColor(g.color).soft,
            groupColor(g.color).text,
          )"
          @click="goToGroup(g.id)"
        >
          <span :class="cn('size-2 shrink-0 rounded-full', groupColor(g.color).dot)" aria-hidden="true" />
          {{ g.name }}
          <Crown v-if="g.leader" class="size-3 shrink-0" aria-hidden="true" />
        </button>
        <span class="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground tabular">
          {{ shortId(node.id, 20) }}
          <CopyButton :value="node.id" />
        </span>
        <span class="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground tabular">
          <Clock class="size-3.5" aria-hidden="true" />
          {{ lastSeenText(node) }}
        </span>
      </div>

      <!-- Why the word above says what it says. The page has room for the
           sentence, so it is printed rather than hidden behind a hover: a
           title attribute is not reachable by keyboard and is not read out. -->
      <p class="mt-2 flex items-start gap-2 text-sm text-muted-foreground">
        <Info class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>{{ statusReason || $t(statusInfo.hintKey) }}</span>
      </p>

      <div v-if="node.comment" class="mt-3 rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
        <p class="flex items-start gap-2">
          <ScrollText class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span class="whitespace-pre-wrap">{{ node.comment }}</span>
        </p>
      </div>

      <!-- Cross-links to the vertical function views, pre-scoped to this node. -->
      <div class="mt-3 flex flex-wrap items-center gap-2">
        <span class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.relatedViews') }}</span>
        <Button variant="outline" size="sm" @click="goToInventory">
          <Boxes class="size-4" aria-hidden="true" />
          {{ $t('fleet.nodes.detail.viewInventory') }}
        </Button>
        <Button variant="outline" size="sm" @click="goToMonitoring">
          <RadioTower class="size-4" aria-hidden="true" />
          {{ $t('fleet.nodes.detail.viewMonitoring') }}
        </Button>
      </div>
    </div>

    <div class="grid gap-6 p-6 lg:grid-cols-3">
      <!-- ── Main column ──────────────────────────────────────────── -->
      <div class="space-y-6 lg:col-span-2">
        <!-- Capability enrolment. What is allowed to act on this node, as
             opposed to what this node is (identity, above) or what its agent
             can currently do (runtime, further down). Those are three different
             questions and dispatch needs all three. -->
        <Card v-if="canAdminNodes">
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <ShieldCheck class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('fleet.nodes.detail.capabilities.title') }}
            </CardTitle>
            <CardDescription>{{ $t('fleet.nodes.detail.capabilities.description') }}</CardDescription>
          </CardHeader>
          <CardContent>
            <div class="divide-y divide-border/60">
              <div
                v-for="row in (showDormantCapabilities ? allCapabilityRows : capabilityRows)"
                :key="row.capability"
                class="flex flex-wrap items-center gap-3 py-2 first:pt-0 last:pb-0"
              >
                <div class="min-w-0 flex-1">
                  <p class="truncate font-mono text-sm">{{ row.capability }}</p>
                  <p
                    v-if="capabilityNote(row.record)"
                    class="truncate text-xs text-muted-foreground"
                    :title="capabilityNote(row.record)"
                  >
                    {{ capabilityNote(row.record) }}
                  </p>
                </div>
                <!-- The effective answer, not just the stored record. A node
                     allowed because of its own configuration is in scope, and
                     labelling that "not decided" would read as blocked. -->
                <Badge :variant="capabilityBadge(row.record).variant">
                  {{ capabilityBadge(row.record).label }}
                </Badge>
                <div class="flex shrink-0 items-center gap-1">
                  <Button
                    v-if="row.record?.state !== 'enrolled'"
                    size="sm"
                    variant="outline"
                    :disabled="capabilityPending === row.capability"
                    @click="setCapability(row.capability, 'enrolled')"
                  >
                    {{ $t('fleet.nodes.detail.capabilities.enrol') }}
                  </Button>
                  <Button
                    v-if="row.record?.state !== 'excluded'"
                    size="sm"
                    variant="ghost"
                    :disabled="capabilityPending === row.capability"
                    @click="openExclude(row.capability)"
                  >
                    {{ $t('fleet.nodes.detail.capabilities.exclude') }}
                  </Button>
                  <!-- Clearing is not the same as excluding: it removes the
                       decision so the capability's own default applies again. -->
                  <Button
                    v-if="row.record"
                    size="sm"
                    variant="ghost"
                    :disabled="capabilityPending === row.capability"
                    :title="$t('fleet.nodes.detail.capabilities.clearHint')"
                    @click="setCapability(row.capability, '')"
                  >
                    {{ $t('fleet.nodes.detail.capabilities.clear') }}
                  </Button>
                </div>
              </div>
            </div>
            <!-- The capabilities that are declared but not yet gated. Kept out
                 of the way rather than out of reach: a decision recorded now
                 will apply the moment that capability goes live. -->
            <Button
              v-if="dormantCapabilityRows.length"
              variant="ghost"
              size="sm"
              class="mt-2 text-muted-foreground"
              @click="showDormantCapabilities = !showDormantCapabilities"
            >
              {{ showDormantCapabilities
                ? $t('fleet.nodes.detail.capabilities.hideDormant')
                : $t('fleet.nodes.detail.capabilities.showDormant', { count: dormantCapabilityRows.length }) }}
            </Button>
          </CardContent>
        </Card>

        <!-- Identity (operator-owned: name / role / tags). node:admin only. -->
        <Card v-if="canAdminNodes">
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <Pencil class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('fleet.nodes.detail.identity') }}
            </CardTitle>
            <CardDescription>{{ $t('fleet.nodes.detail.identityDesc') }}</CardDescription>
          </CardHeader>
          <CardContent class="space-y-4">
            <div class="grid gap-3 sm:grid-cols-2">
              <div class="grid gap-1.5">
                <Label for="identity-name">{{ $t('fleet.nodes.detail.identityName') }}</Label>
                <Input id="identity-name" v-model="editName" :placeholder="node.id" />
              </div>
              <div class="grid gap-1.5">
                <Label for="identity-role">{{ $t('fleet.nodes.detail.identityRole') }}</Label>
                <Input id="identity-role" v-model="editRole" :placeholder="$t('fleet.nodes.enroll.rolePlaceholder')" />
              </div>
            </div>
            <div class="grid gap-1.5">
              <Label for="identity-tags">{{ $t('fleet.nodes.detail.identityTags') }}</Label>
              <div v-if="editTags.length" class="flex flex-wrap gap-1.5">
                <Badge v-for="tag in editTags" :key="tag" variant="outline" class="gap-1">
                  {{ tag }}
                  <button
                    type="button"
                    class="text-muted-foreground hover:text-foreground"
                    :aria-label="$t('fleet.nodes.detail.identityRemoveTag')"
                    @click="removeTag(tag)"
                  >
                    <X class="size-3" aria-hidden="true" />
                  </button>
                </Badge>
              </div>
              <Input
                id="identity-tags"
                v-model="tagDraft"
                :placeholder="$t('fleet.nodes.detail.identityTagPlaceholder')"
                @keydown.enter.prevent="addTag"
              />
              <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.identityTagHint') }}</p>
            </div>
            <div class="grid gap-1.5">
              <Label for="identity-comment">{{ $t('fleet.nodes.detail.identityComment') }}</Label>
              <Textarea
                id="identity-comment"
                v-model="editComment"
                rows="3"
                :placeholder="$t('fleet.nodes.detail.identityCommentPlaceholder')"
              />
              <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.identityCommentHint') }}</p>
            </div>
            <div class="grid gap-3 sm:grid-cols-2">
              <div class="grid gap-1.5">
                <Label for="identity-purity">{{ $t('fleet.nodes.detail.identityPurity') }}</Label>
                <Input
                  id="identity-purity"
                  v-model="editPurity"
                  inputmode="numeric"
                  placeholder="98"
                  :aria-invalid="purityInvalid"
                  :class="cn(purityInvalid && 'border-destructive')"
                />
                <p v-if="purityInvalid" class="text-xs text-destructive">
                  {{ $t('fleet.nodes.detail.identityPurityInvalid') }}
                </p>
                <p v-else class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.identityPurityHint') }}</p>
              </div>
              <div class="grid gap-1.5">
                <Label for="identity-quality">{{ $t('fleet.nodes.detail.identityQuality') }}</Label>
                <Input
                  id="identity-quality"
                  v-model="editQuality"
                  :placeholder="$t('fleet.nodes.detail.identityQualityPlaceholder')"
                />
                <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.identityQualityHint') }}</p>
              </div>
            </div>
            <div class="grid gap-1.5">
              <Label for="identity-inventory-notes">{{ $t('fleet.nodes.detail.identityInventoryNotes') }}</Label>
              <Textarea
                id="identity-inventory-notes"
                v-model="editInventoryNotes"
                rows="2"
                :placeholder="$t('fleet.nodes.detail.identityInventoryNotesPlaceholder')"
              />
            </div>
            <div class="grid gap-1.5">
              <Label for="identity-agent-source-allowlist">{{ $t('fleet.nodes.detail.identityAgentSourceAllowlist') }}</Label>
              <Textarea
                id="identity-agent-source-allowlist"
                v-model="editAgentSourceAllowlist"
                rows="3"
                :placeholder="$t('fleet.nodes.detail.identityAgentSourceAllowlistPlaceholder')"
              />
              <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.identityAgentSourceAllowlistHint') }}</p>
            </div>
            <div class="flex flex-wrap gap-2">
              <Button size="sm" :disabled="identityPending || !identityDirty || purityInvalid" @click="saveIdentity">
                <RefreshCw v-if="identityPending" class="size-3.5 animate-spin" aria-hidden="true" />
                {{ $t('common.actions.save') }}
              </Button>
            </div>
          </CardContent>
        </Card>

        <!-- Live status + metrics -->
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <Activity class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ statusCardTitle }}
            </CardTitle>
            <CardDescription>{{ statusCardDesc }}</CardDescription>
          </CardHeader>
          <CardContent class="space-y-5">
            <div class="space-y-2.5">
              <MetricBar
                :label="$t('fleet.nodes.metric.cpu')"
                tone="cpu"
                :percent="node.metrics?.cpu_percent"
                :unavailable="noSample"
              />
              <MetricBar
                :label="$t('fleet.nodes.metric.memory')"
                tone="memory"
                :used="node.metrics?.memory_used"
                :total="node.metrics?.memory_total"
                :unavailable="noSample"
              />
              <MetricBar
                :label="$t('fleet.nodes.metric.disk')"
                tone="disk"
                :used="node.metrics?.disk_used"
                :total="node.metrics?.disk_total"
                :unavailable="noSample"
              />
            </div>

            <!-- In-session CPU trend. -->
            <div>
              <p class="mb-1 text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.sparklineLabel') }}</p>
              <svg
                v-if="hasSpark"
                :viewBox="`0 0 ${SPARK_W} ${SPARK_H}`"
                :style="{ height: SPARK_H + 'px' }"
                class="block w-full"
                preserveAspectRatio="none"
                role="img"
                :aria-label="$t('fleet.nodes.detail.sparklineLabel')"
              >
                <polyline
                  :points="sparkPoints"
                  fill="none"
                  :class="['stroke-current', meta.textClass]"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  vector-effect="non-scaling-stroke"
                />
              </svg>
              <p v-else class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.sparklinePending') }}</p>
            </div>

            <!-- Secondary stats grid. -->
            <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div class="rounded-md border border-border bg-muted/20 p-3">
                <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.load') }}</p>
                <p class="mt-1 inline-flex items-center gap-1.5 font-mono text-sm tabular">
                  <Gauge class="size-3.5 text-muted-foreground" aria-hidden="true" />
                  {{ node.metrics?.load1?.toFixed(2) ?? NO_VALUE }}
                </p>
              </div>
              <div class="rounded-md border border-border bg-muted/20 p-3">
                <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.uptime') }}</p>
                <p class="mt-1 inline-flex items-center gap-1.5 font-mono text-sm tabular">
                  <Clock class="size-3.5 text-muted-foreground" aria-hidden="true" />
                  {{ formatDuration(node.metrics?.uptime_seconds) }}
                </p>
              </div>
              <div class="rounded-md border border-border bg-muted/20 p-3">
                <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.sampleTime') }}</p>
                <p class="mt-1 font-mono text-sm tabular">{{ formatRelativeTime(node.metrics?.collected_at) }}</p>
              </div>
              <div class="rounded-md border border-border bg-muted/20 p-3">
                <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.download') }}</p>
                <p class="mt-1 inline-flex items-center gap-1.5 font-mono text-sm tabular">
                  <ArrowDown class="size-3.5 text-success" aria-hidden="true" />
                  {{ formatBytesPerSec(node.metrics?.net_rx_speed) }}
                </p>
              </div>
              <div class="rounded-md border border-border bg-muted/20 p-3">
                <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.upload') }}</p>
                <p class="mt-1 inline-flex items-center gap-1.5 font-mono text-sm tabular">
                  <ArrowUp class="size-3.5 text-primary" aria-hidden="true" />
                  {{ formatBytesPerSec(node.metrics?.net_tx_speed) }}
                </p>
              </div>
              <div class="rounded-md border border-border bg-muted/20 p-3">
                <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.transferred') }}</p>
                <p class="mt-1 font-mono text-sm tabular">
                  <span class="text-success">{{ formatBytes(node.metrics?.net_rx_bytes) }}</span>
                  /
                  <span class="text-primary">{{ formatBytes(node.metrics?.net_tx_bytes) }}</span>
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <!-- Network / IP -->
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <Globe class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('fleet.nodes.detail.network') }}
            </CardTitle>
            <CardDescription>{{ $t('fleet.nodes.detail.networkDesc') }}</CardDescription>
          </CardHeader>
          <CardContent class="space-y-4">
            <div class="grid gap-3 sm:grid-cols-2">
              <div class="flex items-start justify-between gap-2 rounded-md border border-border p-3">
                <div class="min-w-0">
                  <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.publicIp') }}</p>
                  <p class="mt-1 truncate font-mono text-sm" :title="node.public_ip || $t('common.misc.none')">{{ node.public_ip || $t('common.misc.none') }}</p>
                </div>
                <CopyButton v-if="node.public_ip" :value="node.public_ip" />
              </div>
              <div class="flex items-start justify-between gap-2 rounded-md border border-border p-3">
                <div class="min-w-0">
                  <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.publicIpv6') }}</p>
                  <p class="mt-1 truncate font-mono text-sm" :title="node.public_ipv6 || $t('common.misc.none')">{{ node.public_ipv6 || $t('common.misc.none') }}</p>
                </div>
                <CopyButton v-if="node.public_ipv6" :value="node.public_ipv6" />
              </div>
              <div class="flex items-start justify-between gap-2 rounded-md border border-border p-3">
                <div class="min-w-0">
                  <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.internalIp') }}</p>
                  <p class="mt-1 truncate font-mono text-sm" :title="displayInternalAddress(node.internal_ip, node.public_ip)">{{ displayInternalAddress(node.internal_ip, node.public_ip) }}</p>
                </div>
                <CopyButton
                  v-if="copyableInternalAddress(node.internal_ip, node.public_ip)"
                  :value="copyableInternalAddress(node.internal_ip, node.public_ip)"
                />
              </div>
              <div class="flex items-start justify-between gap-2 rounded-md border border-border p-3">
                <div class="min-w-0">
                  <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.internalIpv6') }}</p>
                  <p class="mt-1 truncate font-mono text-sm" :title="displayInternalAddress(node.internal_ipv6, node.public_ipv6)">{{ displayInternalAddress(node.internal_ipv6, node.public_ipv6) }}</p>
                </div>
                <CopyButton
                  v-if="copyableInternalAddress(node.internal_ipv6, node.public_ipv6)"
                  :value="copyableInternalAddress(node.internal_ipv6, node.public_ipv6)"
                />
              </div>
            </div>

            <!-- IP discovery override (operator-owned; pushed to the agent) -->
            <div v-if="canAdminNodes" class="space-y-3 rounded-md border border-border p-3">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <p class="inline-flex items-center gap-1.5 text-xs font-medium uppercase text-muted-foreground">
                  <Globe class="size-3.5" aria-hidden="true" />
                  {{ $t('fleet.nodes.detail.ipConfig.title') }}
                </p>
                <Badge :variant="node.ip_config?.mode ? 'outline' : 'secondary'">
                  {{ node.ip_config?.mode ? $t('fleet.nodes.detail.ipConfig.overrideActive') : $t('fleet.nodes.detail.ipConfig.inheriting') }}
                </Badge>
              </div>
              <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.ipConfig.hint') }}</p>
              <div class="grid gap-1.5 sm:max-w-xs">
                <Label>{{ $t('fleet.nodes.detail.ipConfig.mode') }}</Label>
                <Select v-model="ipMode">
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inherit">{{ $t('fleet.nodes.detail.ipConfig.modeInherit') }}</SelectItem>
                    <SelectItem value="auto">{{ $t('fleet.nodes.detail.ipConfig.modeAuto') }}</SelectItem>
                    <SelectItem value="static">{{ $t('fleet.nodes.detail.ipConfig.modeStatic') }}</SelectItem>
                    <SelectItem value="resolver">{{ $t('fleet.nodes.detail.ipConfig.modeResolver') }}</SelectItem>
                    <SelectItem value="script">{{ $t('fleet.nodes.detail.ipConfig.modeScript') }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div v-if="ipMode === 'static' || ipMode === 'auto'" class="grid gap-3 sm:grid-cols-2">
                <div class="grid gap-1.5">
                  <Label>{{ $t('fleet.nodes.detail.ipConfig.staticV4') }}</Label>
                  <Input v-model="ipStaticV4" placeholder="203.0.113.10" class="font-mono" />
                </div>
                <div class="grid gap-1.5">
                  <Label>{{ $t('fleet.nodes.detail.ipConfig.staticV6') }}</Label>
                  <Input v-model="ipStaticV6" placeholder="2001:db8::1" class="font-mono" />
                </div>
              </div>
              <div v-if="ipMode === 'resolver' || ipMode === 'auto'" class="grid gap-1.5">
                <Label>{{ $t('fleet.nodes.detail.ipConfig.resolvers') }}</Label>
                <Textarea
                  v-model="ipResolvers"
                  rows="2"
                  class="font-mono"
                  placeholder="https://api.ipify.org&#10;https://ifconfig.co/ip"
                />
                <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.ipConfig.resolversHint') }}</p>
              </div>
              <div v-if="ipMode === 'script'" class="grid gap-2">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <Label>{{ $t('fleet.nodes.detail.ipConfig.script') }}</Label>
                  <Badge v-if="node.ip_config?.script_sha256" variant="outline" class="font-mono" :title="node.ip_config.script_sha256">
                    {{ shortId(node.ip_config.script_sha256, 16) }}
                  </Badge>
                </div>
                <Textarea
                  v-model="ipScript"
                  rows="5"
                  class="font-mono"
                  placeholder="curl -fsS https://api.ipify.org&#10;# optional: echo an IPv6 on another line"
                />
                <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.ipConfig.scriptHint') }}</p>
                <p v-if="node.ip_config?.script_sha256 && !ipScript.trim()" class="text-xs text-muted-foreground">
                  {{ $t('fleet.nodes.detail.ipConfig.scriptPreserveHint') }}
                </p>
              </div>
              <div class="flex flex-wrap gap-2">
                <Button size="sm" :disabled="ipConfigPending || !canSaveIPConfig" @click="saveIPConfig">
                  <RefreshCw v-if="ipConfigPending" class="size-3.5 animate-spin" aria-hidden="true" />
                  {{ $t('common.actions.save') }}
                </Button>
                <Button v-if="node.ip_config?.mode" variant="ghost" size="sm" :disabled="ipConfigPending" @click="clearIPOpen = true">
                  {{ $t('fleet.nodes.detail.ipConfig.clear') }}
                </Button>
              </div>
            </div>

            <!-- Agent launch profile (installer/startup flags; requires rerun command) -->
            <div v-if="canAdminNodes" class="space-y-3 rounded-md border border-border p-3">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p class="inline-flex items-center gap-1.5 text-xs font-medium uppercase text-muted-foreground">
                    <KeyRound class="size-3.5" aria-hidden="true" />
                    {{ $t('fleet.nodes.detail.launch.title') }}
                  </p>
                  <p class="mt-1 text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.launch.hint') }}</p>
                </div>
                <div class="flex flex-wrap items-center gap-1.5">
                  <Badge :variant="node.agent_launch?.updated_at ? 'outline' : 'secondary'">
                    {{ node.agent_launch?.updated_at ? $t('fleet.nodes.detail.launch.profileSaved') : $t('fleet.nodes.detail.launch.profileUnknown') }}
                  </Badge>
                  <Badge :variant="node.agent_runtime?.reported_at ? 'success' : 'secondary'">
                    {{ node.agent_runtime?.reported_at ? $t('fleet.nodes.detail.launch.runtimeReported') : $t('fleet.nodes.detail.launch.runtimeUnknown') }}
                  </Badge>
                  <Badge v-if="launchDirty" variant="outline">
                    {{ $t('fleet.nodes.detail.launch.unsavedDraft') }}
                  </Badge>
                  <Badge v-if="launchRuntimeDrift" variant="secondary">
                    {{ $t('fleet.nodes.detail.launch.runtimeDrift') }}
                  </Badge>
                </div>
              </div>

              <div class="grid gap-2 text-xs md:grid-cols-3">
                <div class="rounded-md border border-border bg-background/60 p-2">
                  <p class="font-medium text-muted-foreground">{{ $t('fleet.nodes.detail.launch.runtimeNow') }}</p>
                  <p class="mt-1 text-foreground">{{ launchSnapshotSummary(runtimeLaunchSnapshot) }}</p>
                  <p class="mt-2 font-medium text-muted-foreground">{{ $t('fleet.nodes.detail.launch.taskSandbox') }}</p>
                  <p class="mt-1 text-foreground">{{ taskSandboxSummary(node.agent_runtime) }}</p>
                  <p class="mt-1 text-muted-foreground">{{ taskSandboxFeatures(node.agent_runtime) }}</p>
                  <p v-if="node.agent_runtime?.task_sandbox_warning" class="mt-1 text-warning">
                    {{ node.agent_runtime.task_sandbox_warning }}
                  </p>
                </div>
                <div class="rounded-md border border-border bg-background/60 p-2">
                  <p class="font-medium text-muted-foreground">{{ $t('fleet.nodes.detail.launch.savedDesired') }}</p>
                  <p class="mt-1 text-foreground">{{ launchSnapshotSummary(savedLaunchSnapshot) }}</p>
                </div>
                <div :class="cn('rounded-md border p-2', launchDirty ? 'border-warning/50 bg-warning/5' : 'border-border bg-background/60')">
                  <p class="font-medium text-muted-foreground">{{ $t('fleet.nodes.detail.launch.draft') }}</p>
                  <p class="mt-1 text-foreground">{{ launchSnapshotSummary(draftLaunchSnapshot) }}</p>
                </div>
              </div>
              <p class="text-xs" :class="launchDirty ? 'text-warning-foreground' : 'text-muted-foreground'">
                {{ launchDirty ? $t('fleet.nodes.detail.launch.draftChanges', { changes: launchDiffSummary }) : $t('fleet.nodes.detail.launch.noDraftChanges') }}
              </p>

              <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                <label class="flex items-start gap-2 rounded-md border border-border bg-background/60 p-3 text-sm">
                  <Checkbox v-model="launchAllowExec" class="mt-0.5" :disabled="launchNoExec" />
                  <span>
                    <span class="block font-medium">{{ $t('fleet.nodes.enroll.allowExec') }}</span>
                    <span class="text-xs text-muted-foreground">{{ $t('fleet.nodes.enroll.allowExecHint') }}</span>
                  </span>
                </label>
                <label class="flex items-start gap-2 rounded-md border border-border bg-background/60 p-3 text-sm">
                  <Checkbox v-model="launchAllowRootExec" class="mt-0.5" :disabled="launchNoExec || !launchAllowExec" />
                  <span>
                    <span class="block font-medium">{{ $t('fleet.nodes.enroll.allowRootExec') }}</span>
                    <span class="text-xs text-muted-foreground">{{ $t('fleet.nodes.enroll.allowRootExecHint') }}</span>
                  </span>
                </label>
                <label class="flex items-start gap-2 rounded-md border border-border bg-background/60 p-3 text-sm">
                  <Checkbox v-model="launchNoExec" class="mt-0.5" />
                  <span>
                    <span class="block font-medium">{{ $t('fleet.nodes.enroll.noExec') }}</span>
                    <span class="text-xs text-muted-foreground">{{ $t('fleet.nodes.enroll.noExecHint') }}</span>
                  </span>
                </label>
                <label class="flex items-start gap-2 rounded-md border border-border bg-background/60 p-3 text-sm">
                  <Checkbox v-model="launchAllowTerminal" class="mt-0.5" :disabled="launchNoExec" />
                  <span>
                    <span class="block font-medium">{{ $t('fleet.nodes.enroll.allowTerminal') }}</span>
                    <span class="text-xs text-muted-foreground">{{ $t('fleet.nodes.enroll.allowTerminalHint') }}</span>
                  </span>
                </label>
                <label class="flex items-start gap-2 rounded-md border border-border bg-background/60 p-3 text-sm">
                  <Checkbox v-model="launchSSHAlerts" class="mt-0.5" />
                  <span>
                    <span class="block font-medium">{{ $t('fleet.nodes.enroll.sshAlerts') }}</span>
                    <span class="text-xs text-muted-foreground">{{ $t('fleet.nodes.enroll.sshAlertsHint') }}</span>
                  </span>
                </label>
              </div>

              <div class="grid gap-3 md:grid-cols-3">
                <div class="grid gap-1.5">
                  <Label>{{ $t('fleet.nodes.enroll.terminalTransport') }}</Label>
                  <Select v-model="launchTerminalTransport" :disabled="!launchAllowTerminal">
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="poll">poll</SelectItem>
                      <SelectItem value="stream">stream</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div class="flex flex-wrap items-center gap-2">
                <Button size="sm" :disabled="reconfigurePending" @click="generateReconfigureCommand">
                  <RefreshCw v-if="reconfigurePending" class="size-3.5 animate-spin" aria-hidden="true" />
                  {{ $t('fleet.nodes.detail.launch.generate') }}
                </Button>
                <CopyButton v-if="reconfigureCommand" :value="reconfigureCommand" :label="$t('fleet.nodes.detail.launch.copy')" />
              </div>
              <div v-if="reconfigureCommand" class="space-y-2">
                <p
                  v-if="reconfigureCommandMismatch"
                  class="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive"
                >
                  {{ $t('fleet.nodes.detail.launch.nodeIdMismatch', { expected: node.id, actual: reconfigureCommandNodeId }) }}
                </p>
                <div class="inline-flex w-fit rounded-md border border-border bg-background/70 p-1">
                  <button
                    type="button"
                    :class="cn(
                      'rounded px-2.5 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                      launchPlatform === 'linux' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                    )"
                    :aria-pressed="launchPlatform === 'linux'"
                    @click="launchPlatform = 'linux'"
                  >
                    {{ $t('fleet.nodes.enroll.platformLinux') }}
                  </button>
                  <button
                    type="button"
                    :class="cn(
                      'rounded px-2.5 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                      launchPlatform === 'manual' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                    )"
                    :aria-pressed="launchPlatform === 'manual'"
                    @click="launchPlatform = 'manual'"
                  >
                    {{ $t('fleet.nodes.enroll.platformManual') }}
                  </button>
                </div>
                <code class="block overflow-x-auto whitespace-pre-wrap rounded-md bg-background/70 p-3 font-mono text-xs">
                  {{ reconfigureCommand }}
                </code>
              </div>
            </div>

            <!-- Geolocation -->
            <div class="rounded-md border border-border p-3">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <p class="inline-flex items-center gap-1.5 text-xs font-medium uppercase text-muted-foreground">
                  <MapPin class="size-3.5" aria-hidden="true" />
                  {{ $t('fleet.nodes.detail.geo') }}
                </p>
                <div class="flex items-center gap-2">
                  <Badge v-if="hasGeo" variant="outline">{{ geoSourceLabel(node.geo?.source) }}</Badge>
                  <Button
                    v-if="canAdminNodes"
                    variant="outline"
                    size="sm"
                    :disabled="resolvingGeo"
                    @click="resolveGeo"
                  >
                    <RefreshCw :class="cn('size-4', resolvingGeo && 'animate-spin')" aria-hidden="true" />
                    {{ $t('fleet.nodes.detail.resolveGeo') }}
                  </Button>
                </div>
              </div>
              <div v-if="hasGeo" class="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
                <div>
                  <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.geoCountry') }}</p>
                  <p class="mt-0.5">{{ node.geo?.country || $t('common.misc.none') }}</p>
                </div>
                <div>
                  <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.geoRegion') }}</p>
                  <p class="mt-0.5">{{ node.geo?.region || $t('common.misc.none') }}</p>
                </div>
                <div>
                  <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.geoCity') }}</p>
                  <p class="mt-0.5">{{ node.geo?.city || $t('common.misc.none') }}</p>
                </div>
                <div>
                  <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.geoAsn') }}</p>
                  <p class="mt-0.5 font-mono">{{ node.geo?.asn ?? $t('common.misc.none') }}</p>
                </div>
                <div class="col-span-2">
                  <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.geoAsOrg') }}</p>
                  <p class="mt-0.5 truncate" :title="node.geo?.as_org || $t('common.misc.none')">{{ node.geo?.as_org || $t('common.misc.none') }}</p>
                </div>
                <div>
                  <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.geoProvider') }}</p>
                  <p class="mt-0.5">{{ node.geo?.provider || $t('common.misc.none') }}</p>
                </div>
                <div v-if="node.geo?.updated_at" class="col-span-2 sm:col-span-3">
                  <p class="text-xs text-muted-foreground">
                    {{ $t('fleet.nodes.detail.geoUpdated', { time: formatDateTime(node.geo.updated_at) }) }}
                  </p>
                </div>
              </div>
              <p v-else class="mt-2 text-sm text-muted-foreground">{{ $t('fleet.nodes.detail.noGeo') }}</p>
            </div>
          </CardContent>
        </Card>

        <!-- Host facts -->
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <Server class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('fleet.nodes.detail.hostFacts') }}
            </CardTitle>
            <CardDescription>{{ $t('fleet.nodes.detail.hostFactsDesc') }}</CardDescription>
          </CardHeader>
          <CardContent>
            <dl v-if="node.host_facts" class="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              <div>
                <dt class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.factHostname') }}</dt>
                <dd class="mt-0.5 truncate font-mono text-sm" :title="node.host_facts.hostname || $t('common.misc.none')">{{ node.host_facts.hostname || $t('common.misc.none') }}</dd>
              </div>
              <div>
                <dt class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.factOs') }}</dt>
                <dd class="mt-0.5 text-sm">{{ node.host_facts.os || $t('common.misc.none') }}</dd>
              </div>
              <div>
                <dt class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.factPlatform') }}</dt>
                <dd class="mt-0.5 text-sm">
                  {{ [node.host_facts.platform, node.host_facts.platform_version].filter(Boolean).join(' ') || $t('common.misc.none') }}
                </dd>
              </div>
              <div>
                <dt class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.factKernel') }}</dt>
                <dd class="mt-0.5 truncate font-mono text-sm" :title="hostKernel(node.host_facts) || $t('common.misc.none')">{{ hostKernel(node.host_facts) || $t('common.misc.none') }}</dd>
              </div>
              <div>
                <dt class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.factArch') }}</dt>
                <dd class="mt-0.5 text-sm">{{ node.host_facts.arch || $t('common.misc.none') }}</dd>
              </div>
              <div>
                <dt class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.factCpu') }}</dt>
                <dd class="mt-0.5 text-sm">
                  {{ node.host_facts.cpu_cores ? $t('fleet.nodes.detail.coresValue', { value: node.host_facts.cpu_cores }) : $t('common.misc.none') }}
                </dd>
              </div>
              <div class="sm:col-span-2">
                <dt class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.factCpuModel') }}</dt>
                <dd class="mt-0.5 truncate text-sm" :title="node.host_facts.cpu_model || $t('common.misc.none')">{{ node.host_facts.cpu_model || $t('common.misc.none') }}</dd>
              </div>
              <div>
                <dt class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.factMemory') }}</dt>
                <dd class="mt-0.5 font-mono text-sm">{{ formatBytes(node.host_facts.memory_total) }}</dd>
              </div>
              <div>
                <dt class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.factSwap') }}</dt>
                <dd class="mt-0.5 font-mono text-sm">{{ formatBytes(node.host_facts.swap_total) }}</dd>
              </div>
              <div>
                <dt class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.factVirtualization') }}</dt>
                <dd class="mt-0.5 text-sm">{{ node.host_facts.virtualization || $t('common.misc.none') }}</dd>
              </div>
              <div>
                <dt class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.factBootTime') }}</dt>
                <dd class="mt-0.5 text-sm">{{ node.host_facts.boot_time ? formatDateTime(node.host_facts.boot_time) : $t('common.misc.none') }}</dd>
              </div>
            </dl>
            <p v-else class="text-sm text-muted-foreground">{{ $t('fleet.nodes.detail.noHostFacts') }}</p>
          </CardContent>
        </Card>
      </div>

      <!-- ── Side column ──────────────────────────────────────────── -->
      <div class="space-y-6">
        <!-- Group membership -->
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <FolderTree class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('fleet.nodes.detail.groups') }}
            </CardTitle>
          </CardHeader>
          <CardContent class="space-y-4">
            <div v-if="groupBadges.length" class="flex flex-wrap gap-2">
              <button
                v-for="g in groupBadges"
                :key="g.id"
                type="button"
                :class="cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  groupColor(g.color).border,
                  groupColor(g.color).soft,
                  groupColor(g.color).text,
                )"
                @click="goToGroup(g.id)"
              >
                <span :class="cn('size-2 shrink-0 rounded-full', groupColor(g.color).dot)" aria-hidden="true" />
                {{ g.name }}
                <Crown v-if="g.leader" class="size-3 shrink-0" aria-hidden="true" />
              </button>
            </div>
            <p v-else class="text-sm text-muted-foreground">{{ $t('fleet.nodes.detail.ungrouped') }}</p>

            <div class="space-y-2 border-t border-border pt-3">
              <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('fleet.nodes.detail.manageGroups') }}</p>
              <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.manageGroupsHint') }}</p>
              <Button variant="outline" size="sm" @click="goToGroups">
                <FolderTree class="size-4" aria-hidden="true" />
                {{ $t('fleet.nodes.detail.editGroupsInGroups') }}
              </Button>
            </div>
          </CardContent>
        </Card>

        <!-- Agent & updates -->
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <DownloadCloud class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('fleet.nodes.detail.agentUpdates') }}
            </CardTitle>
            <CardDescription>{{ $t('fleet.nodes.detail.agentUpdatesDesc') }}</CardDescription>
          </CardHeader>
          <CardContent class="space-y-4 text-sm">
            <div class="flex items-center justify-between gap-2">
              <span class="text-muted-foreground">{{ $t('fleet.nodes.detail.agentVersion') }}</span>
              <span class="font-mono">{{ node.agent_version || $t('fleet.nodes.detail.unknown') }}</span>
            </div>
            <template v-if="updatePolicy">
              <div class="flex items-center justify-between gap-2">
                <span class="text-muted-foreground">{{ $t('fleet.nodes.detail.targetVersion') }}</span>
                <span class="font-mono">{{ updatePolicy.target_version || $t('common.misc.none') }}</span>
              </div>
              <div class="flex items-center justify-between gap-2">
                <span class="text-muted-foreground">{{ $t('fleet.nodes.detail.lastApplied') }}</span>
                <span class="font-mono">{{ updatePolicy.last_applied_version || $t('common.misc.none') }}</span>
              </div>
              <div class="flex items-center justify-between gap-2">
                <span class="text-muted-foreground">{{ $t('fleet.nodes.detail.lastPlanned') }}</span>
                <span class="tabular text-xs text-muted-foreground">{{ updatePolicy.last_planned_at ? formatRelativeTime(updatePolicy.last_planned_at) : $t('common.misc.none') }}</span>
              </div>
              <div class="flex flex-wrap items-center gap-2 pt-1">
                <Badge :variant="updatePolicy.enabled ? 'success' : 'secondary'">
                  {{ updatePolicy.enabled ? $t('fleet.nodes.detail.updatesEnabled') : $t('common.status.disabled') }}
                </Badge>
                <Badge v-if="updatePolicy.auto_plan" variant="info">{{ $t('fleet.nodes.detail.autoPlan') }}</Badge>
              </div>
              <p v-if="activeAgentUpdateError" class="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                {{ activeAgentUpdateError }}
              </p>
              <p v-else-if="agentAppliedVersionMismatch" class="rounded-md border border-warning/40 bg-warning/5 p-2 text-xs text-warning-foreground">
                {{ $t('fleet.nodes.detail.agentVersionMismatch', { current: node.agent_version, applied: updatePolicy.last_applied_version }) }}
              </p>
            </template>
            <p v-else class="text-muted-foreground">{{ $t('fleet.nodes.detail.noUpdatePolicy') }}</p>

            <div v-if="canAdminNodes" class="space-y-3 rounded-md border border-border bg-muted/20 p-3">
              <div class="rounded-md border border-border bg-background/60 p-2 text-xs">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <span class="font-medium text-muted-foreground">{{ $t('fleet.nodes.detail.savedPolicy') }}</span>
                  <Badge v-if="updateDirty" variant="outline">{{ $t('fleet.nodes.detail.unsavedDraft') }}</Badge>
                </div>
                <p class="mt-1 text-foreground">{{ savedUpdateSummary }}</p>
                <p class="mt-1 text-muted-foreground">{{ $t('fleet.nodes.detail.draftPolicy', { value: draftUpdateSummary }) }}</p>
              </div>
              <div class="grid gap-2">
                <Label for="agent-update-target">{{ $t('fleet.nodes.detail.targetVersion') }}</Label>
                <Input
                  id="agent-update-target"
                  v-model="updateTarget"
                  class="font-mono"
                  :placeholder="$t('fleet.nodes.detail.targetVersionPlaceholder')"
                  @input="touchUpdateDraft"
                />
              </div>
              <label class="flex items-start gap-2 text-sm">
                <Checkbox v-model="updateAuto" class="mt-0.5" @update:model-value="touchUpdateDraft" />
                <span>
                  <span class="block font-medium">{{ $t('fleet.nodes.detail.autoPlan') }}</span>
                  <span class="block text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.autoUpdateHint') }}</span>
                </span>
              </label>
              <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.detail.updateRequiresExec') }}</p>
              <div class="grid gap-2 sm:grid-cols-2">
                <Button
                  variant="outline"
                  size="sm"
                  :disabled="savingUpdatePolicy"
                  @click="saveAutoUpdate"
                >
                  <RefreshCw v-if="savingUpdatePolicy" class="size-4 animate-spin" aria-hidden="true" />
                  <DownloadCloud v-else class="size-4" aria-hidden="true" />
                  {{ $t('fleet.nodes.detail.saveAutoUpdate') }}
                </Button>
                <Button
                  v-if="canPlanUpdates"
                  size="sm"
                  :disabled="planningUpdate"
                  @click="planUpdate()"
                >
                  <RefreshCw :class="cn('size-4', planningUpdate && 'animate-spin')" aria-hidden="true" />
                  {{ $t('fleet.nodes.detail.planUpdate') }}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <!-- DDNS bindings -->
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <Globe class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('fleet.nodes.detail.ddns') }}
            </CardTitle>
            <CardDescription>{{ $t('fleet.nodes.detail.ddnsDesc') }}</CardDescription>
          </CardHeader>
          <CardContent class="space-y-3">
            <div
              v-for="d in nodeDdns"
              :key="d.id"
              class="rounded-md border border-border p-3"
            >
              <div class="flex items-center justify-between gap-2">
                <span class="truncate text-sm font-medium" :title="d.name">{{ d.name }}</span>
                <Badge variant="secondary">{{ d.provider }}</Badge>
              </div>
              <p
                class="mt-1 truncate font-mono text-xs text-muted-foreground"
                :title="d.domains.join(', ') || $t('common.misc.none')"
              >
                {{ d.domains.join(', ') || $t('common.misc.none') }}
              </p>
              <p v-if="d.last_run_at" class="mt-1 text-xs text-muted-foreground">
                {{ $t('fleet.nodes.detail.ddnsLastRun', { time: formatRelativeTime(d.last_run_at) }) }}
              </p>
            </div>
            <p v-if="nodeDdns.length === 0" class="text-sm text-muted-foreground">{{ $t('fleet.nodes.detail.noDdns') }}</p>
          </CardContent>
        </Card>

        <!-- Work still waiting on this node -->
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <ListOrdered class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('fleet.nodes.detail.queue') }}
              <Badge v-if="nodeQueue.entries.length" variant="secondary">{{ nodeQueue.entries.length }}</Badge>
            </CardTitle>
            <CardDescription>{{ $t('fleet.nodes.detail.queueDesc') }}</CardDescription>
          </CardHeader>
          <CardContent>
            <DataState
              :loading="nodeTasksQuery.loading.value"
              :error="nodeTasksQuery.error.value"
              :has-data="nodeTasksQuery.data.value !== undefined"
              :is-empty="nodeQueue.entries.length === 0"
              :empty-description="$t('fleet.nodes.detail.queueEmpty')"
              :skeleton-rows="2"
              @retry="nodeTasksQuery.refresh"
            >
              <ol class="space-y-2">
                <li
                  v-for="(entry, index) in nodeQueue.entries"
                  :key="entry.id"
                  class="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                >
                  <div class="flex min-w-0 items-center gap-3">
                    <span class="w-5 shrink-0 text-xs text-muted-foreground tabular">{{ index + 1 }}</span>
                    <div class="min-w-0 space-y-0.5">
                      <RouterLink
                        class="block truncate font-mono text-xs hover:underline"
                        :to="{ name: 'tasks', query: { id: entry.id } }"
                      >{{ entry.id }}</RouterLink>
                      <p class="text-xs text-muted-foreground">
                        {{ entry.interpreter }}
                        <template v-if="entry.targetCount > 1">
                          · {{ $t('fleet.nodes.detail.queueFanout', { count: entry.targetCount }) }}
                        </template>
                        <template v-if="entry.createdAt">
                          · {{ formatRelativeTime(entry.createdAt) }}
                        </template>
                      </p>
                      <!-- The lease line is what turns "Running" into evidence: how
                           long, which attempt, and why the store stopped if it did. -->
                      <p
                        v-if="queueLeaseLabel(entry)"
                        :class="cn('text-xs', taskStateStyle(queueState(entry)).textClass)"
                        :title="queueLeaseLabel(entry)"
                      >
                        {{ queueLeaseLabel(entry) }}
                      </p>
                    </div>
                  </div>
                  <Badge :variant="queueBadge(entry).variant">
                    {{ queueBadge(entry).label }}
                  </Badge>
                </li>
              </ol>
              <p v-if="node && !isReporting(node) && nodeQueue.queued > 0" class="mt-3 text-xs text-muted-foreground">
                {{ $t('fleet.nodes.detail.queueOfflineHint') }}
              </p>
            </DataState>
          </CardContent>
        </Card>

        <!-- Recent audit-for-node -->
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <ScrollText class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('fleet.nodes.detail.activity') }}
            </CardTitle>
            <CardDescription>{{ $t('fleet.nodes.detail.activityDesc') }}</CardDescription>
          </CardHeader>
          <CardContent>
            <DataState
              :loading="auditQuery.loading.value"
              :error="auditQuery.error.value"
              :has-data="auditQuery.data.value !== undefined"
              :is-empty="timeline.length === 0"
              :empty-description="$t('fleet.nodes.detail.noActivity')"
              :skeleton-rows="4"
              @retry="auditQuery.refresh"
            >
              <div class="space-y-4">
                <section v-for="day in timelineDays" :key="day.day" class="space-y-1">
                  <p class="text-xs font-medium text-muted-foreground tabular">{{ day.day }}</p>
                  <ol class="relative space-y-0 border-l border-border pl-4">
                    <li v-for="entry in day.entries" :key="entry.id" class="relative py-2">
                      <span
                        class="absolute -left-[1.4rem] top-2.5 flex size-4 items-center justify-center rounded-full bg-background text-muted-foreground"
                      >
                        <component :is="timelineIcon(entry.kind)" class="size-3.5" aria-hidden="true" />
                      </span>
                      <div class="flex items-start gap-2">
                        <div class="min-w-0 flex-1">
                          <p class="truncate font-mono text-xs tabular" :title="entry.action">
                            <RouterLink
                              v-if="timelineHref(entry)"
                              :to="timelineHref(entry)!"
                              class="hover:underline"
                            >
                              {{ entry.action }}
                            </RouterLink>
                            <template v-else>{{ entry.action }}</template>
                          </p>
                          <p
                            class="truncate text-xs text-muted-foreground"
                            :title="[entry.actor, entry.detail].filter(Boolean).join(' · ') || $t('common.misc.none')"
                          >
                            <template v-if="entry.actor">{{ entry.actor }}</template>
                            <template v-if="entry.actor && entry.detail"> · </template>
                            <template v-if="entry.detail">{{ entry.detail }}</template>
                            <template v-if="!entry.actor && !entry.detail">{{ $t('common.misc.none') }}</template>
                          </p>
                        </div>
                        <Badge :variant="outcomeVariant(entry.outcome)" class="shrink-0">{{ entry.outcome }}</Badge>
                        <span class="shrink-0 text-xs text-muted-foreground tabular">
                          {{ formatRelativeTime(entry.at) }}
                        </span>
                      </div>
                    </li>
                  </ol>
                </section>
                <Button
                  v-if="timelineHasMore"
                  variant="outline"
                  size="sm"
                  class="w-full"
                  @click="timelineExpanded = true"
                >
                  {{ $t('common.actions.loadMore') }}
                </Button>
              </div>
            </DataState>
          </CardContent>
        </Card>
      </div>

      <!-- ── Admin & danger zone ──────────────────────────────────── -->
      <Card v-if="canAdminNodes" class="border-destructive/40 lg:col-span-3">
        <CardHeader>
          <CardTitle class="flex items-center gap-2">
            <Power class="size-4 text-destructive" aria-hidden="true" />
            {{ $t('fleet.nodes.detail.admin') }}
          </CardTitle>
          <CardDescription>{{ $t('fleet.nodes.detail.adminDesc') }}</CardDescription>
        </CardHeader>
        <CardContent class="space-y-5">
          <div class="flex flex-wrap gap-2">
            <Button
              :variant="node.disabled ? 'outline' : 'destructive'"
              size="sm"
              :disabled="pending"
              @click="requestDisable(!node.disabled)"
            >
              <Power class="size-4" aria-hidden="true" />
              {{ node.disabled ? $t('common.actions.enable') : $t('common.actions.disable') }}
            </Button>
            <Button variant="outline" size="sm" :disabled="pending" @click="rotateOpen = true">
              <KeyRound class="size-4" aria-hidden="true" />
              {{ $t('fleet.nodes.detail.rotateToken') }}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              class="ml-auto"
              :disabled="pending || deletePending"
              @click="openDeleteDialog"
            >
              <Trash2 class="size-4" aria-hidden="true" />
              {{ $t('fleet.nodes.detail.deleteNode') }}
            </Button>
          </div>

          <!-- One-time token reveal (mirrors NodesView). -->
          <div v-if="rotatedToken" class="grid gap-3 rounded-md border border-warning/40 bg-warning/5 p-4">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p class="text-sm font-medium">{{ $t('fleet.nodes.rotated.tokenFor', { id: rotatedToken.node_id }) }}</p>
                <p class="text-xs text-muted-foreground">{{ $t('fleet.nodes.rotated.hint') }}</p>
              </div>
              <CopyButton :value="rotatedToken.token" :label="$t('fleet.nodes.rotated.copyToken')" />
            </div>
            <code class="block overflow-x-auto whitespace-pre-wrap rounded-md bg-background/70 p-3 font-mono text-xs">{{ rotatedToken.token }}</code>
          </div>

          <!-- Agent diagnostics / debug -->
          <div class="rounded-md border border-border p-4">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="space-y-1">
                <h3 class="text-sm font-medium">{{ $t('fleet.nodes.detail.diagnostics') }}</h3>
                <p class="text-sm text-muted-foreground">{{ $t('fleet.nodes.detail.debugDescription') }}</p>
              </div>
              <Badge :variant="node.agent_debug?.enabled ? 'warning' : 'secondary'">
                {{ node.agent_debug?.enabled ? $t('common.status.enabled') : $t('common.status.disabled') }}
              </Badge>
            </div>
            <div class="mt-4 grid gap-3">
              <label class="flex items-start gap-3 text-sm">
                <Checkbox
                  class="mt-0.5"
                  :model-value="!!node.agent_debug?.enabled"
                  :disabled="debugPending"
                  @update:model-value="(value) => setNodeDebug(value === true, node?.agent_debug?.collect ?? true)"
                />
                <span class="space-y-1">
                  <span class="block font-medium">{{ $t('fleet.nodes.detail.debugEnabled') }}</span>
                  <span class="block text-muted-foreground">{{ $t('fleet.nodes.detail.debugLocalHint') }}</span>
                </span>
              </label>
              <label class="flex items-start gap-3 text-sm" :class="!node.agent_debug?.enabled && 'opacity-60'">
                <Checkbox
                  class="mt-0.5"
                  :model-value="!!node.agent_debug?.collect"
                  :disabled="!node.agent_debug?.enabled || debugPending"
                  @update:model-value="(value) => setNodeDebug(true, value === true)"
                />
                <span class="space-y-1">
                  <span class="block font-medium">{{ $t('fleet.nodes.detail.debugCollect') }}</span>
                  <span class="block text-muted-foreground">{{ $t('fleet.nodes.detail.debugCollectHint', { path: `agent-debug://${node.id}` }) }}</span>
                </span>
              </label>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>

    <!-- Agent update no-op: node already reports target version. -->
    <!-- Excluding needs a reason, and the API refuses without one. The reason
         is the whole point of the state: "not this one" tells the next reader
         nothing, and six months later nobody re-derives why a machine was left
         out. -->
    <Dialog v-model:open="excludeOpen">
      <DialogScrollContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ $t('fleet.nodes.detail.capabilities.excludeTitle', { capability: excludeCapability }) }}</DialogTitle>
          <DialogDescription>{{ $t('fleet.nodes.detail.capabilities.excludeDescription') }}</DialogDescription>
        </DialogHeader>
        <div class="grid gap-1.5">
          <Label for="exclude-reason">{{ $t('fleet.nodes.detail.capabilities.excludeReason') }}</Label>
          <Input
            id="exclude-reason"
            v-model="excludeReason"
            :placeholder="$t('fleet.nodes.detail.capabilities.excludeReasonPlaceholder')"
            @keydown.enter.prevent="confirmExclude"
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" @click="excludeOpen = false">
            {{ $t('common.actions.cancel') }}
          </Button>
          <Button type="button" variant="destructive" :disabled="!excludeReason.trim()" @click="confirmExclude">
            {{ $t('fleet.nodes.detail.capabilities.exclude') }}
          </Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>

    <Dialog v-model:open="updateNoopOpen">
      <DialogScrollContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ $t('fleet.nodes.detail.updateNoopTitle') }}</DialogTitle>
          <DialogDescription>{{ updateNoopMessage }}</DialogDescription>
        </DialogHeader>
        <p class="text-sm text-muted-foreground">
          {{ $t('fleet.nodes.detail.updateNoopHint') }}
        </p>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            :disabled="planningUpdate"
            @click="updateNoopOpen = false"
          >
            {{ $t('common.actions.cancel') }}
          </Button>
          <Button
            type="button"
            :disabled="planningUpdate"
            @click="forcePlanUpdate"
          >
            <RefreshCw :class="cn('size-4', planningUpdate && 'animate-spin')" aria-hidden="true" />
            {{ $t('fleet.nodes.detail.forceUpdatePlan') }}
          </Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>

    <!-- Hard-delete confirm: previews the cascade impact, then gates the
         destructive confirm behind typing the node name. -->
    <Dialog :open="deleteOpen" @update:open="onDeleteOpenChange">
      <DialogScrollContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2 text-destructive">
            <Trash2 class="size-4" aria-hidden="true" />
            {{ $t('fleet.nodes.detail.deleteTitle') }}
          </DialogTitle>
          <DialogDescription>
            {{ $t('fleet.nodes.detail.deleteConfirm', { name: node.name || node.id }) }}
          </DialogDescription>
        </DialogHeader>

        <div class="space-y-4">
          <!-- Cascade impact preview. -->
          <div class="rounded-md border border-border bg-muted/20 p-3">
            <p v-if="deletePlanning" class="inline-flex items-center gap-2 text-sm text-muted-foreground">
              <RefreshCw class="size-3.5 animate-spin" aria-hidden="true" />
              {{ $t('common.actions.refresh') }}…
            </p>
            <template v-else-if="deleteImpactRows.length">
              <p class="mb-2 text-xs font-medium uppercase text-muted-foreground">
                {{ $t('fleet.nodes.detail.deleteImpact') }}
              </p>
              <ul class="space-y-1 text-sm">
                <li
                  v-for="row in deleteImpactRows"
                  :key="row.key"
                  class="flex items-center justify-between gap-3"
                >
                  <span class="text-muted-foreground">{{ row.label }}</span>
                  <span class="font-mono tabular">{{ row.count }}</span>
                </li>
              </ul>
            </template>
            <p v-else class="text-sm text-muted-foreground">
              {{ $t('fleet.nodes.detail.deleteNoImpact') }}
            </p>
          </div>

          <!-- Type-the-name gate. -->
          <div class="grid gap-1.5">
            <Label for="delete-node-name">
              {{ $t('fleet.nodes.detail.deleteTypeNamePrompt', { name: node.name || node.id }) }}
            </Label>
            <Input
              id="delete-node-name"
              v-model="deleteNameInput"
              :disabled="deletePending"
              autocomplete="off"
              class="font-mono"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            :disabled="deletePending"
            @click="onDeleteOpenChange(false)"
          >
            {{ $t('common.actions.cancel') }}
          </Button>
          <Button
            type="button"
            variant="destructive"
            :disabled="deletePending || !deleteNameMatches"
            @click="deleteNode"
          >
            <RefreshCw v-if="deletePending" class="size-4 animate-spin" aria-hidden="true" />
            <Trash2 v-else class="size-4" aria-hidden="true" />
            {{ deletePending ? $t('fleet.nodes.detail.deleteRemoving') : $t('fleet.nodes.detail.deleteNode') }}
          </Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>

    <ConfirmDialog
      v-model:open="disableOpen"
      :title="$t('fleet.nodes.confirm.disableTitle')"
      :description="$t('fleet.nodes.confirm.disableDescription', { name: nodeLabel })"
      :confirm-label="$t('common.actions.disable')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="pending"
      @confirm="confirmDisable"
    />

    <ConfirmDialog
      v-model:open="rotateOpen"
      :title="$t('fleet.nodes.confirm.rotateTitle')"
      :description="$t('fleet.nodes.confirm.rotateDescription', { name: nodeLabel })"
      :confirm-label="$t('fleet.nodes.detail.rotateToken')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="pending"
      @confirm="confirmRotateToken"
    />

    <ConfirmDialog
      v-model:open="clearIPOpen"
      :title="$t('fleet.nodes.confirm.clearIpTitle')"
      :description="$t('fleet.nodes.confirm.clearIpDescription', { name: nodeLabel })"
      :confirm-label="$t('fleet.nodes.detail.ipConfig.clear')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="ipConfigPending"
      @confirm="clearIPConfig"
    />
  </div>

  <!-- Loading / error / not-found. -->
  <div v-else class="space-y-4 p-6">
    <Button variant="ghost" size="sm" @click="goBack">
      <ArrowLeft class="size-4" aria-hidden="true" />
      {{ $t('fleet.nodes.detail.backToNodes') }}
    </Button>
    <DataState
      :loading="nodesQuery.loading.value"
      :error="nodesQuery.error.value"
      :has-data="nodesQuery.data.value !== undefined"
      :is-empty="notFound"
      :empty-title="$t('fleet.nodes.detail.notFoundTitle')"
      :empty-description="$t('fleet.nodes.detail.notFoundDescription')"
      @retry="nodesQuery.refresh"
    >
      <template #empty>
        <EmptyState
          :icon="Server"
          :title="$t('fleet.nodes.detail.notFoundTitle')"
          :description="$t('fleet.nodes.detail.notFoundDescription')"
        >
          <Button size="sm" @click="goBack">
            <ArrowLeft class="size-4" aria-hidden="true" />
            {{ $t('fleet.nodes.detail.backToNodes') }}
          </Button>
        </EmptyState>
      </template>
    </DataState>
  </div>
</template>
