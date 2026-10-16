<script setup lang="ts">
/**
 * The path set (design 29 D1, D9): the one rule the planner expands into
 * generated checks, sources times targets, with the paths switched off one by
 * one. It replaces the Latency layer's probe settings and keeps their
 * behaviour, in the check editor's task order: what it measures, from where,
 * to where, how often, and the paths that are paused.
 *
 * The draft starts from the plan's configuration and its version; a save
 * sends the whole configuration with that version, and the server refuses
 * one made from a stale read (409), so two operators never overwrite each
 * other. Each node row previews, by the server's own rule, whether it would
 * be a target after the save; the plan that comes back is what is shown from
 * then on. The save is audited on the server.
 *
 * On an M2a server the path set also picks its method (TCP, ICMP or Auto)
 * and pins single sources to one, and previews per source which method it
 * will use and how many targets it reaches with it. Against an older server
 * neither is shown nor sent.
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RefreshCw, Save, Search } from "lucide-vue-next";

import { api, type LatencyProbeNode, type LatencyProbePlan, type Node } from "@/lib/api";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import ObjectSheet from "@/components/common/ObjectSheet.vue";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import SourcePicker from "./SourcePicker.vue";
import {
  LATENCY_MAX_INTERVAL_SEC,
  LATENCY_MAX_TIMEOUT_SEC,
  LATENCY_MIN_INTERVAL_SEC,
  PATH_SET_METHODS,
  SOURCE_PINS,
  draftFromConfig,
  draftProblems,
  draftTargetReason,
  draftToConfig,
  draftsDiffer,
  pathSetPreview,
  setPairEnabled,
  setSourceMethod,
  setTargetMode,
  targetMode,
  type LatencyDraft,
  type SourceMethodPreview,
  type TargetMode,
} from "./latencyModel";
import { usePathsCopy } from "./pathsCopy";

const props = defineProps<{
  open: boolean;
  plan: LatencyProbePlan;
  nodes: Node[];
  /** The server speaks M2a: the method and the pins are offered. */
  m2a?: boolean;
}>();
const emit = defineEmits<{ close: []; saved: [plan: LatencyProbePlan]; reload: [] }>();

const { t } = useI18n();
const { refusalText } = usePathsCopy();

const base = ref<LatencyDraft>(draftFromConfig(props.plan.config));
const draft = ref<LatencyDraft>(draftFromConfig(props.plan.config));
watch(
  () => props.open,
  (open) => {
    if (!open) return;
    base.value = draftFromConfig(props.plan.config);
    draft.value = draftFromConfig(props.plan.config);
    query.value = "";
  },
  { immediate: true },
);

const query = ref("");
const planNodes = computed(() => [...props.plan.nodes].sort((a, b) => (a.name || a.node_id).localeCompare(b.name || b.node_id)));
const filteredNodes = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return planNodes.value;
  return planNodes.value.filter((n) => `${n.name} ${n.node_id} ${n.country ?? ""}`.toLowerCase().includes(q));
});
const nameOf = (id: string) => props.plan.nodes.find((n) => n.node_id === id)?.name || id;

/** The source picker's nodes: the plan's, with what the node list knows about each (online, country). */
const sourceNodes = computed<Node[]>(() => {
  const byId = new Map(props.nodes.map((n) => [n.id, n]));
  return props.plan.nodes.map((pn) => byId.get(pn.node_id) ?? ({ id: pn.node_id, name: pn.name, online: true, geo: pn.country ? { country: pn.country } : undefined } as Node));
});
const sources = computed({
  get: () => draft.value.sources,
  set: (next: string[]) => (draft.value = { ...draft.value, sources: [...next].sort() }),
});

function isDisabled(node: LatencyProbeNode): boolean {
  return node.target_reason === "node_disabled" || props.plan.source_notes?.[node.node_id] === "node_disabled";
}

function preview(node: LatencyProbeNode) {
  return draftTargetReason(draft.value, node, isDisabled(node));
}

const targetCount = computed(() => planNodes.value.filter((n) => preview(n).target).length);
const pathCount = computed(() => {
  const targets = planNodes.value.filter((n) => preview(n).target).map((n) => n.node_id);
  let n = 0;
  for (const s of draft.value.sources) for (const tid of targets) if (s !== tid) n += 1;
  return n;
});
const problems = computed(() => draftProblems(draft.value));

/* ---- Method (design 29 M2a) ---- */

const methodLabel = (m: string) => t(`fleet.monitoring.pathSet.methods.${m || "tcp"}`);
const methodPreview = computed(() => (props.m2a ? pathSetPreview(draft.value, props.plan, sourceNodes.value) : []));

