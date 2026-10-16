<script setup lang="ts">
/**
 * Create or edit a check (design 29 D9), in task order: what to measure,
 * from where, to where, what counts as up, how often, what to do when it
 * fails, and its name.
 *
 * An edit goes to POST /api/monitors/update with the version the check was
 * read at; the server refuses a stale one (409) and the sheet says so and
 * reloads. Changing the method, the target or the target node is not an
 * edit: one history must never mix two measurements, so after the operator
 * confirms, the sheet creates a new check and pauses the old one, which
 * keeps its history. If the pause fails after the create, the sheet says
 * exactly that.
 *
 * On an M2a server (`m2a`) the sheet adds ICMP, a node as the target with
 * what it resolves to for every source, packets, an http check's expected
 * statuses and request headers with write-only secrets, and source gating
 * by the methods each agent runs. Against an older server none of it shows
 * and the bodies are M1's.
 *
 * On an M2b server (`m2b`) it adds Beacon (design 29 D12): always a node
 * target, offered only on nodes with an enabled beacon, sent only from
 * sources that run the beacon client, and with a target chosen, the sheet
 * reads that node's beacon to say which sources its plan admits.
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Plus, RefreshCw, Save } from "lucide-vue-next";

import { RouterLink } from "vue-router";

import { api, type BeaconView, type LatencyProbePlan, type MonitorType, type MonitorView, type Node } from "@/lib/api";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import ObjectSheet from "@/components/common/ObjectSheet.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import HeaderRows from "./HeaderRows.vue";
import NodeTargetPicker from "./NodeTargetPicker.vue";
import SourcePicker from "./SourcePicker.vue";
import { EXPECT_STATUS_DEFAULT, agentReportsMethods, destinationProblem, isHttpsUrl, monitorOrigin, parseStatusSet, sourceSupport } from "./checkRulesModel";
import {
  ALERT_MAX_AFTER,
  CHECK_MAX_INTERVAL_SEC,
  CHECK_MAX_TIMEOUT_SEC,
  CHECK_MIN_INTERVAL_SEC,
  PACKETS_MAX,
  PACKETS_PER_SECOND_MAX,
  beaconBudget,
  buildCarryPauses,
  buildCreate,
  buildPauseOld,
  buildUpdate,
  budgetRechecked,
  draftChanged,
  draftFromMonitor,
  draftHeaderProblems,
  draftNeedsCurrentAgent,
  draftProblems,
  draftSources,
  emptyDraft,
  icmpBudget,
  icmpRunSeconds,
  identityChanged,
  multiPacket,
  nodeOnly,
  offeredKinds,
  resolveNodeTarget,
  suggestName,
  switchDraftKind,
  takesNodeTarget,
  unsupportedSources,
  usesNodeTarget,
  type CheckDraft,
  type TargetMode,
} from "./checksModel";
import { useTargetCopy } from "./checksCopy";
import { TLS_MAX_THRESHOLD_DAYS, isServerEvaluated, targetError } from "./monitorTypeModel";
import { usePathsCopy } from "./pathsCopy";

const props = defineProps<{
  open: boolean;
  /** The check being edited; absent when creating. */
  monitor?: MonitorView;
  /** The method a create opens on. */
  initialType?: MonitorType;
  nodes: Node[];
  canReadNodes: boolean;
  /** The server takes an alert policy (design 29 servers do). */
  withAlert: boolean;
  /** The server speaks M2a (checkRulesModel.serverSpeaksM2a). */
  m2a?: boolean;
  /** The server speaks M2b, the beacon (checkRulesModel.serverSpeaksM2b). */
  m2b?: boolean;
  /** Every check, for the ICMP packet budget to one address. */
  monitors?: MonitorView[];
  /** The path set plan: the server's own resolution of the nodes it targets. */
  plan?: LatencyProbePlan;
}>();

const emit = defineEmits<{ close: []; saved: [id: string]; reload: [] }>();

const { t } = useI18n();
const { resolutionText, destinationText, statusSetText } = useTargetCopy();
const { refusalText, reasonShort, methodName } = usePathsCopy();

const draft = ref<CheckDraft>(emptyDraft());
const base = ref<CheckDraft>(emptyDraft());
/** The server's refusal of the last save, shown until the form changes. */
const saveError = ref<string>();
watch(draft, () => (saveError.value = undefined), { deep: true });
let stash: Parameters<typeof switchDraftKind>[2];

function copyDraft(d: CheckDraft): CheckDraft {
  return { ...d, nodeIds: [...d.nodeIds], pausedNodeIds: [...d.pausedNodeIds], headers: d.headers.map((h) => ({ ...h })) };
}

watch(
  () => props.open,
  (open) => {
    saveError.value = undefined;
    if (!open) {
      // A typed secret leaves with the sheet; the rest of the form stays drawn while it slides out.
      draft.value = { ...draft.value, headers: draft.value.headers.map((h) => (h.secret ? { ...h, value: "" } : h)) };
      return;
    }
    const start = props.monitor ? draftFromMonitor(props.monitor) : emptyDraft(props.initialType ?? "http");
    draft.value = copyDraft(start);
    base.value = start;
    stash = undefined;
  },
  { immediate: true },
);

