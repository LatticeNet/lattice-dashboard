<script setup lang="ts">
/**
 * The one "New check" flow (design 32 D1): a method, a source set and a
 * target set chosen with the target selector (D5), expectations by method,
 * a schedule and alerting. Under the targets, one line says what a save
 * would measure, computed by the server from the same body (the dry run), so
 * "36 paths, 2 targets serve nothing TCP can dial, 1 pair over the packet
 * budget" is exactly what the save produces; the list behind it is one click
 * away. The same sheet edits a definition.
 */
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Plus, RefreshCw, Save } from "lucide-vue-next";

import { api, type CheckDefinitionPreview, type CheckDefinitionView, type CheckMethod, type GroupView, type MonitorType, type Node } from "@/lib/api";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import ObjectSheet from "@/components/common/ObjectSheet.vue";
import SaveRefusal from "@/components/common/SaveRefusal.vue";
import { useSaveRefusal } from "@/composables/useSaveRefusal";
import SelectorPicker from "@/components/selector/SelectorPicker.vue";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import DegradedRuleFields from "./DegradedRuleFields.vue";
import HeaderRows from "./HeaderRows.vue";
import { EXPECT_STATUS_DEFAULT, isHttpsUrl, monitorOrigin, sourceSupport } from "./checkRulesModel";
import { ALERT_MAX_AFTER, CHECK_MAX_INTERVAL_SEC, CHECK_MAX_TIMEOUT_SEC, CHECK_MIN_INTERVAL_SEC, PACKETS_MAX, icmpRunSeconds, multiPacket } from "./checksModel";
import { headerProblems } from "./checkHeadersModel";
import {
  DEFINITION_KINDS,
  addressesOf,
  applyDefinitionFix,
  buildDefinitionSave,
  definitionDirty,
  definitionProblems,
  draftFromDefinition,
  emptyDefinitionDraft,
  missingParts,
  DEFINITION_ADDRESSES_MAX,
  DEFINITION_NAME_MAX,
  selectorIsBroad,
  suggestDefinitionName,
  summarizePreview,
  takesAddresses,
  takesSources,
  takesTargetNodes,
  withKind,
  type DefinitionDraft,
  type DefinitionFix,
  type DefinitionProblem,
} from "./definitionsModel";
import { TLS_MAX_THRESHOLD_DAYS } from "./monitorTypeModel";
import { usePathsCopy } from "./pathsCopy";

const props = defineProps<{
  open: boolean;
  /** The definition being edited; a create when absent. */
  definition?: CheckDefinitionView;
  /** A change the check sheet asked for (design 32 R2): the edit opens with it made, for the operator to review and save. */
  fix?: DefinitionFix;
  initialType?: MonitorType;
  nodes: Node[];
  groups: GroupView[];
  /** Groups and the whole fleet may be chosen: the session has no node allowlist. */
  allowBroad: boolean;
  /** The server judges degraded (design 29 D13). */
  m3?: boolean;
}>();

const emit = defineEmits<{ close: []; saved: [definition: CheckDefinitionView]; reload: [] }>();

const { t } = useI18n();
const { reasonShort, reasonText, methodName, refusalText } = usePathsCopy();

const draft = ref<DefinitionDraft>(emptyDefinitionDraft());
/**
 * The stored version the draft edits: the definition opened, or the newer
 * one the operator took or saved over after a conflict (design 32 R6).
 */
const base = shallowRef<CheckDefinitionView>();
const formEl = ref<HTMLFormElement>();
/** The request fields a conflict compares, in the order it names them. */
const COMPARED = ["name", "type", "sources", "targets", "addresses", "excluded_pairs", "packets", "threshold_days", "expect_status", "headers", "interval_sec", "timeout_sec", "alert", "alert_after", "degraded", "enabled"] as const;
const refusals = useSaveRefusal<CheckDefinitionView>({ root: formEl, compared: COMPARED, draft });
// The dry run's state, declared before the watcher that resets it on open (it runs immediately).
const preview = ref<CheckDefinitionPreview>();
const previewError = ref<string>();
const previewPending = ref(false);
const showDetail = ref(false);
let previewTimer: ReturnType<typeof setTimeout> | undefined;
let previewAbort: AbortController | undefined;

function copyDraft(d: DefinitionDraft): DefinitionDraft {
  return { ...d, sources: { ...d.sources }, targets: { ...d.targets }, headers: d.headers.map((h) => ({ ...h })), degraded: { ...d.degraded }, excludedPairs: d.excludedPairs.map((p) => ({ ...p })) };
}

