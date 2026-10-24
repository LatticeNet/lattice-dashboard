<script setup lang="ts">
/**
 * One check definition (design 32 D1): what it measures now, its paths
 * worst first (each opens its path sheet on the Topology view), the pairs it
 * skips grouped by reason, each reason with its fix (design 32 R2: switch to
 * Auto, leave the targets out, or approve the beacon plan; the first two open
 * the editor with the change made, for the operator to save), and the
 * targets that left its set, kept paused with their runs. Forgetting those
 * targets and deleting the definition both name the monitors and their runs
 * before they confirm, and the server refuses either when the list it was
 * shown no longer matches.
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { Pencil, Trash2 } from "lucide-vue-next";

import { api, type CheckDefinitionView, type GroupView, type Node } from "@/lib/api";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import type { OwnedRoute } from "@/composables/useOwnedRoute";

import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import ObjectSheet from "@/components/common/ObjectSheet.vue";
import { Button } from "@/components/ui/button";

import { formatCount } from "@/lib/format";
import BeaconReplanNote from "./BeaconReplanNote.vue";
import { replanNames } from "./beaconModel";
import { formatMs } from "./latencyModel";
import { stateRank, type PathItem } from "./pathsModel";
import { usePathsCopy } from "./pathsCopy";
import { describeSelector, skippedByReason, type DefinitionFix, type SelectorWords } from "./definitionsModel";
import { useBeaconReplan } from "./useBeaconReplan";

const props = defineProps<{
  open: boolean;
  /** The definition as the list read it; the sheet reads its monitors itself. */
  definition?: CheckDefinitionView;
  /** The open id, for the gone state when the list no longer has it. */
  openId?: string | null;
  listLoading: boolean;
  /** Why the list read failed: the sheet cannot tell a definition that is gone from one it could not read. */
  listError?: string | null;
  /** The matrix paths of this definition's monitors. */
  paths: PathItem[];
  /** The pairs it skips (design 32 R2): not paths, so the matrix keeps them apart. */
  skipped: PathItem[];
  nodes: Node[];
  groups: GroupView[];
  canAdmin: boolean;
  owned: OwnedRoute;
  returnFocus?: () => HTMLElement | null;
}>();

const emit = defineEmits<{ close: []; edit: [definition: CheckDefinitionView, fix?: DefinitionFix]; changed: []; retry: [] }>();

const { t } = useI18n();
const { displayLabel, whyText, methodName } = usePathsCopy();

const detail = ref<CheckDefinitionView>();
const detailError = ref<string>();
const detailLoading = ref(false);

let loadSeq = 0;
async function load(id: string): Promise<void> {
  // Only the newest read lands: a slow answer for one definition must not fill the sheet of the next.
  const seq = ++loadSeq;
  detailLoading.value = true;
  try {
    const answer = await api.monitors.definitions.get(id);
    if (seq !== loadSeq) return;
    detail.value = answer;
    detailError.value = undefined;
  } catch (error) {
    if (seq !== loadSeq) return;
    detailError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (seq === loadSeq) detailLoading.value = false;
  }
}

watch(
  () => [props.open, props.definition?.id, props.definition?.version, props.definition?.summary.monitors] as const,
  ([open, id]) => {
    if (open && id) void load(id);
    if (!open) detail.value = undefined;
  },
  { immediate: true },
);

const def = computed(() => detail.value ?? props.definition);
const sheetState = computed(() => {
  if (!props.definition) return props.listLoading ? ("loading" as const) : props.listError ? ("failed" as const) : ("gone" as const);
  return "ready" as const;
});

function nodeName(id: string): string {
  return props.nodes.find((n) => n.id === id)?.name || id;
}
const selectorWords = computed<SelectorWords>(() => ({
  fleet: t("selector.wholeFleetInline"),
  group: (name) => t("fleet.monitoring.checkDefs.sheet.group", { name }),
  except: (base, names) => t("fleet.monitoring.checkDefs.sheet.except", { base, names }),
}));

/** A selector in words: "the whole fleet except hk-2", "group asia, jp-1". */
function selectorText(sel: { nodes?: string[]; groups?: string[]; all?: boolean; exclude?: string[] } | undefined): string {
  return describeSelector(sel, props.nodes, props.groups, selectorWords.value);
}