const m2a = computed(() => !!props.m2a);
const m2b = computed(() => m2a.value && !!props.m2b);
const editing = computed(() => !!props.monitor);
const isTls = computed(() => isServerEvaluated(draft.value.type));
const kinds = computed(() => {
  const list = offeredKinds(m2a.value, m2b.value);
  // A check of a kind this server no longer offers still shows its own.
  return props.monitor && !list.includes(props.monitor.type as MonitorType) ? [...list, props.monitor.type as MonitorType] : list;
});

/** Node targets need the node list and an M2a server. */
const offerNodeTarget = computed(() => m2a.value && props.canReadNodes && takesNodeTarget(draft.value.type));
const nodeMode = computed(() => offerNodeTarget.value && usesNodeTarget(draft.value));
/** A beacon check has no address to choose instead, so no choice is drawn. */
const showTargetMode = computed(() => offerNodeTarget.value && !nodeOnly(draft.value.type));
const isBeacon = computed(() => draft.value.type === "beacon");

function setKind(kind: MonitorType): void {
  const next = switchDraftKind(draft.value, kind, stash);
  let d = next.draft;
  // A fresh ICMP or TCP check most often targets a node; open on the picker when nothing is typed yet.
  if (m2a.value && props.canReadNodes && takesNodeTarget(kind) && !d.target.trim() && !d.targetNode && !props.monitor) d = { ...d, targetMode: "node" };
  draft.value = d;
  stash = next.stash;
}

function setTargetMode(mode: TargetMode): void {
  draft.value = { ...draft.value, targetMode: mode };
}

/* ---- Node target and sources ---- */

const nodesById = computed(() => new Map(props.nodes.map((n) => [n.id, n])));
const planNodes = computed(() => new Map((props.plan?.nodes ?? []).map((n) => [n.node_id, n])));
const targetNode = computed(() => nodesById.value.get(draft.value.targetNode));
const nodeResolution = computed(() =>
  nodeMode.value && draft.value.targetNode ? resolveNodeTarget(draft.value.type, targetNode.value, planNodes.value.get(draft.value.targetNode), props.plan?.config?.method) : undefined,
);
/** The address the sources would send to: the node's resolution, or the address typed. */
const address = computed(() => (nodeMode.value ? (nodeResolution.value?.state === "resolved" ? nodeResolution.value.endpoint : "") : draft.value.target.trim()));
/** The sources that would send: a paused source sends nothing, so the server's budget leaves it out. */
const sendingIds = computed(() => draftSources(draft.value, props.nodes).filter((id) => !draft.value.pausedNodeIds.includes(id)));
/** A replacement is created while the check it replaces still runs, so the server counts both. */
const budget = computed(() => {
  const editingId = replaces.value ? undefined : props.monitor?.id;
  if (draft.value.type === "icmp") return icmpBudget(address.value, sendingIds.value, draft.value, props.monitors ?? [], editingId);
  if (isBeacon.value) return beaconBudget(draft.value.targetNode, sendingIds.value, draft.value, props.monitors ?? [], editingId);
  return undefined;
});

/*
 * The chosen target's beacon, for which sources its plan admits (design 29
 * D12): a source the plan has not approved reads firewall pending (under
 * NetGuard) or source pending until a change plan on the target is approved.
 * Read once per chosen node; a failed read only drops the per-source note.
 */
const targetBeacon = ref<BeaconView>();
let beaconRead: AbortController | undefined;
watch(
  () => (props.open && isBeacon.value && m2b.value ? draft.value.targetNode : ""),
  (nodeId) => {
    beaconRead?.abort();
    targetBeacon.value = undefined;
    if (!nodeId) return;
    const controller = new AbortController();
    beaconRead = controller;
    api.nodes.beacon
      .get(nodeId, { signal: controller.signal })
      .then((view) => {
        if (!controller.signal.aborted && view && typeof view === "object" && view.node_id === nodeId) targetBeacon.value = view;
      })
      .catch(() => undefined);
  },
  { immediate: true },
);
/** Why a source would wait on the target's plan, or undefined when its plan admits it (or nothing is known). */
function beaconWaiting(source: string): string | undefined {
  const view = targetBeacon.value;
  if (!isBeacon.value || !view) return undefined;
  const entry = (view.sources ?? []).find((s) => s.node_id === source);
  if (entry?.approved) return undefined;
  return entry?.reason || (view.exposure === "netguard" ? "firewall_pending" : "beacon_source_pending");
}
const currentAgent = computed(() => m2a.value && draftNeedsCurrentAgent(draft.value));
const unsupported = computed(() => (isTls.value ? [] : unsupportedSources(draft.value, props.nodes, m2a.value)));
/** The unsupported sources by name: the first eight, then a count. */
const unsupportedNames = computed(() => {
  const names = unsupported.value.slice(0, PREVIEW_MAX).map((u) => nameOf(u.id));
  const more = unsupported.value.length - names.length;
  return more > 0 ? `${names.join(", ")} ${t("fleet.monitoring.checks.editor.target.previewMore", { n: more })}` : names.join(", ");
});
/** What the unsupported sources cannot run: for http, only its headers or status set are new. */
const unsupportedMethod = computed(() => (currentAgent.value && draft.value.type === "http" ? t("fleet.monitoring.checks.editor.methodCurrentHttp") : methodName(draft.value.type)));
const nameOf = (id: string) => nodesById.value.get(id)?.name || id;