function setMethod(method: string): void {
  draft.value = { ...draft.value, method };
}
function setPin(source: string, value: string): void {
  draft.value = setSourceMethod(draft.value, source, value || undefined);
}

/** One line per source: the method it will use and what it reaches with it. */
function previewLine(row: SourceMethodPreview): string {
  if (row.refusal) return t("fleet.monitoring.pathSet.preview.cannot", { why: refusalText(row.refusal, "icmp") });
  const parts: string[] = [];
  if (row.icmp) parts.push(t("fleet.monitoring.pathSet.preview.icmp", { n: row.icmp }, row.icmp));
  if (row.tcp) parts.push(t("fleet.monitoring.pathSet.preview.tcp", { n: row.tcp }, row.tcp));
  if (row.onSave) parts.push(t("fleet.monitoring.pathSet.preview.onSave", { n: row.onSave }, row.onSave));
  if (row.none) parts.push(t("fleet.monitoring.pathSet.preview.none", { n: row.none }, row.none));
  return parts.length ? parts.join(t("fleet.monitoring.pathSet.preview.join")) : t("fleet.monitoring.pathSet.preview.nothing");
}
const dirty = computed(() => draftsDiffer(base.value, draft.value));
const pending = ref(false);
const MODES: TargetMode[] = ["auto", "always", "never"];

function setMode(node: LatencyProbeNode, mode: TargetMode): void {
  draft.value = setTargetMode(draft.value, node.node_id, mode);
}

function resumePair(source: string, target: string): void {
  draft.value = setPairEnabled(draft.value, source, target, true);
}

async function save(): Promise<void> {
  if (problems.value.length || !dirty.value) return;
  pending.value = true;
  try {
    const next = await api.monitors.latency.save(draftToConfig(draft.value));
    toast.success(t("fleet.monitoring.latency.toast.saved"));
    emit("saved", next);
    emit("close");
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 409) {
      toast.error(t("fleet.monitoring.latency.toast.conflict"));
      emit("reload");
      emit("close");
    } else {
      toast.error(error instanceof Error ? error.message : t("fleet.monitoring.latency.toast.saveFailed"));
    }
  } finally {
    pending.value = false;
  }
}

const discardOpen = ref(false);
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

const problemText = computed(() => problems.value.map((p) => t(`fleet.monitoring.latency.config.problem.${p}`, { min: LATENCY_MIN_INTERVAL_SEC, max: LATENCY_MAX_INTERVAL_SEC, timeout: LATENCY_MAX_TIMEOUT_SEC })));
const SECTION = "grid min-w-0 gap-2.5 border-0 p-0";
const STEP = "text-xs font-medium uppercase tracking-wide text-muted-foreground";
</script>