watch(
  () => props.open,
  (open) => {
    refusals.clear();
    preview.value = undefined;
    previewError.value = undefined;
    showDetail.value = false;
    if (!open) {
      // A typed secret leaves with the sheet.
      draft.value = { ...draft.value, headers: draft.value.headers.map((h) => (h.secret ? { ...h, value: "" } : h)) };
      return;
    }
    base.value = props.definition;
    const opened = props.definition ? draftFromDefinition(props.definition) : emptyDefinitionDraft(props.initialType ?? "tcp");
    draft.value = copyDraft(props.definition && props.fix ? applyDefinitionFix(opened, props.fix) : opened);
  },
  { immediate: true },
);

const editing = computed(() => !!base.value);
/** A tls check runs on the control plane, which a session with a node allowlist cannot target. */
const kinds = computed(() => (props.allowBroad || props.definition?.type === "tls" ? DEFINITION_KINDS : DEFINITION_KINDS.filter((k) => k !== "tls")));
const isTls = computed(() => draft.value.type === "tls");
const nodeTargets = computed(() => takesTargetNodes(draft.value.type));
const addressTargets = computed(() => takesAddresses(draft.value.type));
/** tcp and icmp take nodes first; their addresses are an extra the operator opens. */
const addressesOptional = computed(() => nodeTargets.value && addressTargets.value);
const showAddresses = ref(false);
watch(
  () => [props.open, draft.value.type] as const,
  () => (showAddresses.value = addressesOptional.value && draft.value.addressText.trim() !== ""),
  { immediate: true },
);

/** Auto's icmp and beacon pairs send the definition's packets (design 32 R1). */
const sendsPackets = computed(() => multiPacket(draft.value.type) || draft.value.type === "auto");

function setKind(kind: CheckMethod): void {
  draft.value = withKind(draft.value, kind);
}

function nodeName(id: string): string {
  return props.nodes.find((n) => n.id === id)?.name || id;
}
function groupName(id: string): string {
  return props.groups.find((g) => g.id === id)?.name || id;
}

const suggested = computed(() => suggestDefinitionName(draft.value, nodeName, groupName, t("selector.wholeFleetInline")));
const problems = computed<DefinitionProblem[]>(() => definitionProblems(draft.value, { newDefinition: !editing.value, m3: props.m3 }));
const missing = computed(() => missingParts(problems.value));
const dirty = computed(() => (base.value ? definitionDirty(base.value, draft.value, suggested.value) : true));

/** The sources that cannot run the method, flagged on the From list (their pairs read unknown with that reason). */
const sourceNotes = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {};
  if (!takesSources(draft.value.type)) return out;
  for (const node of props.nodes) {
    // Auto falls back to tcp, which every agent runs: no source is flagged for it.
    const support = sourceSupport(node, draft.value.type === "auto" ? "tcp" : draft.value.type, true, false);
    if (!support.ok && support.reason) out[node.id] = refusalText(support.reason, draft.value.type);
  }
  return out;
});

const addresses = computed(() => (addressTargets.value ? addressesOf(draft.value.addressText) : []));
const origin = computed(() => {
  const first = addresses.value[0];
  return first && isHttpsUrl(first) ? monitorOrigin(first) : undefined;
});
const headerProblemsNow = computed(() => headerProblems(draft.value.headers, { https: addresses.value.length > 0 && addresses.value.every(isHttpsUrl), newCheck: !editing.value }));

/* ---- The dry run ---- */


/** The dry run asks only once there is something to measure and nothing the server would refuse for a local reason. */
const previewable = computed(() => props.open && missing.value.length === 0 && problems.value.every((p) => p === "name"));

function body() {
  return buildDefinitionSave(draft.value, base.value, suggested.value);
}

watch(
  () => [previewable.value, JSON.stringify(previewable.value ? body() : null)] as const,
  ([ready]) => {
    if (previewTimer) clearTimeout(previewTimer);
    // The aborted request must not settle `previewPending`: its finally sees no controller of its own.
    previewAbort?.abort();
    previewAbort = undefined;
    previewError.value = undefined;
    if (!ready) {
      preview.value = undefined;
      previewPending.value = false;
      return;
    }
    previewPending.value = true;
    previewTimer = setTimeout(runPreview, 350);
  },
  { immediate: true },
);

async function runPreview(): Promise<void> {
  const controller = new AbortController();
  previewAbort = controller;
  try {
    const answer = await api.monitors.definitions.preview(body(), { signal: controller.signal });
    if (controller.signal.aborted) return;
    preview.value = answer;
    previewError.value = undefined;
  } catch (error) {
    if (controller.signal.aborted) return;
    preview.value = undefined;
    previewError.value = error instanceof Error ? error.message : t("fleet.monitoring.checkDefs.preview.failed");
  } finally {
    if (previewAbort === controller) previewPending.value = false;
  }
}

onBeforeUnmount(() => {
  if (previewTimer) clearTimeout(previewTimer);
  previewAbort?.abort();
});