const fromText = computed(() => (def.value?.type === "tls" ? t("fleet.monitoring.assignment.controlPlane") : selectorText(def.value?.sources)));
const toText = computed(() => {
  const d = def.value;
  if (!d) return "";
  const nodes = selectorText(d.targets);
  const addresses = d.addresses ?? [];
  if (!addresses.length) return nodes;
  const shown = addresses.length > 3 ? `${addresses.slice(0, 3).join(", ")} +${addresses.length - 3}` : addresses.join(", ");
  return nodes ? `${nodes}, ${shown}` : shown;
});

/* ---- Paths, worst first ---- */

const sortedPaths = computed(() => [...props.paths].sort((a, b) => stateRank(a.state) - stateRank(b.state) || a.sourceName.localeCompare(b.sourceName) || a.targetName.localeCompare(b.targetName)));
const counts = computed(() => {
  const by = { up: 0, degraded: 0, down: 0, unknown: 0 };
  for (const p of props.paths) by[p.state as keyof typeof by]++;
  return by;
});
const PATHS_SHOWN = 50;
/** Measured paths are rows; unknown ones gather by reason, each reason said once (design review). */
const measuredPaths = computed(() => sortedPaths.value.filter((p) => p.state !== "unknown"));
const unknownGroups = computed(() => {
  const by = new Map<string, PathItem[]>();
  for (const p of sortedPaths.value) {
    if (p.state !== "unknown") continue;
    const key = p.reason ?? "";
    by.set(key, [...(by.get(key) ?? []), p]);
  }
  return [...by.entries()].map(([reason, paths]) => ({ reason, why: whyText(paths[0]!), paths })).sort((a, b) => b.paths.length - a.paths.length || a.reason.localeCompare(b.reason));
});
const UNKNOWN_SHOWN = 24;
function pairLabel(path: PathItem): string {
  return t("fleet.monitoring.checkDefs.sheet.pair", { source: path.sourceName, target: path.targetNodeName || path.target });
}

function openPath(path: PathItem): void {
  // A skipped pair is not in the default list: the reveal shows it under the sheet.
  const reveal = path.measure === "measured" ? {} : { "paths.unmeasured": "1" };
  props.owned.push({ ...props.owned.query(), view: "topology", as: "list", path: path.key, open: undefined, ...reveal });
}

/* ---- Skipped pairs, by reason, each with its fix (design 32 R2) ---- */

const skippedGroups = computed(() => (def.value ? skippedByReason(props.skipped, def.value.type).map((g) => ({ ...g, why: whyText(g.paths[0]!), targets: [...new Set(g.paths.map((p) => p.targetNode).filter((id): id is string => !!id))] })) : []));
const replans = useBeaconReplan();
/** The beacon plan each waiting target needs, as the page's paths read names it; a target without one links to its Beacon card. */
function replanOf(targetNode: string) {
  const item = replans?.replanFor(targetNode);
  return item && replans ? { item, names: replanNames(item, undefined, replans.nameOf), canPlan: replans.missing(item).length === 0 } : undefined;
}
function fix(fixed: DefinitionFix): void {
  if (def.value) emit("edit", def.value, fixed);
}

/* ---- Paused targets: forget, with the monitors and their runs named ---- */

const paused = computed(() => (detail.value?.monitors ?? []).filter((m) => !m.in_set));
const pausedRuns = computed(() => paused.value.reduce((sum, m) => sum + m.runs, 0));
function monitorLabel(m: { target_node?: string; target: string; method: string }): string {
  return m.target_node ? `${methodName(m.method)} ${nodeName(m.target_node)}` : `${methodName(m.method)} ${m.target}`;
}

const forgetOpen = ref(false);
const forgetPending = ref(false);
const forgetImpact = computed(() => paused.value.map((m) => t("fleet.monitoring.checkDefs.sheet.monitorRuns", { name: monitorLabel(m), n: m.runs, runs: formatCount(m.runs) }, m.runs)));

async function forget(): Promise<void> {
  const d = def.value;
  if (!d) return;
  forgetPending.value = true;
  try {
    const answer = await api.monitors.definitions.forget({ id: d.id, monitor_ids: paused.value.map((m) => m.monitor_id) });
    toast.success(t("fleet.monitoring.checkDefs.toast.forgot", { n: answer.forgotten.length, runs: answer.runs }, answer.forgotten.length));
    forgetOpen.value = false;
    emit("changed");
    await load(d.id);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.monitoring.checkDefs.toast.failed"));
    await load(d.id);
  } finally {
    forgetPending.value = false;
  }
}