function removeUnsupported(): void {
  const drop = new Set(unsupported.value.map((u) => u.id));
  draft.value = { ...draft.value, nodeIds: draft.value.nodeIds.filter((id) => !drop.has(id)), pausedNodeIds: draft.value.pausedNodeIds.filter((id) => !drop.has(id)) };
}

/** What every chosen source would dial, before saving (D9): at most eight, then a count. */
const PREVIEW_MAX = 8;
const sourcePreview = computed(() => {
  if (!nodeMode.value || !draft.value.targetNode || draft.value.assignAll) return [];
  return draft.value.nodeIds.map((id) => {
    const support = sourceSupport(nodesById.value.get(id), draft.value.type, m2a.value, currentAgent.value);
    return { id, name: nameOf(id), why: support.ok ? undefined : support.reason, waiting: support.ok ? beaconWaiting(id) : undefined };
  });
});

/* ---- Rules ---- */

const replaces = computed(() => !!props.monitor && identityChanged(props.monitor, draft.value));
const newCheck = computed(() => !props.monitor || replaces.value);
const rules = computed(() => ({
  m2a: m2a.value,
  nodeTarget: nodeResolution.value,
  budgetPps: budgetRechecked(props.monitor, draft.value, newCheck.value) ? budget.value?.pps : undefined,
  newCheck: newCheck.value,
}));
const problems = computed(() => draftProblems(draft.value, rules.value));
const targetProblem = computed(() => {
  if (nodeMode.value || !draft.value.target.trim()) return undefined;
  if (targetError(draft.value.type, draft.value.target)) return "shape";
  return problems.value.includes("destination") ? "destination" : undefined;
});
const destination = computed(() => destinationProblem(draft.value.type, draft.value.target));
/** Nodes whose agent reports no methods: a check that needs a current agent does not run on them. */
const olderAgents = computed(() => (currentAgent.value ? props.nodes.filter((n) => !agentReportsMethods(n)).length : 0));
const offerHttp = computed(() => draft.value.type === "tcp" && /^https?:\/\//i.test(draft.value.target.trim()));
const suggested = computed(() => suggestName(draft.value.type, draft.value.target, nodeMode.value ? targetNode.value?.name || draft.value.targetNode || undefined : undefined));
const dirty = computed(() => (props.monitor ? draftChanged(props.monitor, draft.value) : JSON.stringify(draft.value) !== JSON.stringify(base.value)));

const statusSet = computed(() => parseStatusSet(draft.value.expectStatus));
const headerProblemsNow = computed(() => draftHeaderProblems(draft.value, newCheck.value));
// Secrets are bound to an https origin only; an http URL has none to name.
const origin = computed(() => (isHttpsUrl(draft.value.target) ? monitorOrigin(draft.value.target) : undefined));
const runSeconds = computed(() => icmpRunSeconds(Number(draft.value.packets) || 1, Number(draft.value.timeoutSec) || 0));
/** The wording of a multi-packet problem: echoes for ICMP, signed requests for a beacon. */
const BEACON_PROBLEMS: Record<string, string> = { runLength: "runLengthBeacon", packets: "packetsBeacon", budget: "budgetBeacon" };
const showHttpExpect = computed(() => draft.value.type === "http" && m2a.value);

function problemOf(p: string): string {
  const key = isBeacon.value ? (BEACON_PROBLEMS[p] ?? p) : p;
  return t(`fleet.monitoring.checks.editor.problem.${key}`, {
    min: CHECK_MIN_INTERVAL_SEC,
    max: CHECK_MAX_INTERVAL_SEC,
    timeout: CHECK_MAX_TIMEOUT_SEC,
    days: TLS_MAX_THRESHOLD_DAYS,
    after: ALERT_MAX_AFTER,
    packets: PACKETS_MAX,
    run: formatSeconds(runSeconds.value),
    pps: formatPps(budget.value?.pps ?? 0),
    budget: PACKETS_PER_SECOND_MAX,
    source: budget.value?.source ? nameOf(budget.value.source) : "",
  });
}
function formatSeconds(s: number): string {
  return Number.isInteger(s) ? `${s}` : s.toFixed(1);
}
function formatPps(pps: number): string {
  return pps >= 10 ? pps.toFixed(0) : pps.toFixed(2).replace(/\.?0+$/, "");
}
/** Problems shown at the form's end: the ones with no field of their own. */
const FIELD_PROBLEMS = new Set(["interval", "timeout", "timeoutVsInterval", "runLength", "packets", "budget", "threshold", "target", "destination", "targetNode", "expectStatus", "headers", "alertAfter"]);
const problemText = computed(() => problems.value.filter((p) => !FIELD_PROBLEMS.has(p)).map(problemOf));
const missing = computed(() => {
  const out: string[] = [];
  if (nodeMode.value ? !draft.value.targetNode : !draft.value.target.trim()) out.push(nodeMode.value ? t("fleet.monitoring.checks.editor.missing.node") : t("fleet.monitoring.checks.editor.missing.target"));
  if (problems.value.includes("sources")) out.push(t("fleet.monitoring.checks.editor.missing.sources"));
  // An empty header field says so only once it is left; until then this line explains the disabled save.
  const emptyHeader = draft.value.headers.some((h) => (headerProblemsNow.value.rows[h.key] ?? []).some((p) => p === "valueRequired" || (p === "nameLength" && !h.name.trim())));
  if (showHttpExpect.value && emptyHeader) out.push(t("fleet.monitoring.checks.editor.missing.header"));
  return out;
});

const pending = ref(false);
const replaceOpen = ref(false);
const discardOpen = ref(false);
const bodyOptions = computed(() => ({ m2a: m2a.value, nodeName: targetNode.value?.name }));

function statusOf(error: unknown): number | undefined {
  return (error as { status?: number } | null)?.status;
}

async function save(): Promise<void> {
  if (problems.value.length || pending.value) return;
  if (props.monitor && !dirty.value) return;
  if (replaces.value) {
    replaceOpen.value = true;
    return;
  }
  pending.value = true;
  try {
    if (props.monitor) {
      await api.monitors.update(buildUpdate(props.monitor, draft.value, bodyOptions.value));
      toast.success(t("fleet.monitoring.checks.toast.saved"));
      emit("saved", props.monitor.id);
    } else {
      const created = await api.monitors.create(buildCreate(draft.value, props.withAlert, bodyOptions.value));
      toast.success(t("fleet.monitoring.toast.created"));
      emit("saved", created.id);
    }
    emit("close");
  } catch (error) {
    if (statusOf(error) === 409) {
      toast.error(t("fleet.monitoring.checks.toast.conflict"));
      emit("reload");
      emit("close");
    } else {
      saveError.value = error instanceof Error ? error.message : t("fleet.monitoring.checks.toast.failed");
    }
  } finally {
    pending.value = false;
  }
}

/**
 * The method, target or node changed: create the new check, pause on it the
 * sources the operator had paused (the create route starts every check
 * unpaused), then pause the old one. Only a failed create stops the switch;
 * a later step that fails is named in the message, and the sheet goes to the
 * new check.
 */
async function replace(): Promise<void> {
  const old = props.monitor;
  if (!old) return;
  replaceOpen.value = false;
  pending.value = true;
  try {
    let created: MonitorView;
    try {
      created = await api.monitors.create(buildCreate(draft.value, props.withAlert, bodyOptions.value));
    } catch (error) {
      saveError.value = error instanceof Error ? error.message : t("fleet.monitoring.checks.toast.failed");
      return;
    }
    const problems: string[] = [];
    const reasonOf = (error: unknown) => (error instanceof Error ? error.message : "");
    const carry = buildCarryPauses(created, draft.value);
    if (carry) {
      try {
        await api.monitors.update(carry);
      } catch (error) {
        problems.push(t("fleet.monitoring.checks.toast.carryFailed", { reason: reasonOf(error) }));
      }
    }
    try {
      await api.monitors.update(buildPauseOld(old));
    } catch (error) {
      problems.push(t("fleet.monitoring.checks.toast.pauseOldFailed", { name: old.name || old.id, reason: reasonOf(error) }));
    }
    if (problems.length) toast.error(problems.join(" "));
    else toast.success(t("fleet.monitoring.checks.toast.replaced", { name: old.name || old.id }));
    emit("saved", created.id);
    emit("close");
  } finally {
    pending.value = false;
  }
}

function requestClose(): void {
  if (pending.value) return;
  if (dirty.value) {
    discardOpen.value = true;
    return;
  }
  emit("close");
}

function discard(): void {
  discardOpen.value = false;
  emit("close");
}

const title = computed(() => (props.monitor ? t("fleet.monitoring.checks.editor.editTitle", { name: props.monitor.name || props.monitor.id }) : t("fleet.monitoring.checks.editor.createTitle")));
// A fieldset's legend breaks a top border, so sections are set apart by space, not rules.
const SECTION = "grid min-w-0 gap-2.5 border-0 p-0";
const STEP = "text-xs font-medium uppercase tracking-wide text-muted-foreground";
const SEGMENT = "rounded px-2 py-1.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11";
</script>

<template>
  <ObjectSheet :open="open" :title="title" :subtitle="monitor?.id" @close="requestClose">
    <form id="check-editor" class="space-y-6 text-sm" data-testid="check-editor" @submit.prevent="save">
      <!-- 1. What to measure -->
      <fieldset :class="SECTION">
        <legend :class="STEP" class="mb-2.5">{{ $t('fleet.monitoring.checks.editor.step.what') }}</legend>
        <div class="grid gap-1.5" role="radiogroup" :aria-label="$t('fleet.monitoring.checks.editor.step.what')">
          <label
            v-for="kind in kinds"
            :key="kind"
            :class="cn('flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 transition-colors pointer-coarse:min-h-11', draft.type === kind ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/40')"
            :data-kind="kind"
          >
            <input type="radio" name="check-kind" class="mt-1 accent-[var(--primary)]" :value="kind" :checked="draft.type === kind" @change="setKind(kind)" />
            <span>
              <span class="block font-mono text-xs font-medium uppercase">{{ kind }}</span>
              <span class="block text-xs text-muted-foreground">{{ $t(`fleet.monitoring.checks.editor.kind.${kind}`) }}</span>
            </span>
          </label>
        </div>
        <p v-if="!m2b" class="text-xs text-muted-foreground">{{ m2a ? $t('fleet.monitoring.checks.editor.kindLaterBeacon') : $t('fleet.monitoring.checks.editor.kindLater') }}</p>
        <p v-if="replaces" class="rounded-md bg-warning/10 px-2.5 py-2 text-xs text-warning-text" role="status" data-testid="check-replaces">
          {{ $t('fleet.monitoring.checks.editor.replacesNote') }}
        </p>
      </fieldset>

      <!-- 2. From where -->
      <fieldset :class="SECTION">
        <legend :class="STEP" class="mb-2.5">{{ $t('fleet.monitoring.checks.editor.step.from') }}</legend>
        <p v-if="isTls" class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.checks.editor.controlPlane') }}</p>
        <template v-else>
          <div class="grid grid-cols-2 rounded-md border border-input p-1" role="group" :aria-label="$t('fleet.monitoring.checks.editor.step.from')">
            <button
              type="button"
              :class="cn(SEGMENT, draft.assignAll && 'bg-secondary font-medium text-foreground')"
              :aria-pressed="draft.assignAll"
              @click="draft = { ...draft, assignAll: true }"
            >{{ $t('fleet.monitoring.checks.editor.everyNode') }}</button>
            <button
              type="button"
              :class="cn(SEGMENT, !draft.assignAll && 'bg-secondary font-medium text-foreground')"
              :aria-pressed="!draft.assignAll"
              @click="draft = { ...draft, assignAll: false }"
            >{{ $t('fleet.monitoring.checks.editor.chosenNodes') }}</button>
          </div>
          <p v-if="draft.assignAll" class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.checks.editor.everyNodeHint') }}</p>
          <SourcePicker
            v-else-if="canReadNodes"
            v-model="draft.nodeIds"
            v-model:paused="draft.pausedNodeIds"
            :nodes="nodes"
            :show-pause="editing"
            :m2a="m2a"
            :kind="draft.type"
            :current="currentAgent"
            :restorable="monitor?.node_ids ?? []"
            :label="$t('fleet.monitoring.checks.editor.step.from')"
          />
          <p v-else class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.create.nodeIdsManualHint') }}</p>
          <!-- Sources that cannot run the method stay, flagged: their paths read unknown with the reason, never down. -->
          <div v-if="unsupported.length" class="rounded-md bg-warning/10 px-2.5 py-2 text-xs text-warning-text" role="status" data-testid="check-unsupported">
            <p>
              {{
                draft.assignAll
                  ? $t('fleet.monitoring.checks.editor.unsupportedAll', { n: unsupported.length, total: nodes.length, method: unsupportedMethod, names: unsupportedNames })
                  : $t('fleet.monitoring.checks.editor.unsupportedChosen', { n: unsupported.length, method: unsupportedMethod, names: unsupported.map((u) => nameOf(u.id)).join(', ') }, unsupported.length)
              }}
            </p>
            <button v-if="!draft.assignAll" type="button" class="mt-1 font-medium text-foreground underline underline-offset-2 pointer-coarse:min-h-11" @click="removeUnsupported">
              {{ $t('fleet.monitoring.checks.editor.removeUnsupported', unsupported.length) }}
            </button>
          </div>
          <p v-if="editing && !draft.assignAll" class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.checks.editor.pauseHint') }}</p>
        </template>
      </fieldset>

      <!-- 3. To where -->
      <fieldset :class="SECTION">
        <legend :class="STEP" class="mb-2.5">{{ $t('fleet.monitoring.checks.editor.step.to') }}</legend>
        <div v-if="showTargetMode" class="grid grid-cols-2 rounded-md border border-input p-1" role="group" :aria-label="$t('fleet.monitoring.checks.editor.step.to')" data-testid="target-mode">
          <button type="button" :class="cn(SEGMENT, nodeMode && 'bg-secondary font-medium text-foreground')" :aria-pressed="nodeMode" @click="setTargetMode('node')">
            {{ $t('fleet.monitoring.checks.editor.target.node') }}
          </button>
          <button type="button" :class="cn(SEGMENT, !nodeMode && 'bg-secondary font-medium text-foreground')" :aria-pressed="!nodeMode" @click="setTargetMode('address')">
            {{ $t('fleet.monitoring.checks.editor.target.address') }}
          </button>
        </div>
        <template v-if="nodeMode">
          <NodeTargetPicker v-model="draft.targetNode" :nodes="nodes" :kind="draft.type" :plan-nodes="planNodes" :label="$t('fleet.monitoring.checks.editor.step.to')" />
          <p class="text-xs text-muted-foreground">{{ $t(`fleet.monitoring.checks.editor.target.nodeHint.${draft.type}`) }}</p>
          <p v-if="nodeResolution?.state === 'refused'" id="check-target-error" role="alert" class="text-xs text-destructive" data-testid="target-refused">
            {{ $t('fleet.monitoring.checks.editor.target.refused', { name: targetNode?.name || draft.targetNode, reason: resolutionText(draft.type, nodeResolution) }) }}
            <!-- A beacon is enabled on the node's own page, through a plan. -->
            <RouterLink
              v-if="isBeacon && draft.targetNode"
              :to="{ name: 'node-detail', params: { id: draft.targetNode }, hash: '#node-beacon' }"
              class="ms-1 font-medium text-foreground underline underline-offset-2 pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
              data-testid="target-open-beacon"
            >{{ $t('fleet.monitoring.checks.editor.target.openBeacon') }}</RouterLink>
          </p>
          <!-- What every chosen source will dial, before saving. -->
          <ul v-if="sourcePreview.length && nodeResolution && nodeResolution.state !== 'refused'" class="grid gap-1 rounded-md bg-muted/40 p-2.5 text-xs" data-testid="target-preview" :aria-label="$t('fleet.monitoring.checks.editor.target.previewLabel')">
            <li v-for="row in sourcePreview.slice(0, PREVIEW_MAX)" :key="row.id" :class="cn('break-words', (row.why || row.waiting) && 'text-warning-text')">
              <template v-if="row.why">{{ $t('fleet.monitoring.checks.editor.target.previewCannot', { source: row.name, why: refusalText(row.why, draft.type) }) }}</template>
              <template v-else-if="row.waiting">{{ $t('fleet.monitoring.checks.editor.target.previewWaiting', { source: row.name, node: targetNode?.name || draft.targetNode, why: reasonShort(row.waiting) }) }}</template>
              <template v-else-if="nodeResolution.state === 'resolved'">
                {{ $t(`fleet.monitoring.checks.editor.target.preview.${draft.type}`, { source: row.name, node: targetNode?.name || draft.targetNode, endpoint: nodeResolution.endpoint, n: draft.packets }) }}
              </template>
              <template v-else>{{ $t('fleet.monitoring.checks.editor.target.previewOnSave', { source: row.name }) }}</template>
            </li>
            <li v-if="sourcePreview.length > PREVIEW_MAX" class="text-muted-foreground">{{ $t('fleet.monitoring.checks.editor.target.previewMore', { n: sourcePreview.length - PREVIEW_MAX }) }}</li>
          </ul>
        </template>
        <!-- A node target this session cannot list nodes for: shown, not editable. -->
        <p v-else-if="usesNodeTarget(draft) && monitor?.target_node" class="font-mono text-xs break-all" data-testid="target-node-fixed">
          {{ $t('fleet.monitoring.checks.editor.target.nodeFixed', { name: monitor.target_node, endpoint: monitor.target || $t('common.misc.none') }) }}
        </p>
        <template v-else>
          <Label for="check-target" class="sr-only">{{ $t('fleet.monitoring.create.target') }}</Label>
          <Input
            id="check-target"
            v-model="draft.target"
            class="font-mono"
            :aria-invalid="!!targetProblem"
            :aria-describedby="targetProblem ? 'check-target-error' : undefined"
            :placeholder="isTls ? $t('fleet.monitoring.create.targetTlsPlaceholder') : draft.type === 'tcp' ? $t('fleet.monitoring.create.targetTcpPlaceholder') : draft.type === 'icmp' ? $t('fleet.monitoring.create.targetIcmpPlaceholder') : $t('fleet.monitoring.create.targetHttpPlaceholder')"
          />
          <p v-if="targetProblem === 'shape'" id="check-target-error" role="alert" class="text-xs text-destructive">
            {{ isTls ? $t('fleet.monitoring.create.targetTlsError') : draft.type === 'http' ? $t('fleet.monitoring.create.targetHttpError') : draft.type === 'icmp' ? $t('fleet.monitoring.create.targetIcmpError') : $t('fleet.monitoring.create.targetTcpError') }}
            <button v-if="offerHttp" type="button" class="ms-1 font-medium text-foreground underline underline-offset-2" @click="setKind('http')">
              {{ $t('fleet.monitoring.create.switchToHttp') }}
            </button>
          </p>
          <p v-else-if="targetProblem === 'destination' && destination" id="check-target-error" role="alert" class="text-xs text-destructive" data-testid="target-destination">
            {{ destinationText(destination) }}
          </p>
        </template>
      </fieldset>

      <!-- 4. What counts as up -->
      <fieldset :class="SECTION">
        <legend :class="STEP" class="mb-2.5">{{ $t('fleet.monitoring.checks.editor.step.expect') }}</legend>
        <template v-if="isTls">
          <div class="grid max-w-48 gap-1.5">
            <Label for="check-threshold">{{ $t('fleet.monitoring.create.thresholdDays') }}</Label>
            <Input
              id="check-threshold"
              v-model.number="draft.thresholdDays"
              type="number"
              min="1"
              :max="TLS_MAX_THRESHOLD_DAYS"
              :aria-invalid="problems.includes('threshold') || undefined"
              :aria-describedby="problems.includes('threshold') ? 'check-threshold-error' : undefined"
            />
          </div>
          <p class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.create.thresholdHint', { days: draft.thresholdDays }) }}</p>
          <p v-if="problems.includes('threshold')" id="check-threshold-error" role="alert" class="text-xs text-destructive">{{ problemOf('threshold') }}</p>
        </template>
        <template v-else-if="multiPacket(draft.type)">
          <div class="grid max-w-48 gap-1.5">
            <Label for="check-packets">{{ isBeacon ? $t('fleet.monitoring.checks.editor.packetsBeacon') : $t('fleet.monitoring.checks.editor.packets') }}</Label>
            <Input
              id="check-packets"
              v-model.number="draft.packets"
              type="number"
              min="1"
              :max="PACKETS_MAX"
              :aria-invalid="problems.includes('packets') || undefined"
              :aria-describedby="problems.includes('packets') ? 'check-packets-error' : 'check-packets-hint'"
            />
          </div>
          <p id="check-packets-hint" class="text-xs text-muted-foreground">{{ $t(`fleet.monitoring.checks.editor.expect.${draft.type}`) }}</p>
          <p v-if="problems.includes('packets')" id="check-packets-error" role="alert" class="text-xs text-destructive">{{ problemOf('packets') }}</p>
        </template>
        <template v-else-if="showHttpExpect">
          <div class="grid gap-1.5">
            <Label for="check-status">{{ $t('fleet.monitoring.checks.editor.expectStatus.label') }}</Label>
            <Input
              id="check-status"
              v-model="draft.expectStatus"
              class="max-w-72 font-mono"
              :placeholder="EXPECT_STATUS_DEFAULT"
              spellcheck="false"
              :aria-invalid="!statusSet.ok || undefined"
              :aria-describedby="statusSet.ok ? 'check-status-hint' : 'check-status-error'"
            />
          </div>
          <p v-if="statusSet.ok" id="check-status-hint" class="text-xs text-muted-foreground" data-testid="check-status-canonical">
            {{ draft.expectStatus.trim() ? $t('fleet.monitoring.checks.editor.expectStatus.saved', { set: statusSet.canonical }) : $t('fleet.monitoring.checks.editor.expectStatus.default', { set: EXPECT_STATUS_DEFAULT }) }}
            {{ $t('fleet.monitoring.checks.editor.expectStatus.redirects') }}
          </p>
          <p v-else id="check-status-error" role="alert" class="text-xs text-destructive">{{ statusSetText(statusSet.problem) }}</p>
          <HeaderRows v-model="draft.headers" :problems="headerProblemsNow" :origin="origin" :new-check="newCheck && editing" />
          <!-- The server sends such a check only to agents that report their methods (monitorNeedsCurrentAgent); From where marks the others. -->
          <p v-if="olderAgents > 0" class="text-xs text-muted-foreground" data-testid="check-older-agents">{{ $t('fleet.monitoring.checks.editor.expectStatus.olderAgents', { n: olderAgents }, olderAgents) }}</p>
        </template>
        <p v-else class="text-xs text-muted-foreground">{{ $t(`fleet.monitoring.checks.editor.expect.${draft.type}`) }}</p>
      </fieldset>

      <!-- 5. How often -->
      <fieldset :class="SECTION">
        <legend :class="STEP" class="mb-2.5">{{ $t('fleet.monitoring.checks.editor.step.often') }}</legend>
        <div class="grid grid-cols-2 gap-3">
          <div class="grid gap-1.5">
            <Label for="check-interval">{{ $t('fleet.monitoring.checks.editor.interval') }}</Label>
            <Input
              id="check-interval"
              v-model.number="draft.intervalSec"
              type="number"
              :min="CHECK_MIN_INTERVAL_SEC"
              :max="CHECK_MAX_INTERVAL_SEC"
              :aria-invalid="problems.includes('interval') || undefined"
              :aria-describedby="problems.includes('interval') ? 'check-interval-error' : undefined"
            />
          </div>
          <div class="grid gap-1.5">
            <Label for="check-timeout">{{ $t('fleet.monitoring.checks.editor.timeout') }}</Label>
            <Input
              id="check-timeout"
              v-model.number="draft.timeoutSec"
              type="number"
              min="1"
              :max="CHECK_MAX_TIMEOUT_SEC"
              :aria-invalid="problems.includes('timeout') || problems.includes('timeoutVsInterval') || problems.includes('runLength') || undefined"
              :aria-describedby="problems.includes('timeout') || problems.includes('timeoutVsInterval') || problems.includes('runLength') ? 'check-timeout-error' : undefined"
            />
          </div>
        </div>
        <p v-if="multiPacket(draft.type) && !problems.includes('runLength')" class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.checks.editor.runLength', { run: formatSeconds(runSeconds) }) }}</p>
        <p v-if="problems.includes('interval')" id="check-interval-error" role="alert" class="text-xs text-destructive">{{ problemOf('interval') }}</p>
        <p v-if="problems.includes('timeout') || problems.includes('timeoutVsInterval') || problems.includes('runLength')" id="check-timeout-error" role="alert" class="text-xs text-destructive">
          {{ problemOf(problems.includes('timeout') ? 'timeout' : problems.includes('runLength') ? 'runLength' : 'timeoutVsInterval') }}
        </p>
        <p v-if="problems.includes('budget')" role="alert" class="text-xs text-destructive" data-testid="check-budget">{{ problemOf('budget') }}</p>
      </fieldset>

      <!-- 6. When it fails -->
      <fieldset v-if="withAlert" :class="SECTION">
        <legend :class="STEP" class="mb-2.5">{{ $t('fleet.monitoring.checks.editor.step.fail') }}</legend>
        <label class="flex cursor-pointer items-center gap-2.5 pointer-coarse:min-h-11">
          <input type="radio" name="check-alert" class="accent-[var(--primary)]" :checked="draft.alert === 'off'" @change="draft = { ...draft, alert: 'off' }" />
          <span>{{ $t('fleet.monitoring.checks.editor.alertOff') }}</span>
        </label>
        <div class="flex flex-wrap items-center gap-2.5">
          <label class="flex cursor-pointer items-center gap-2.5 pointer-coarse:min-h-11">
            <input type="radio" name="check-alert" class="accent-[var(--primary)]" :checked="draft.alert === 'down'" @change="draft = { ...draft, alert: 'down' }" />
            <span>{{ $t('fleet.monitoring.checks.editor.alertDown') }}</span>
          </label>
          <Input
            v-model.number="draft.alertAfter"
            type="number"
            min="1"
            :max="ALERT_MAX_AFTER"
            class="h-8 w-20"
            :disabled="draft.alert !== 'down'"
            :aria-label="$t('fleet.monitoring.checks.editor.alertAfter')"
            :aria-invalid="problems.includes('alertAfter') || undefined"
            :aria-describedby="problems.includes('alertAfter') ? 'check-alert-error' : undefined"
          />
          <span class="text-muted-foreground">{{ $t('fleet.monitoring.checks.editor.alertRuns') }}</span>
        </div>
        <p v-if="problems.includes('alertAfter')" id="check-alert-error" role="alert" class="text-xs text-destructive">{{ problemOf('alertAfter') }}</p>
      </fieldset>

      <!-- 7. Name -->
      <fieldset :class="SECTION">
        <legend :class="STEP" class="mb-2.5">{{ $t('fleet.monitoring.checks.editor.step.name') }}</legend>
        <Label for="check-name" class="sr-only">{{ $t('fleet.monitoring.create.name') }}</Label>
        <Input id="check-name" v-model="draft.name" :placeholder="suggested || $t('fleet.monitoring.create.namePlaceholder')" />
        <p class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.checks.editor.nameHint') }}</p>
      </fieldset>

      <p v-for="text in problemText" :key="text" role="alert" class="text-xs text-destructive">{{ text }}</p>
    </form>
    <template #actions>
      <p v-if="saveError" role="alert" class="basis-full text-xs text-destructive" data-testid="check-save-error">{{ $t('fleet.monitoring.checks.editor.refused', { reason: saveError }) }}</p>
      <p v-if="missing.length" class="me-auto text-xs text-muted-foreground" data-testid="check-missing">
        {{ $t('fleet.monitoring.create.missing', { fields: missing.join($t('fleet.monitoring.create.missingJoin')) }) }}
      </p>
      <p v-else-if="editing && !dirty" class="me-auto text-xs text-muted-foreground">{{ $t('fleet.monitoring.checks.editor.unchanged') }}</p>
      <Button variant="outline" size="sm" type="button" @click="requestClose">{{ $t('common.actions.cancel') }}</Button>
      <Button type="submit" form="check-editor" size="sm" :disabled="pending || problems.length > 0 || (editing && !dirty)" data-testid="check-save">
        <RefreshCw v-if="pending" class="size-4 animate-spin" aria-hidden="true" />
        <Save v-else-if="editing" class="size-4" aria-hidden="true" />
        <Plus v-else class="size-4" aria-hidden="true" />
        {{ replaces ? $t('fleet.monitoring.checks.editor.saveReplace') : editing ? $t('fleet.monitoring.checks.editor.save') : $t('fleet.monitoring.checks.editor.create') }}
      </Button>
    </template>
  </ObjectSheet>

  <ConfirmDialog
    v-model:open="replaceOpen"
    :title="$t('fleet.monitoring.checks.editor.replace.title')"
    :description="$t('fleet.monitoring.checks.editor.replace.description', { name: monitor?.name || monitor?.id || '' })"
    :impact="[$t('fleet.monitoring.checks.editor.replace.impactNew'), $t('fleet.monitoring.checks.editor.replace.impactOld')]"
    :impact-title="$t('fleet.monitoring.checks.editor.replace.impactTitle')"
    variant="default"
    :confirm-label="$t('fleet.monitoring.checks.editor.replace.confirm')"
    :cancel-label="$t('fleet.monitoring.checks.editor.replace.keep')"
    :pending="pending"
    @confirm="replace"
  />
  <ConfirmDialog
    v-model:open="discardOpen"
    :title="$t('fleet.monitoring.checks.editor.discard.title')"
    :description="$t('fleet.monitoring.checks.editor.discard.description')"
    :confirm-label="$t('fleet.monitoring.checks.editor.discard.confirm')"
    :cancel-label="$t('fleet.monitoring.checks.editor.discard.keep')"
    @confirm="discard"
  />
</template>