const summary = computed(() => (preview.value ? summarizePreview(preview.value) : undefined));
/** The dry run's headline: every path, or how many of them will measure (design review: "9 paths" hid that 3 would). */
const headline = computed(() => {
  const s = summary.value;
  if (!s) return "";
  return s.measured === s.paths
    ? t("fleet.monitoring.checkDefs.preview.paths", { n: s.paths }, s.paths)
    : t("fleet.monitoring.checkDefs.preview.measures", { n: s.measured, total: s.paths }, s.paths);
});

/** The proof line's segments after the path count: dead targets, then pairs by reason. */
const segments = computed(() => {
  const s = summary.value;
  if (!s) return [];
  const method = methodName(draft.value.type);
  const out: { key: string; text: string; tone: "muted" | "warning" }[] = [];
  for (const target of s.targets) {
    const text =
      target.reason === "not_probeable"
        ? t("fleet.monitoring.checkDefs.preview.notDialable", { n: target.count, method }, target.count)
        : t("fleet.monitoring.checkDefs.preview.targetsReason", { n: target.count, reason: reasonShort(target.reason) }, target.count);
    out.push({ key: `t:${target.reason}`, text, tone: "warning" });
  }
  for (const pair of s.pairs) {
    const text =
      pair.reason === "packet_budget"
        ? t("fleet.monitoring.checkDefs.preview.overBudget", { n: pair.count }, pair.count)
        : t("fleet.monitoring.checkDefs.preview.pairsReason", { n: pair.count, reason: reasonShort(pair.reason) }, pair.count);
    out.push({ key: `p:${pair.reason}`, text, tone: pair.reason === "agent_offline" || pair.reason === "source_paused" ? "muted" : "warning" });
  }
  return out;
});

/**
 * The detail behind the line, by reason: each reason's sentence once, then
 * the targets it covers, then the source-to-target pairs that would read
 * unknown for it. A pair to a target that cannot be dialled is that
 * target's line, not a pair of its own.
 */
const detailGroups = computed(() => {
  const p = preview.value;
  if (!p) return [];
  const label = (t: { target_node?: string; target: string; monitor_id: string }) => (t.target_node ? nodeName(t.target_node) : t.target || t.monitor_id);
  const byMonitor = new Map(p.targets.map((x) => [x.monitor_id, x]));
  const groups = new Map<string, { key: string; why: string; items: { key: string; text: string }[] }>();
  const add = (key: string, why: string, item: { key: string; text: string }) => {
    const group = groups.get(key) ?? { key, why, items: [] };
    group.items.push(item);
    groups.set(key, group);
  };
  for (const target of p.targets.filter((x) => x.reason)) {
    const code = target.note || target.reason!;
    add(`t:${code}`, reasonText(code), { key: `t:${target.monitor_id || target.target_node}`, text: label(target) });
  }
  const dead = new Set(p.targets.filter((x) => x.reason).map((x) => x.monitor_id));
  for (const pair of p.pairs.filter((x) => x.reason && !dead.has(x.monitor_id))) {
    const target = byMonitor.get(pair.monitor_id);
    add(`p:${pair.reason}`, reasonText(pair.reason), {
      key: `p:${pair.source}:${pair.monitor_id}`,
      text: t("fleet.monitoring.checkDefs.preview.detailPair", {
        source: pair.source ? nodeName(pair.source) : t("fleet.monitoring.result.controlPlane"),
        target: target ? label(target) : pair.monitor_id,
      }),
    });
  }
  return [...groups.values()];
});

const DETAIL_MAX = 40;

/** What the save changes beyond its paths: paused targets, other definitions the shared budget touches. */
const writesNote = computed(() => {
  const s = summary.value;
  const p = preview.value;
  if (!s || !p) return [];
  const out: string[] = [];
  if (s.paused) out.push(t("fleet.monitoring.checkDefs.preview.pauses", { n: s.paused }, s.paused));
  if (s.deleted) out.push(t("fleet.monitoring.checkDefs.preview.deletes", { n: s.deleted }, s.deleted));
  if (p.also_changes?.length) out.push(t("fleet.monitoring.checkDefs.preview.alsoChanges", { n: p.also_changes.length }, p.also_changes.length));
  return out;
});

/* ---- Problems and saving ---- */