/* ---- Delete: every monitor and its history ---- */

const IMPACT_MAX = 60;
const deleteOpen = ref(false);
const deletePending = ref(false);
const allMonitors = computed(() => detail.value?.monitors ?? []);
const totalRuns = computed(() => allMonitors.value.reduce((sum, m) => sum + m.runs, 0));
const deleteImpact = computed(() => {
  // Every target by name: a fleet's worth fits, and a dialog that does not scroll stops at IMPACT_MAX.
  const lines = allMonitors.value.slice(0, IMPACT_MAX).map((m) => t("fleet.monitoring.checkDefs.sheet.monitorRuns", { name: monitorLabel(m), n: m.runs, runs: formatCount(m.runs) }, m.runs));
  if (allMonitors.value.length > IMPACT_MAX) lines.push(t("fleet.monitoring.checkDefs.sheet.moreMonitors", { n: allMonitors.value.length - IMPACT_MAX }));
  return lines;
});

async function remove(): Promise<void> {
  const d = detail.value;
  if (!d) return;
  deletePending.value = true;
  try {
    const answer = await api.monitors.definitions.delete({ id: d.id, version: d.version, monitor_ids: allMonitors.value.map((m) => m.monitor_id) });
    toast.success(t("fleet.monitoring.checkDefs.toast.deleted", { name: d.name, runs: formatCount(answer.runs) }));
    deleteOpen.value = false;
    emit("changed");
    emit("close");
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.monitoring.checkDefs.toast.failed"));
    await load(d.id);
  } finally {
    deletePending.value = false;
  }
}
</script>

