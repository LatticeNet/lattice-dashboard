<script setup lang="ts">
/**
 * The latency probe settings: on or paused, the interval, which nodes probe,
 * which nodes are probed, and the pairs switched off one by one.
 *
 * The draft starts from the plan's configuration and its version; a save
 * sends the whole configuration with that version, and the server refuses
 * one made from a stale read (409), so two operators never overwrite each
 * other. Each node row previews, by the server's own rule, whether it would
 * be a target after the save; the plan that comes back is what is shown
 * from then on. The save is audited on the server.
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RefreshCw, Save, Search } from "lucide-vue-next";

import { api, type LatencyProbeNode, type LatencyProbePlan } from "@/lib/api";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import ObjectSheet from "@/components/common/ObjectSheet.vue";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import {
  LATENCY_MAX_INTERVAL_SEC,
  LATENCY_MAX_TIMEOUT_SEC,
  LATENCY_MIN_INTERVAL_SEC,
  draftFromConfig,
  draftProblems,
  draftTargetReason,
  draftToConfig,
  draftsDiffer,
  setPairEnabled,
  setSource,
  setTargetMode,
  targetMode,
  type LatencyDraft,
  type TargetMode,
} from "./latencyModel";

const props = defineProps<{ open: boolean; plan: LatencyProbePlan }>();
const emit = defineEmits<{ close: []; saved: [plan: LatencyProbePlan]; reload: [] }>();

const { t } = useI18n();

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
);

const query = ref("");
const nodes = computed(() =>
  [...props.plan.nodes].sort((a, b) => (a.name || a.node_id).localeCompare(b.name || b.node_id)),
);
const filteredNodes = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return nodes.value;
  return nodes.value.filter((n) => `${n.name} ${n.node_id} ${n.country ?? ""}`.toLowerCase().includes(q));
});
const nameOf = (id: string) => props.plan.nodes.find((n) => n.node_id === id)?.name || id;

function isDisabled(node: LatencyProbeNode): boolean {
  return node.target_reason === "node_disabled" || props.plan.source_notes?.[node.node_id] === "node_disabled";
}

function preview(node: LatencyProbeNode) {
  return draftTargetReason(draft.value, node, isDisabled(node));
}

const targetCount = computed(() => nodes.value.filter((n) => preview(n).target).length);
const problems = computed(() => draftProblems(draft.value));
const dirty = computed(() => draftsDiffer(base.value, draft.value));
const pending = ref(false);

const MODES: TargetMode[] = ["auto", "always", "never"];

function setMode(node: LatencyProbeNode, mode: TargetMode): void {
  draft.value = setTargetMode(draft.value, node.node_id, mode);
}

function toggleSource(node: LatencyProbeNode, on: boolean): void {
  draft.value = setSource(draft.value, node.node_id, on);
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
</script>

<template>
  <ObjectSheet :open="open" :title="$t('fleet.monitoring.latency.config.title')" @close="requestClose">
    <form id="latency-config" class="space-y-6 text-sm" @submit.prevent="save">
      <p class="text-muted-foreground">{{ $t('fleet.monitoring.latency.config.description') }}</p>
      <p v-if="!plan.stored" class="rounded-md bg-muted/40 p-2.5 text-xs text-muted-foreground">
        {{ $t('fleet.monitoring.latency.config.defaults', { name: plan.default_source_name }) }}
      </p>

      <section class="grid gap-3" :aria-label="$t('fleet.monitoring.latency.config.probes')">
        <div class="grid gap-2">
          <Label>{{ $t('fleet.monitoring.latency.config.probes') }}</Label>
          <div class="grid grid-cols-2 rounded-md border border-input p-1" role="group">
            <button
              type="button"
              :class="cn('rounded px-2 py-1.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11', draft.enabled && 'bg-secondary font-medium text-foreground')"
              :aria-pressed="draft.enabled"
              @click="draft = { ...draft, enabled: true }"
            >
              {{ $t('fleet.monitoring.latency.config.on') }}
            </button>
            <button
              type="button"
              :class="cn('rounded px-2 py-1.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11', !draft.enabled && 'bg-secondary font-medium text-foreground')"
              :aria-pressed="!draft.enabled"
              @click="draft = { ...draft, enabled: false }"
            >
              {{ $t('fleet.monitoring.latency.config.paused') }}
            </button>
          </div>
          <p v-if="!draft.enabled" class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.latency.config.pausedHint') }}</p>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="grid gap-2">
            <Label for="latency-interval">{{ $t('fleet.monitoring.latency.config.interval') }}</Label>
            <Input
              id="latency-interval"
              :model-value="draft.intervalSec"
              type="number"
              :min="LATENCY_MIN_INTERVAL_SEC"
              :max="LATENCY_MAX_INTERVAL_SEC"
              @update:model-value="(v) => (draft = { ...draft, intervalSec: Number(v) })"
            />
          </div>
          <div class="grid gap-2">
            <Label for="latency-timeout">{{ $t('fleet.monitoring.latency.config.timeout') }}</Label>
            <Input
              id="latency-timeout"
              :model-value="draft.timeoutSec"
              type="number"
              min="1"
              :max="LATENCY_MAX_TIMEOUT_SEC"
              @update:model-value="(v) => (draft = { ...draft, timeoutSec: Number(v) })"
            />
          </div>
        </div>
        <p v-for="text in problemText" :key="text" role="alert" class="text-xs text-destructive">{{ text }}</p>
      </section>

      <section class="grid gap-2" :aria-label="$t('fleet.monitoring.latency.config.targets')">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <Label>{{ $t('fleet.monitoring.latency.config.targets') }}</Label>
          <span class="text-xs text-muted-foreground tabular" data-testid="latency-config-counts">
            {{ $t('fleet.monitoring.latency.config.counts', { sources: draft.sources.length, targets: targetCount }) }}
          </span>
        </div>
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
            <!-- The checkbox, the name and its line are one label: tapping the name
                 toggles the source, and on touch the target is at least 44 px tall. -->
            <label class="-mx-1 flex min-w-0 cursor-pointer items-start gap-2 rounded-md px-1 hover:bg-muted/40 pointer-coarse:min-h-11 pointer-coarse:items-center" data-testid="latency-source-toggle">
              <Checkbox
                :model-value="draft.sources.includes(node.node_id)"
                :aria-label="$t('fleet.monitoring.latency.config.sourceToggle', { name: node.name })"
                class="mt-0.5 pointer-coarse:mt-0"
                @update:model-value="(v) => toggleSource(node, v === true)"
              />
              <span class="block min-w-0">
                <span class="block truncate font-medium" :title="node.name">{{ node.name || node.node_id }}</span>
                <span class="block text-xs text-muted-foreground">
                  <span v-if="node.country" class="font-mono">{{ node.country }} · </span>
                  <span v-if="draft.sources.includes(node.node_id)" class="text-foreground">{{ $t('fleet.monitoring.latency.config.isSource') }} · </span>
                  <span :class="preview(node).target ? 'text-foreground' : ''">
                    {{ preview(node).target ? $t('fleet.monitoring.latency.config.isTarget') : $t('fleet.monitoring.latency.config.notTarget') }}:
                    {{ $t(`fleet.monitoring.latency.reason.${preview(node).reason}`) }}
                  </span>
                </span>
              </span>
            </label>
            <div class="flex rounded-md border border-border p-0.5 text-xs" role="group" :aria-label="$t('fleet.monitoring.latency.config.modeLabel', { name: node.name })">
              <button
                v-for="mode in MODES"
                :key="mode"
                type="button"
                :class="cn('flex-1 rounded px-2 py-1 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11', targetMode(draft, node.node_id) === mode ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')"
                :aria-pressed="targetMode(draft, node.node_id) === mode"
                @click="setMode(node, mode)"
              >
                {{ $t(`fleet.monitoring.latency.config.mode.${mode}`) }}
              </button>
            </div>
          </li>
          <li v-if="filteredNodes.length === 0" class="px-3 py-5 text-center text-xs text-muted-foreground">{{ $t('fleet.monitoring.latency.config.noMatch') }}</li>
        </ul>
        <p class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.latency.config.ruleHint') }}</p>
      </section>

      <section v-if="draft.disabledPairs.length" class="grid gap-2" :aria-label="$t('fleet.monitoring.latency.config.stoppedPairs')">
        <Label>{{ $t('fleet.monitoring.latency.config.stoppedPairs') }}</Label>
        <ul class="divide-y divide-border rounded-md border border-border">
          <li v-for="pair in draft.disabledPairs" :key="`${pair.source}~${pair.target}`" class="flex items-center justify-between gap-2 px-2.5 py-1.5">
            <span class="min-w-0 truncate">{{ $t('fleet.monitoring.latency.sheet.title', { source: nameOf(pair.source), target: nameOf(pair.target) }) }}</span>
            <Button variant="outline" size="sm" type="button" @click="resumePair(pair.source, pair.target)">{{ $t('fleet.monitoring.latency.config.resume') }}</Button>
          </li>
        </ul>
      </section>
    </form>
    <template #actions>
      <p v-if="!dirty" class="me-auto text-xs text-muted-foreground">{{ $t('fleet.monitoring.latency.config.unchanged') }}</p>
      <Button variant="outline" size="sm" type="button" @click="requestClose">{{ $t('common.actions.cancel') }}</Button>
      <Button type="submit" form="latency-config" size="sm" :disabled="pending || !dirty || problems.length > 0" data-testid="latency-config-save">
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