function problemOf(p: DefinitionProblem): string {
  switch (p) {
    case "address":
      return t("fleet.monitoring.checkDefs.problem.address", { method: methodName(draft.value.type) });
    case "destination":
      return t("fleet.monitoring.checkDefs.problem.destination");
    case "tooManyAddresses":
      return t("fleet.monitoring.checkDefs.problem.tooManyAddresses", { max: DEFINITION_ADDRESSES_MAX });
    case "secretSources":
      return t("fleet.monitoring.checkDefs.problem.secretSources");
    case "name":
      return t("fleet.monitoring.checkDefs.problem.name", { max: DEFINITION_NAME_MAX });
    case "headers":
      return t("fleet.monitoring.checkDefs.problem.headers");
    case "expectStatus":
      return t("fleet.monitoring.checkDefs.problem.expectStatus");
    case "degraded":
      return t("fleet.monitoring.checkDefs.problem.degraded");
    case "sources":
    case "target":
      return "";
    default:
      return t(`fleet.monitoring.checks.editor.problem.${p}`, {
        min: CHECK_MIN_INTERVAL_SEC,
        max: CHECK_MAX_INTERVAL_SEC,
        timeout: CHECK_MAX_TIMEOUT_SEC,
        days: TLS_MAX_THRESHOLD_DAYS,
        after: ALERT_MAX_AFTER,
        packets: PACKETS_MAX,
        run: runSeconds.value.toFixed(1).replace(/\.0$/, ""),
      });
  }
}
const runSeconds = computed(() => icmpRunSeconds(Number(draft.value.packets), Number(draft.value.timeoutSec)));
/** Problems shown at the form's end: the ones no field states. */
const UNFIELDED = new Set<DefinitionProblem>(["name", "alertTls", "degraded"]);

const pending = ref(false);
const discardOpen = ref(false);

async function save(): Promise<void> {
  if (problems.value.length || pending.value) return;
  if (editing.value && !dirty.value) return;
  pending.value = true;
  const opened = base.value;
  try {
    const saved = opened ? await api.monitors.definitions.update(body()) : await api.monitors.definitions.create(body());
    refusals.clear();
    toast.success(opened ? t("fleet.monitoring.checkDefs.toast.saved", { name: saved.name }) : t("fleet.monitoring.checkDefs.toast.created", { name: saved.name, n: saved.summary.paths }, saved.summary.paths));
    emit("saved", saved);
    emit("close");
  } catch (error) {
    // The sheet stays open with the draft: a refusal marks its field, and a
    // conflict names what changed and lets the operator choose (R6).
    const outcome = await refusals.handle(error, {
      fallback: t("fleet.monitoring.checkDefs.toast.failed"),
      base: opened,
      reread: () => (opened ? api.monitors.definitions.get(opened.id) : Promise.reject(error)),
    });
    if (outcome === "conflict") emit("reload");
  } finally {
    pending.value = false;
  }
}

/** Conflict: start again from the server's version, dropping the draft. */
function reloadTheirs(): void {
  const latest = refusals.conflict.value?.latest;
  if (!latest) return;
  refusals.clear();
  base.value = latest;
  draft.value = copyDraft(draftFromDefinition(latest));
}

/** Conflict: save the draft over the server's version, naming its version. */
async function saveOverTheirs(): Promise<void> {
  const latest = refusals.conflict.value?.latest;
  if (!latest) return;
  base.value = latest;
  refusals.clear();
  if (!dirty.value) {
    // The draft already reads as theirs: nothing is left to write.
    emit("close");
    return;
  }
  await save();
}

/** Field labels the footer names a refusal's field and a conflict's changes by. */
const fieldLabels = computed<Record<string, string>>(() => ({
  name: t("fleet.monitoring.create.name"),
  type: t("fleet.monitoring.checks.editor.step.what"),
  sources: t("fleet.monitoring.checkDefs.editor.from"),
  targets: t("fleet.monitoring.checkDefs.editor.to"),
  addresses: t("fleet.monitoring.checkDefs.editor.addresses"),
  excluded_pairs: t("fleet.monitoring.checkDefs.editor.excludedPairs"),
  packets: t("fleet.monitoring.checks.editor.packets"),
  threshold_days: t("fleet.monitoring.create.thresholdDays"),
  expect_status: t("fleet.monitoring.checks.editor.expectStatus.label"),
  headers: t("fleet.monitoring.checkDefs.editor.headers"),
  interval_sec: t("fleet.monitoring.checks.editor.interval"),
  timeout_sec: t("fleet.monitoring.checks.editor.timeout"),
  alert: t("fleet.monitoring.checks.editor.step.fail"),
  alert_after: t("fleet.monitoring.checks.editor.alertAfter"),
  degraded: t("fleet.monitoring.checkDefs.editor.degraded"),
  enabled: t("fleet.monitoring.checkDefs.editor.enabled"),
}));

function requestClose(): void {
  if (pending.value) return;
  const touched = props.definition ? dirty.value : JSON.stringify(draft.value) !== JSON.stringify(emptyDefinitionDraft(props.initialType ?? "tcp"));
  if (touched) {
    discardOpen.value = true;
    return;
  }
  emit("close");
}

function discard(): void {
  discardOpen.value = false;
  emit("close");
}