<template>
  <ObjectSheet
    :open="open"
    :title="def?.name || openId || ''"
    :subtitle="def ? `${methodName(def.type)} · ${t('fleet.monitoring.checkDefs.sheet.subtitle', { n: def.summary.paths }, def.summary.paths)}` : undefined"
    :mono-subtitle="false"
    :state="sheetState"
    :error="listError ?? null"
    :return-focus="returnFocus"
    :gone-title="$t('fleet.monitoring.checkDefs.sheet.goneTitle')"
    :gone-description="$t('fleet.monitoring.checkDefs.sheet.goneDescription')"
    @close="emit('close')"
    @retry="emit('retry')"
  >
    <div v-if="def" class="space-y-5 text-sm" data-testid="definition-sheet">
      <p v-if="!def.enabled" class="rounded-md bg-muted/40 p-2.5 text-xs text-muted-foreground">{{ $t('fleet.monitoring.checkDefs.sheet.pausedNote') }}</p>

      <dl class="grid grid-cols-[minmax(0,6rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-md border border-border p-3 text-xs" data-testid="definition-sets">
        <dt class="text-muted-foreground">{{ $t('fleet.monitoring.checkDefs.editor.from') }}</dt>
        <dd class="min-w-0 break-words">{{ fromText }}</dd>
        <dt class="text-muted-foreground">{{ $t('fleet.monitoring.checkDefs.editor.to') }}</dt>
        <dd class="min-w-0 break-words">{{ toText }}</dd>
        <dt class="text-muted-foreground">{{ $t('fleet.monitoring.checks.editor.step.often') }}</dt>
        <dd class="min-w-0">{{ $t('fleet.monitoring.checkDefs.sheet.every', { interval: def.interval_sec, timeout: def.timeout_sec }) }}</dd>
      </dl>

      <!-- The paths, worst first; each opens its path sheet where every path lives. -->
      <section class="space-y-1.5" :aria-label="$t('fleet.monitoring.checkDefs.sheet.paths')">
        <h3 class="flex flex-wrap items-baseline gap-x-2 text-xs font-medium text-muted-foreground">
          <span>{{ $t('fleet.monitoring.checkDefs.sheet.paths') }}</span>
          <span class="font-normal tabular" data-testid="definition-path-counts">
            {{ $t('fleet.monitoring.checkDefs.sheet.counts', { up: counts.up, degraded: counts.degraded, down: counts.down, unknown: counts.unknown }) }}
          </span>
        </h3>
        <ul v-if="sortedPaths.length" class="divide-y divide-border rounded-md border border-border" data-testid="definition-paths">
          <li v-for="path in measuredPaths.slice(0, PATHS_SHOWN)" :key="path.id">
            <button
              type="button"
              class="grid min-h-11 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-1.5 text-start outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              @click="openPath(path)"
            >
              <span class="min-w-0">
                <span class="block font-medium break-words">{{ pairLabel(path) }}</span>
                <span v-if="path.state !== 'up'" :class="cn('block text-xs break-words', path.state === 'down' ? 'text-destructive' : 'text-warning-text')">{{ whyText(path) }}</span>
              </span>
              <span class="text-end font-mono text-xs tabular">{{ path.p50Ms !== undefined ? formatMs(path.p50Ms) : displayLabel(path) }}</span>
            </button>
          </li>
          <li v-if="measuredPaths.length > PATHS_SHOWN" class="px-3 py-2 text-xs text-muted-foreground">{{ $t('fleet.monitoring.checkDefs.sheet.morePaths', { n: measuredPaths.length - PATHS_SHOWN }) }}</li>
          <li v-for="group in unknownGroups" :key="`unknown:${group.reason}`" class="space-y-1 px-3 py-2" data-testid="definition-unknown-group">
            <p class="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
              <span class="min-w-0 break-words text-muted-foreground">{{ group.why }}</span>
              <span class="font-mono tabular text-muted-foreground">{{ $t('fleet.monitoring.checkDefs.sheet.unknownPaths', { n: group.paths.length }, group.paths.length) }}</span>
            </p>
            <ul class="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
              <li v-for="path in group.paths.slice(0, UNKNOWN_SHOWN)" :key="path.id">
                <button type="button" class="text-start underline-offset-2 outline-none hover:underline focus-visible:underline pointer-coarse:min-h-11" @click="openPath(path)">{{ pairLabel(path) }}</button>
              </li>
              <li v-if="group.paths.length > UNKNOWN_SHOWN" class="text-muted-foreground">{{ $t('fleet.monitoring.checkDefs.sheet.morePaths', { n: group.paths.length - UNKNOWN_SHOWN }) }}</li>
            </ul>
          </li>
        </ul>
        <p v-else class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.checkDefs.sheet.noPaths') }}</p>
      </section>

      <!-- The pairs it skips, by reason, each with its fix (design 32 R2). -->
      <section v-if="skippedGroups.length" class="space-y-1.5" data-testid="definition-skipped" :aria-label="$t('fleet.monitoring.checkDefs.sheet.skipped')">
        <h3 class="text-xs font-medium text-muted-foreground">{{ $t('fleet.monitoring.checkDefs.sheet.skippedTitle', { n: skipped.length }, skipped.length) }}</h3>
        <ul class="divide-y divide-border rounded-md border border-border">
          <li v-for="group in skippedGroups" :key="group.reason" class="space-y-2 px-3 py-2.5" :data-reason="group.reason" data-testid="definition-skipped-group">
            <p class="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
              <span class="min-w-0 break-words">{{ group.why }}</span>
              <span class="font-mono tabular text-muted-foreground">{{ $t('fleet.monitoring.checkDefs.sheet.skippedPairs', { n: group.paths.length }, group.paths.length) }}</span>
            </p>
            <ul class="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
              <li v-for="path in group.paths.slice(0, UNKNOWN_SHOWN)" :key="path.id">
                <button type="button" class="text-start text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:underline pointer-coarse:min-h-11" @click="openPath(path)">{{ pairLabel(path) }}</button>
              </li>
              <li v-if="group.paths.length > UNKNOWN_SHOWN" class="text-muted-foreground">{{ $t('fleet.monitoring.checkDefs.sheet.morePaths', { n: group.paths.length - UNKNOWN_SHOWN }) }}</li>
            </ul>
            <div v-if="canAdmin" class="flex flex-wrap items-center gap-2">
              <template v-for="kind in group.fixes" :key="kind">
                <Button v-if="kind === 'auto'" variant="outline" size="sm" type="button" data-testid="definition-fix-auto" @click="fix({ kind: 'auto' })">
                  {{ $t('fleet.monitoring.checkDefs.sheet.fixAuto') }}
                </Button>
                <Button v-else-if="kind === 'exclude' && group.targets.length" variant="outline" size="sm" type="button" data-testid="definition-fix-exclude" @click="fix({ kind: 'exclude', targets: group.targets })">
                  {{ $t('fleet.monitoring.checkDefs.sheet.fixExclude', { n: group.targets.length }, group.targets.length) }}
                </Button>
                <template v-else-if="kind === 'approve'">
                  <template v-for="target in group.targets" :key="target">
                    <BeaconReplanNote
                      v-if="replans && replanOf(target)"
                      class="w-full"
                      :item="replanOf(target)!.item"
                      :target="nodeName(target)"
                      :names="replanOf(target)!.names"
                      :sentences="false"
                      :can-plan="replanOf(target)!.canPlan"
                      :opening="replans.opening.value === target"
                      beacon-link
                      @plan="replans.open(replanOf(target)!.item)"
                    />
                    <RouterLink
                      v-else
                      :to="{ name: 'node-detail', params: { id: target }, hash: '#node-beacon' }"
                      class="text-xs font-medium text-foreground underline underline-offset-2 pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
                      data-testid="definition-fix-approve"
                    >{{ $t('fleet.monitoring.checkDefs.sheet.fixApprove', { target: nodeName(target) }) }}</RouterLink>
                  </template>
                </template>
              </template>
            </div>
          </li>
        </ul>
        <p class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.checkDefs.sheet.skippedHint') }}</p>
      </section>

      <!-- Targets that left the set: kept paused with their history until forgotten. -->
      <section v-if="paused.length" class="space-y-1.5" data-testid="definition-paused" :aria-label="$t('fleet.monitoring.checkDefs.sheet.paused')">
        <h3 class="text-xs font-medium text-muted-foreground">{{ $t('fleet.monitoring.checkDefs.sheet.pausedTitle', { n: paused.length, runs: formatCount(pausedRuns) }, paused.length) }}</h3>
        <ul class="grid gap-1 rounded-md border border-border p-2.5 text-xs">
          <li v-for="m in paused" :key="m.monitor_id" class="flex justify-between gap-3">
            <span class="min-w-0 break-words">{{ monitorLabel(m) }}</span>
            <span class="shrink-0 font-mono tabular text-muted-foreground">{{ $t('fleet.monitoring.checkDefs.sheet.runs', { n: formatCount(m.runs) }, m.runs) }}</span>
          </li>
        </ul>
        <p class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.checkDefs.sheet.pausedHint') }}</p>
        <Button v-if="canAdmin" variant="outline" size="sm" type="button" data-testid="definition-forget" @click="forgetOpen = true">
          {{ $t('fleet.monitoring.checkDefs.sheet.forget') }}
        </Button>
      </section>
      <p v-if="detailError" role="alert" class="text-xs text-destructive">{{ $t('fleet.monitoring.checkDefs.sheet.detailFailed', { reason: detailError }) }}</p>
    </div>
    <template v-if="canAdmin && def" #actions>
      <Button variant="outline" size="sm" type="button" class="text-destructive" :disabled="!detail || deletePending" data-testid="definition-delete" @click="deleteOpen = true">
        <Trash2 class="size-4" aria-hidden="true" />
        {{ $t('common.actions.delete') }}
      </Button>
      <Button size="sm" type="button" data-testid="definition-edit" @click="emit('edit', def)">
        <Pencil class="size-4" aria-hidden="true" />
        {{ $t('fleet.monitoring.checks.actions.edit') }}
      </Button>
    </template>
  </ObjectSheet>

  <ConfirmDialog
    v-model:open="forgetOpen"
    :title="$t('fleet.monitoring.checkDefs.confirm.forgetTitle')"
    :description="$t('fleet.monitoring.checkDefs.confirm.forget', { n: paused.length, runs: formatCount(pausedRuns) }, paused.length)"
    :impact="forgetImpact"
    :impact-title="$t('fleet.monitoring.checkDefs.confirm.impactTitle')"
    :confirm-label="$t('fleet.monitoring.checkDefs.confirm.forgetConfirm')"
    :cancel-label="$t('common.actions.cancel')"
    :pending="forgetPending"
    @confirm="forget"
  />
  <ConfirmDialog
    v-model:open="deleteOpen"
    :title="$t('fleet.monitoring.checkDefs.confirm.deleteTitle')"
    :description="def ? $t('fleet.monitoring.checkDefs.confirm.delete', { name: def.name, n: allMonitors.length, paths: def.summary.paths, runs: formatCount(totalRuns) }, allMonitors.length) : ''"
    :impact="deleteImpact"
    :impact-title="$t('fleet.monitoring.checkDefs.confirm.impactTitle')"
    :confirm-label="$t('common.actions.delete')"
    :cancel-label="$t('common.actions.cancel')"
    :pending="deletePending"
    @confirm="remove"
  />
</template>