<template>
  <ObjectSheet :open="open" :title="$t('fleet.monitoring.pathSet.title')" @close="requestClose">
    <form id="path-set" class="space-y-6 text-sm" data-testid="path-set" @submit.prevent="save">
      <p class="text-muted-foreground">{{ $t('fleet.monitoring.pathSet.description') }}</p>
      <p v-if="!plan.stored" class="rounded-md bg-muted/40 p-2.5 text-xs text-muted-foreground">
        {{ $t('fleet.monitoring.latency.config.defaults', { name: plan.default_source_name }) }}
      </p>

      <!-- 1. What it measures -->
      <fieldset :class="SECTION">
        <legend :class="STEP" class="mb-2.5">{{ $t('fleet.monitoring.checks.editor.step.what') }}</legend>
        <template v-if="m2a">
          <div class="grid grid-cols-3 rounded-md border border-input p-1" role="radiogroup" :aria-label="$t('fleet.monitoring.pathSet.methodLabel')" data-testid="path-set-method">
            <button
              v-for="m in PATH_SET_METHODS"
              :key="m || 'tcp'"
              type="button"
              role="radio"
              :aria-checked="draft.method === m"
              :class="cn('rounded px-2 py-1.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11', draft.method === m && 'bg-secondary font-medium text-foreground')"
              @click="setMethod(m)"
            >{{ methodLabel(m) }}</button>
          </div>
          <p class="text-xs text-muted-foreground">{{ $t(`fleet.monitoring.pathSet.methodHint.${draft.method || 'tcp'}`) }}</p>
        </template>
        <p v-else class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.pathSet.method') }}</p>
        <div class="grid grid-cols-2 rounded-md border border-input p-1" role="group" :aria-label="$t('fleet.monitoring.latency.config.probes')">
          <button
            type="button"
            :class="cn('rounded px-2 py-1.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11', draft.enabled && 'bg-secondary font-medium text-foreground')"
            :aria-pressed="draft.enabled"
            @click="draft = { ...draft, enabled: true }"
          >{{ $t('fleet.monitoring.latency.config.on') }}</button>
          <button
            type="button"
            :class="cn('rounded px-2 py-1.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11', !draft.enabled && 'bg-secondary font-medium text-foreground')"
            :aria-pressed="!draft.enabled"
            @click="draft = { ...draft, enabled: false }"
          >{{ $t('fleet.monitoring.latency.config.paused') }}</button>
        </div>
        <p v-if="!draft.enabled" class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.latency.config.pausedHint') }}</p>
      </fieldset>

      <!-- 2. From where -->
      <fieldset :class="SECTION">
        <legend :class="STEP" class="mb-2.5">{{ $t('fleet.monitoring.checks.editor.step.from') }}</legend>
        <SourcePicker v-model="sources" :nodes="sourceNodes" :m2a="m2a" :label="$t('fleet.monitoring.checks.editor.step.from')" />
        <div v-if="m2a && methodPreview.length" class="grid gap-1.5" data-testid="path-set-pins">
          <p class="text-xs font-medium">{{ $t('fleet.monitoring.pathSet.pins') }}</p>
          <ul class="divide-y divide-border rounded-md border border-border">
            <li v-for="row in methodPreview" :key="row.source" class="grid gap-1.5 px-2.5 py-2 sm:grid-cols-[minmax(0,1fr)_11rem] sm:items-center" :data-pin="row.source">
              <span class="min-w-0">
                <span class="block truncate font-medium" :title="nameOf(row.source)">{{ nameOf(row.source) }}</span>
                <span :class="cn('block text-xs', row.refusal ? 'text-warning-text' : 'text-muted-foreground')">
                  <span class="font-mono">{{ methodLabel(row.method) }}</span>
                  <span v-if="!row.pinned"> ({{ $t('fleet.monitoring.pathSet.followsSet') }})</span>
                  · {{ previewLine(row) }}
                </span>
              </span>
              <select
                :value="draft.sourceMethods[row.source] ?? ''"
                class="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11"
                :aria-label="$t('fleet.monitoring.pathSet.pinLabel', { name: nameOf(row.source) })"
                @change="(e) => setPin(row.source, (e.target as HTMLSelectElement).value)"
              >
                <option value="">{{ $t('fleet.monitoring.pathSet.pinFollow', { method: methodLabel(draft.method) }) }}</option>
                <option v-for="pin in SOURCE_PINS" :key="pin" :value="pin">{{ methodLabel(pin) }}</option>
              </select>
            </li>
          </ul>
          <p class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.pathSet.pinHint') }}</p>
        </div>
      </fieldset>

      <!-- 3. To where -->
      <fieldset :class="SECTION">
        <legend :class="STEP" class="mb-2.5">{{ $t('fleet.monitoring.checks.editor.step.to') }}</legend>
        <label class="flex items-start gap-2 rounded-md border border-border p-2.5">
          <Checkbox :model-value="draft.autoTargets" @update:model-value="(v) => (draft = { ...draft, autoTargets: v === true })" />
          <span>
            <span class="block font-medium">{{ $t('fleet.monitoring.latency.config.auto') }}</span>
            <span class="block text-xs text-muted-foreground">{{ $t('fleet.monitoring.latency.config.autoHint') }}</span>
          </span>
        </label>
        <div class="relative">
          <Search class="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input v-model="query" class="ps-8" :placeholder="$t('fleet.monitoring.latency.config.search')" :aria-label="$t('fleet.monitoring.latency.config.search')" />
        </div>
        <ul class="max-h-[26rem] divide-y divide-border overflow-auto rounded-md border border-border" data-testid="latency-config-nodes">
          <li v-for="node in filteredNodes" :key="node.node_id" class="grid gap-2 px-2.5 py-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <span class="block min-w-0">
              <span class="block truncate font-medium" :title="node.name">{{ node.name || node.node_id }}</span>
              <span class="block text-xs text-muted-foreground">
                <span v-if="node.country" class="font-mono">{{ node.country }} · </span>
                <span :class="preview(node).target ? 'text-foreground' : ''">
                  {{
                    $t('fleet.monitoring.latency.config.targetLine', {
                      state: preview(node).target ? $t('fleet.monitoring.latency.config.isTarget') : $t('fleet.monitoring.latency.config.notTarget'),
                      reason: $t(`fleet.monitoring.latency.reason.${preview(node).reason}`),
                    })
                  }}
                </span>
              </span>
            </span>
            <div class="flex rounded-md border border-border p-0.5 text-xs" role="group" :aria-label="$t('fleet.monitoring.latency.config.modeLabel', { name: node.name })">
              <button
                v-for="mode in MODES"
                :key="mode"
                type="button"
                :class="cn('flex-1 rounded px-2 py-1 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11', targetMode(draft, node.node_id) === mode ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')"
                :aria-pressed="targetMode(draft, node.node_id) === mode"
                @click="setMode(node, mode)"
              >{{ $t(`fleet.monitoring.latency.config.mode.${mode}`) }}</button>
            </div>
          </li>
          <li v-if="filteredNodes.length === 0" class="px-3 py-5 text-center text-xs text-muted-foreground">{{ $t('fleet.monitoring.latency.config.noMatch') }}</li>
        </ul>
        <p class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.latency.config.ruleHint') }}</p>
      </fieldset>

      <!-- 4. How often -->
      <fieldset :class="SECTION">
        <legend :class="STEP" class="mb-2.5">{{ $t('fleet.monitoring.checks.editor.step.often') }}</legend>
        <div class="grid grid-cols-2 gap-3">
          <div class="grid gap-1.5">
            <Label for="latency-interval">{{ $t('fleet.monitoring.latency.config.interval') }}</Label>
            <Input id="latency-interval" :model-value="draft.intervalSec" type="number" :min="LATENCY_MIN_INTERVAL_SEC" :max="LATENCY_MAX_INTERVAL_SEC" @update:model-value="(v) => (draft = { ...draft, intervalSec: Number(v) })" />
          </div>
          <div class="grid gap-1.5">
            <Label for="latency-timeout">{{ $t('fleet.monitoring.latency.config.timeout') }}</Label>
            <Input id="latency-timeout" :model-value="draft.timeoutSec" type="number" min="1" :max="LATENCY_MAX_TIMEOUT_SEC" @update:model-value="(v) => (draft = { ...draft, timeoutSec: Number(v) })" />
          </div>
        </div>
        <p v-for="text in problemText" :key="text" role="alert" class="text-xs text-destructive">{{ text }}</p>
      </fieldset>

      <!-- 5. Paused paths -->
      <fieldset v-if="draft.disabledPairs.length" :class="SECTION">
        <legend :class="STEP" class="mb-2.5">{{ $t('fleet.monitoring.pathSet.paused') }}</legend>
        <ul class="divide-y divide-border rounded-md border border-border">
          <li v-for="pair in draft.disabledPairs" :key="`${pair.source}~${pair.target}`" class="flex items-center justify-between gap-2 px-2.5 py-1.5">
            <span class="min-w-0 truncate">{{ $t('fleet.monitoring.paths.sheet.title', { source: nameOf(pair.source), target: nameOf(pair.target) }) }}</span>
            <Button variant="outline" size="sm" type="button" @click="resumePair(pair.source, pair.target)">{{ $t('fleet.monitoring.latency.config.resume') }}</Button>
          </li>
        </ul>
      </fieldset>
    </form>
    <template #actions>
      <p class="me-auto text-xs text-muted-foreground tabular" data-testid="latency-config-counts">
        {{ dirty ? $t('fleet.monitoring.pathSet.counts', { sources: draft.sources.length, targets: targetCount, paths: pathCount }) : $t('fleet.monitoring.latency.config.unchanged') }}
      </p>
      <Button variant="outline" size="sm" type="button" @click="requestClose">{{ $t('common.actions.cancel') }}</Button>
      <Button type="submit" form="path-set" size="sm" :disabled="pending || !dirty || problems.length > 0" data-testid="latency-config-save">
        <RefreshCw v-if="pending" class="size-4 animate-spin" aria-hidden="true" />
        <Save v-else class="size-4" aria-hidden="true" />
        {{ $t('fleet.monitoring.latency.config.save') }}
      </Button>
    </template>
  </ObjectSheet>
  <ConfirmDialog
    v-model:open="discardOpen"
    :title="$t('fleet.monitoring.latency.config.discard.title')"
    :description="$t('fleet.monitoring.latency.config.discard.description')"
    :confirm-label="$t('fleet.monitoring.latency.config.discard.confirm')"
    :cancel-label="$t('fleet.monitoring.latency.config.discard.keep')"
    @confirm="discard"
  />
</template>