const title = computed(() => (props.definition ? t("fleet.monitoring.checkDefs.editor.editTitle", { name: props.definition.name }) : t("fleet.monitoring.checkDefs.editor.createTitle")));
const secretWithBroad = computed(() => draft.value.headers.some((h) => h.secret) && selectorIsBroad(draft.value.sources));

// A fieldset's legend breaks a top border, so sections are set apart by space, not rules.
const SECTION = "grid min-w-0 gap-2.5 border-0 p-0";
const STEP = "text-xs font-medium uppercase tracking-wide text-muted-foreground";
</script>

<template>
  <ObjectSheet :open="open" :title="title" :subtitle="definition?.id" @close="requestClose">
    <form id="definition-editor" ref="formEl" class="space-y-6 text-sm" data-testid="definition-editor" @submit.prevent="save">
      <!-- 1. What to measure -->
      <fieldset :class="SECTION">
        <legend :class="STEP" class="mb-2.5">{{ $t('fleet.monitoring.checks.editor.step.what') }}</legend>
        <!-- The single-check editor's method cards, so both editors read alike. -->
        <div class="grid gap-1.5" role="radiogroup" :aria-label="$t('fleet.monitoring.checks.editor.step.what')" data-field="type">
          <label
            v-for="kind in kinds"
            :key="kind"
            :class="cn('flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 transition-colors pointer-coarse:min-h-11', draft.type === kind ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/40')"
            :data-kind="kind"
          >
            <input type="radio" name="definition-kind" class="mt-1 accent-[var(--primary)]" :value="kind" :checked="draft.type === kind" @change="setKind(kind)" />
            <span>
              <span class="block font-mono text-xs font-medium uppercase">{{ kind }}</span>
              <span class="block text-xs text-muted-foreground">{{ $t(`fleet.monitoring.checks.editor.kind.${kind}`) }}</span>
            </span>
          </label>
        </div>
        <p v-if="editing && definition && draft.type !== definition.type" class="rounded-md bg-warning/10 px-2.5 py-2 text-xs text-warning-text" role="status">
          {{ $t('fleet.monitoring.checkDefs.editor.methodChange') }}
        </p>
      </fieldset>

      <!-- 2. From -->
      <fieldset :class="SECTION">
        <legend :class="STEP" class="mb-2.5">{{ $t('fleet.monitoring.checkDefs.editor.from') }}</legend>
        <p v-if="isTls" class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.checks.editor.controlPlane') }}</p>
        <div v-else data-testid="definition-sources" data-field="sources">
          <SelectorPicker
            v-model="draft.sources"
            :nodes="nodes"
            :groups="groups"
            :allow-groups="allowBroad"
            :allow-fleet="allowBroad"
            :restricted-reason="allowBroad ? '' : $t('fleet.monitoring.checkDefs.editor.nodesOnly')"
            :notes="sourceNotes"
            :label="$t('fleet.monitoring.checkDefs.editor.from')"
            id-prefix="definition-sources"
          />
        </div>
        <p v-if="secretWithBroad" role="alert" class="text-xs text-destructive">{{ problemOf('secretSources') }}</p>
      </fieldset>

      <!-- 3. To -->
      <fieldset :class="SECTION">
        <legend :class="STEP" class="mb-2.5">{{ $t('fleet.monitoring.checkDefs.editor.to') }}</legend>
        <div v-if="nodeTargets" data-testid="definition-targets" data-field="targets">
          <SelectorPicker
            v-model="draft.targets"
            :nodes="nodes"
            :groups="groups"
            :allow-groups="allowBroad"
            :allow-fleet="allowBroad"
            :restricted-reason="allowBroad ? '' : $t('fleet.monitoring.checkDefs.editor.nodesOnly')"
            :label="$t('fleet.monitoring.checkDefs.editor.to')"
            id-prefix="definition-targets"
          />
        </div>
        <button
          v-if="addressesOptional && !showAddresses"
          type="button"
          class="justify-self-start text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground pointer-coarse:min-h-11"
          @click="showAddresses = true"
        >{{ $t('fleet.monitoring.checkDefs.editor.addAddresses', { method: methodName(draft.type) }) }}</button>
        <div v-if="addressTargets && (!addressesOptional || showAddresses)" class="grid gap-1.5" data-field="addresses">
          <Label for="definition-addresses">{{ addressesOptional ? $t('fleet.monitoring.checkDefs.editor.addressesExtra') : $t('fleet.monitoring.checkDefs.editor.addresses') }}</Label>
          <Textarea
            id="definition-addresses"
            v-model="draft.addressText"
            rows="3"
            class="font-mono text-xs"
            spellcheck="false"
            :placeholder="$t(`fleet.monitoring.checkDefs.editor.addressPlaceholder.${draft.type}`)"
            :aria-invalid="problems.includes('address') || problems.includes('destination') || undefined"
            :aria-describedby="problems.includes('address') || problems.includes('destination') ? 'definition-addresses-error' : 'definition-addresses-hint'"
          />
          <p v-if="problems.includes('address') || problems.includes('destination') || problems.includes('tooManyAddresses')" id="definition-addresses-error" role="alert" class="text-xs text-destructive">
            {{ problemOf(problems.includes('address') ? 'address' : problems.includes('destination') ? 'destination' : 'tooManyAddresses') }}
          </p>
          <p v-else id="definition-addresses-hint" class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.checkDefs.editor.addressesHint', { n: addresses.length }, addresses.length) }}</p>
        </div>

        <!-- What a save would measure, from the server's own dry run. -->
        <section class="rounded-md border border-border bg-muted/30 px-3 py-2.5" data-testid="definition-preview" :aria-label="$t('fleet.monitoring.checkDefs.preview.label')">
          <p v-if="missing.length" class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.checkDefs.preview.waiting') }}</p>
          <p v-else-if="previewError" class="text-xs text-destructive" role="alert" data-testid="definition-preview-refused">{{ $t('fleet.monitoring.checkDefs.preview.refused', { reason: previewError }) }}</p>
          <template v-else-if="summary">
            <p :class="cn('flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-sm', previewPending && 'opacity-60')" aria-live="polite" data-testid="definition-preview-line">
              <span :class="cn('font-medium tabular', summary.paths > 0 && summary.measured === 0 && 'text-warning-text')">{{ headline }}</span>
              <template v-for="segment in segments" :key="segment.key">
                <span class="text-muted-foreground" aria-hidden="true">·</span>
                <span :class="segment.tone === 'warning' ? 'text-warning-text' : 'text-muted-foreground'">{{ segment.text }}</span>
              </template>
              <button
                v-if="detailGroups.length"
                type="button"
                class="ms-1 text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground pointer-coarse:min-h-11"
                :aria-expanded="showDetail"
                aria-controls="definition-preview-detail"
                @click="showDetail = !showDetail"
              >{{ showDetail ? $t('fleet.monitoring.checkDefs.preview.hide') : $t('fleet.monitoring.checkDefs.preview.show') }}</button>
            </p>
            <p v-if="writesNote.length" class="mt-1 text-xs text-muted-foreground">{{ writesNote.join(' · ') }}</p>
            <div v-if="showDetail && detailGroups.length" id="definition-preview-detail" class="mt-2 grid gap-2.5 border-t border-border pt-2 text-xs" data-testid="definition-preview-detail">
              <section v-for="group in detailGroups" :key="group.key" class="grid gap-1">
                <p class="text-muted-foreground">{{ group.why }}</p>
                <ul class="grid gap-0.5 ps-3">
                  <li v-for="item in group.items.slice(0, DETAIL_MAX)" :key="item.key" class="break-words">{{ item.text }}</li>
                  <li v-if="group.items.length > DETAIL_MAX" class="text-muted-foreground">{{ $t('fleet.monitoring.checkDefs.preview.more', { n: group.items.length - DETAIL_MAX }) }}</li>
                </ul>
              </section>
            </div>
          </template>
          <p v-else class="flex items-center gap-1.5 text-xs text-muted-foreground">
            <RefreshCw class="size-3 animate-spin" aria-hidden="true" />
            {{ $t('fleet.monitoring.checkDefs.preview.checking') }}
          </p>
        </section>
      </fieldset>

      <!-- 4. What counts as up -->
      <fieldset :class="SECTION">
        <legend :class="STEP" class="mb-2.5">{{ $t('fleet.monitoring.checks.editor.step.expect') }}</legend>
        <template v-if="isTls">
          <div class="grid max-w-48 gap-1.5" data-field="threshold_days">
            <Label for="definition-threshold">{{ $t('fleet.monitoring.create.thresholdDays') }}</Label>
            <Input id="definition-threshold" v-model.number="draft.thresholdDays" type="number" min="1" :max="TLS_MAX_THRESHOLD_DAYS" :aria-invalid="problems.includes('threshold') || undefined" />
          </div>
          <p class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.create.thresholdHint', { days: draft.thresholdDays }) }}</p>
          <p v-if="problems.includes('threshold')" role="alert" class="text-xs text-destructive">{{ problemOf('threshold') }}</p>
        </template>
        <template v-else-if="sendsPackets">
          <div class="grid max-w-48 gap-1.5" data-field="packets">
            <Label for="definition-packets">{{ draft.type === 'beacon' ? $t('fleet.monitoring.checks.editor.packetsBeacon') : $t('fleet.monitoring.checks.editor.packets') }}</Label>
            <Input id="definition-packets" v-model.number="draft.packets" type="number" min="1" :max="PACKETS_MAX" :aria-invalid="problems.includes('packets') || undefined" />
          </div>
          <p class="text-xs text-muted-foreground">{{ $t(`fleet.monitoring.checks.editor.expect.${draft.type}`) }}</p>
          <p v-if="problems.includes('packets')" role="alert" class="text-xs text-destructive">{{ problemOf('packets') }}</p>
        </template>
        <template v-else-if="draft.type === 'http'">
          <div class="grid gap-1.5" data-field="expect_status">
            <Label for="definition-status">{{ $t('fleet.monitoring.checks.editor.expectStatus.label') }}</Label>
            <Input id="definition-status" v-model="draft.expectStatus" class="max-w-72 font-mono" :placeholder="EXPECT_STATUS_DEFAULT" spellcheck="false" :aria-invalid="problems.includes('expectStatus') || undefined" />
          </div>
          <p v-if="problems.includes('expectStatus')" role="alert" class="text-xs text-destructive">{{ problemOf('expectStatus') }}</p>
          <p v-else class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.checks.editor.expectStatus.default', { set: EXPECT_STATUS_DEFAULT }) }} {{ $t('fleet.monitoring.checks.editor.expectStatus.redirects') }}</p>
          <div data-field="headers"><HeaderRows v-model="draft.headers" :problems="headerProblemsNow" :origin="origin" :new-check="!editing" /></div>
          <p v-if="draft.headers.some((h) => h.secret)" class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.checkDefs.editor.secretsNodes') }}</p>
        </template>
        <p v-else class="text-xs text-muted-foreground">{{ $t(`fleet.monitoring.checks.editor.expect.${draft.type}`) }}</p>
      </fieldset>

      <!-- 5. How often -->
      <fieldset :class="SECTION">
        <legend :class="STEP" class="mb-2.5">{{ $t('fleet.monitoring.checks.editor.step.often') }}</legend>
        <div class="grid grid-cols-2 gap-3">
          <div class="grid gap-1.5" data-field="interval_sec">
            <Label for="definition-interval">{{ $t('fleet.monitoring.checks.editor.interval') }}</Label>
            <Input id="definition-interval" v-model.number="draft.intervalSec" type="number" :min="CHECK_MIN_INTERVAL_SEC" :max="CHECK_MAX_INTERVAL_SEC" :aria-invalid="problems.includes('interval') || undefined" />
          </div>
          <div class="grid gap-1.5" data-field="timeout_sec">
            <Label for="definition-timeout">{{ $t('fleet.monitoring.checks.editor.timeout') }}</Label>
            <Input id="definition-timeout" v-model.number="draft.timeoutSec" type="number" min="1" :max="CHECK_MAX_TIMEOUT_SEC" :aria-invalid="problems.includes('timeout') || problems.includes('timeoutVsInterval') || problems.includes('runLength') || undefined" />
          </div>
        </div>
        <p v-for="p in (['interval', 'timeout', 'timeoutVsInterval', 'runLength'] as const).filter((x) => problems.includes(x))" :key="p" role="alert" class="text-xs text-destructive">{{ problemOf(p) }}</p>
        <p v-if="sendsPackets" class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.checkDefs.editor.budgetNote') }}</p>
      </fieldset>

      <!-- 6. On failure -->
      <fieldset :class="SECTION" data-testid="definition-alert" data-field="alert">
        <legend :class="STEP" class="mb-2.5">{{ $t('fleet.monitoring.checks.editor.step.fail') }}</legend>
        <label class="flex cursor-pointer items-center gap-2.5 pointer-coarse:min-h-11">
          <input type="radio" name="definition-alert" class="accent-[var(--primary)]" value="off" :checked="draft.alert === 'off'" @change="draft = { ...draft, alert: 'off' }" />
          <span>{{ $t('fleet.monitoring.checks.editor.alertOff') }}</span>
        </label>
        <label class="flex cursor-pointer items-center gap-2.5 pointer-coarse:min-h-11">
          <input type="radio" name="definition-alert" class="accent-[var(--primary)]" value="down" :checked="draft.alert === 'down'" @change="draft = { ...draft, alert: 'down' }" />
          <span>{{ $t('fleet.monitoring.checks.editor.alertDown') }}</span>
        </label>
        <label v-if="m3 && !isTls" class="flex cursor-pointer items-center gap-2.5 pointer-coarse:min-h-11">
          <input type="radio" name="definition-alert" class="accent-[var(--primary)]" value="down_and_degraded" :checked="draft.alert === 'down_and_degraded'" @change="draft = { ...draft, alert: 'down_and_degraded' }" />
          <span>{{ $t('fleet.monitoring.checks.editor.alertDownDegraded') }}</span>
        </label>
        <div class="flex flex-wrap items-center gap-2.5 ps-6.5" data-field="alert_after">
          <Input v-model.number="draft.alertAfter" type="number" min="1" :max="ALERT_MAX_AFTER" class="h-8 w-20" :disabled="draft.alert === 'off'" :aria-label="$t('fleet.monitoring.checks.editor.alertAfter')" :aria-invalid="problems.includes('alertAfter') || undefined" />
          <span class="text-muted-foreground">{{ $t('fleet.monitoring.checks.editor.alertRunsBefore') }}</span>
        </div>
        <p v-if="problems.includes('alertAfter')" role="alert" class="text-xs text-destructive">{{ problemOf('alertAfter') }}</p>
        <p class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.checkDefs.editor.alertEach') }}</p>
        <div v-if="m3 && !isTls" data-field="degraded"><DegradedRuleFields v-model="draft.degraded" id-prefix="definition-degraded" /></div>
      </fieldset>

      <!-- 7. Name -->
      <fieldset :class="SECTION">
        <legend :class="STEP" class="mb-2.5">{{ $t('fleet.monitoring.checks.editor.step.name') }}</legend>
        <Label for="definition-name" class="sr-only">{{ $t('fleet.monitoring.create.name') }}</Label>
        <Input id="definition-name" v-model="draft.name" data-field="name" :placeholder="suggested || $t('fleet.monitoring.create.namePlaceholder')" :aria-invalid="problems.includes('name') || undefined" />
        <label class="flex cursor-pointer items-center gap-2.5 pointer-coarse:min-h-11">
          <Checkbox :model-value="draft.enabled" data-testid="definition-enabled" @update:model-value="(v) => (draft = { ...draft, enabled: v === true })" />
          <span>{{ $t('fleet.monitoring.checkDefs.editor.enabled') }}</span>
        </label>
        <p v-if="!draft.enabled" class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.checkDefs.editor.pausedHint') }}</p>
      </fieldset>

      <!-- Problems with no field of their own. -->
      <p v-for="p in problems.filter((x) => UNFIELDED.has(x))" :key="p" role="alert" class="text-xs text-destructive">{{ problemOf(p) }}</p>
    </form>
    <template #actions>
      <SaveRefusal
        :refusal="refusals.refusal.value"
        :changed="refusals.conflict.value?.changed"
        :by="refusals.conflict.value?.latest.updated_by"
        :at="refusals.conflict.value?.latest.updated_at"
        :labels="fieldLabels"
        :message-id="refusals.messageId"
        :pending="pending"
        :noun="$t('fleet.monitoring.checkDefs.editor.noun')"
        @reload="reloadTheirs"
        @overwrite="saveOverTheirs"
      />
      <p v-if="missing.length" class="me-auto basis-full text-xs text-muted-foreground sm:basis-auto" data-testid="definition-missing">
        {{ $t('fleet.monitoring.create.missing', { fields: missing.map((m) => $t(`fleet.monitoring.checkDefs.editor.missing.${m}`)).join($t('fleet.monitoring.create.missingJoin')) }) }}
      </p>
      <p v-else-if="editing && !dirty" class="me-auto text-xs text-muted-foreground">{{ $t('fleet.monitoring.checks.editor.unchanged') }}</p>
      <!-- What the save will do, beside the button that does it; the full line sits under the targets. -->
      <p v-else-if="previewable" class="me-auto basis-full text-xs text-muted-foreground sm:basis-auto" aria-hidden="true" data-testid="definition-footer-preview">
        {{ previewPending || !summary ? $t('fleet.monitoring.checkDefs.preview.checking') : headline }}
      </p>
      <Button variant="outline" size="sm" type="button" @click="requestClose">{{ $t('common.actions.cancel') }}</Button>
      <Button type="submit" form="definition-editor" size="sm" :disabled="pending || problems.length > 0 || (editing && !dirty) || (previewable && previewPending) || !!refusals.conflict.value" data-testid="definition-save">
        <RefreshCw v-if="pending" class="size-4 animate-spin" aria-hidden="true" />
        <Save v-else-if="editing" class="size-4" aria-hidden="true" />
        <Plus v-else class="size-4" aria-hidden="true" />
        {{ editing ? $t('fleet.monitoring.checks.editor.save') : $t('fleet.monitoring.checkDefs.editor.create') }}
      </Button>
    </template>
  </ObjectSheet>

  <ConfirmDialog
    v-model:open="discardOpen"
    :title="$t('fleet.monitoring.checks.editor.discard.title')"
    :description="$t('fleet.monitoring.checks.editor.discard.description')"
    :confirm-label="$t('fleet.monitoring.checks.editor.discard.confirm')"
    :cancel-label="$t('fleet.monitoring.checks.editor.discard.keep')"
    @confirm="discard"
  />
</template>
