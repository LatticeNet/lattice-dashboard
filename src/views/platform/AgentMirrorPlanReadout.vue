<script setup lang="ts">
/**
 * An agent.mirrors plan (design 31 D4) as an operator reviews it: what it
 * does to which entry, each field before and after, and every node whose
 * download order changes, with that order before and after. Used where the
 * plan is filed (Agent updates) and where it is decided (Approvals).
 *
 * It reads the plan document the approval carries; the hash binds the text,
 * which both places keep on screen beside this. A create lists the new
 * entry's values and a delete the removed entry's, each once; a change
 * shows each field before and after. Nodes whose order changes the same way
 * share one row, so a change that moves forty nodes reads as one or two
 * rows, each naming its nodes.
 */
import { computed, ref } from "vue";
import { AlertTriangle } from "lucide-vue-next";
import { useI18n } from "vue-i18n";

import type { AgentMirror, AgentMirrorPlan } from "@/lib/api/types";
import { useNodeDirectory } from "@/composables/useNodeDirectory";
import { cn } from "@/lib/utils";

import AgentSourceOrder from "./AgentSourceOrder.vue";
import { mirrorPlanSentence } from "./agentMirrorsCopy";
import {
  groupOrderChanges,
  mirrorPlanDiff,
  mirrorRefLabel,
  namePreview,
  planBehindRegistry,
  type MirrorField,
} from "./agentMirrorsModel";

const props = defineProps<{
  plan: AgentMirrorPlan;
  /** The registry's current revision, when the page read it: a plan made against an older one is stale. */
  revision?: number;
  /** Static group names by id, for prefer_for. */
  groupNames?: ReadonlyMap<string, string>;
}>();

const { t } = useI18n();
const directory = useNodeDirectory();

const NAMES_SHOWN = 8;

const nodeNames = computed(() => new Map((directory?.value ?? []).map((node) => [node.id, node.name ?? ""] as const)));
const groups = computed(() => props.groupNames ?? new Map<string, string>());

const sentence = computed(() => mirrorPlanSentence(t, props.plan));
const behind = computed(() => planBehindRegistry(props.plan, props.revision));
const diff = computed(() => mirrorPlanDiff(props.plan));
/** Which sides a row shows: a create has no before and a delete no after. */
const sides = computed(() => (props.plan.action === "create" ? "after" : props.plan.action === "delete" ? "before" : "both"));
const changeGroups = computed(() => groupOrderChanges(props.plan.changes));
const changedNodes = computed(() => props.plan.changes.length);
const mirrorNames = computed(() => {
  const names = new Map<string, string>();
  for (const entry of [props.plan.previous, props.plan.mirror]) if (entry?.name) names.set(entry.id, entry.name);
  return names;
});

const expanded = ref(new Set<string>());
function toggle(key: string): void {
  const next = new Set(expanded.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expanded.value = next;
}

function fieldLabel(field: MirrorField): string {
  return t(`platform.agentUpdatesPage.mirrors.fields.${field}`);
}

/** A field's value in words; undefined when the entry does not hold it. prefer_for is drawn as chips instead. */
function fieldText(entry: AgentMirror | undefined, field: MirrorField): string | undefined {
  if (!entry) return undefined;
  switch (field) {
    case "name":
      return entry.name || undefined;
    case "base_url":
      return entry.base_url;
    case "prefer_for":
      return (entry.prefer_for ?? []).length ? "" : undefined;
    case "global":
    case "enabled":
      return t(`platform.agentUpdatesPage.mirrors.plan.flag.${entry[field] ? "on" : "off"}`);
    case "priority":
      return String(entry.priority);
  }
}

function refs(entry: AgentMirror | undefined) {
  return (entry?.prefer_for ?? []).map((ref) => ({ ref, ...mirrorRefLabel(ref, nodeNames.value, groups.value) }));
}
</script>

<template>
  <div class="space-y-4 text-sm" data-testid="mirror-plan-readout">
    <div class="space-y-1">
      <p class="break-words font-medium text-foreground">{{ sentence }}</p>
      <p class="text-xs text-muted-foreground">{{ $t('platform.agentUpdatesPage.mirrors.plan.revision', { n: plan.base_revision }) }}</p>
      <p v-if="behind" class="flex items-start gap-2 text-xs text-warning-text" data-testid="mirror-plan-behind">
        <AlertTriangle class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span>{{ $t('platform.agentUpdatesPage.mirrors.plan.behind', { planned: plan.base_revision, current: revision ?? 0 }) }}</span>
      </p>
    </div>

    <section class="space-y-1.5" :aria-label="$t('platform.agentUpdatesPage.mirrors.plan.diffTitle')">
      <h3 class="text-xs font-medium text-muted-foreground">{{ $t('platform.agentUpdatesPage.mirrors.plan.diffTitle') }}</h3>
      <p v-if="!diff.length" class="text-xs text-muted-foreground">{{ $t('platform.agentUpdatesPage.mirrors.plan.noDiff') }}</p>
      <ul v-else class="divide-y divide-border rounded-md border border-border">
        <li v-for="(row, index) in diff" :key="index" class="grid gap-x-3 gap-y-0.5 px-3 py-2 text-xs sm:grid-cols-[7.5rem_minmax(0,1fr)]">
          <template v-if="'field' in row">
            <span class="text-muted-foreground">{{ fieldLabel(row.field) }}</span>
            <span class="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-1">
              <template v-for="side in (sides === 'both' ? ['before', 'after'] : [sides])" :key="side">
                <span v-if="side === 'after' && sides === 'both'" class="text-muted-foreground" aria-hidden="true">→</span>
                <span v-if="side === 'after' && sides === 'both'" class="sr-only">{{ $t('platform.agentUpdatesPage.mirrors.plan.becomes') }}</span>
                <span v-if="fieldText(side === 'before' ? row.before : row.after, row.field) === undefined" class="text-muted-foreground">{{ $t('platform.agentUpdatesPage.mirrors.plan.absent') }}</span>
                <ul v-else-if="row.field === 'prefer_for'" class="flex min-w-0 flex-wrap gap-1">
                  <li
                    v-for="item in refs(side === 'before' ? row.before : row.after)"
                    :key="item.ref"
                    :title="item.ref"
                    :class="cn(
                      'max-w-full rounded border border-border px-1.5 py-px [overflow-wrap:anywhere]',
                      side === 'before' ? 'text-muted-foreground line-through decoration-muted-foreground/60' : 'text-foreground',
                      item.kind === 'unknown' && 'font-mono',
                    )"
                  ><span v-if="item.kind === 'group'" class="me-1 text-muted-foreground">{{ $t('platform.agentUpdatesPage.mirrors.applies.groupMark') }}</span>{{ item.text }}</li>
                </ul>
                <span
                  v-else
                  :class="cn('font-mono [overflow-wrap:anywhere]', side === 'before' ? 'text-muted-foreground line-through decoration-muted-foreground/60' : 'text-foreground')"
                >{{ fieldText(side === 'before' ? row.before : row.after, row.field) }}</span>
              </template>
            </span>
          </template>
          <span v-else class="font-mono text-foreground [overflow-wrap:anywhere] sm:col-span-2">{{ row.raw }}</span>
        </li>
      </ul>
    </section>

    <section class="space-y-1.5" :aria-label="$t('platform.agentUpdatesPage.mirrors.plan.changesTitle', { n: changedNodes }, changedNodes)">
      <h3 class="text-xs font-medium text-muted-foreground">{{ $t('platform.agentUpdatesPage.mirrors.plan.changesTitle', { n: changedNodes }, changedNodes) }}</h3>
      <p v-if="!changedNodes" class="text-xs text-muted-foreground">{{ $t('platform.agentUpdatesPage.mirrors.plan.noChanges') }}</p>
      <ul v-else class="divide-y divide-border rounded-md border border-border" data-testid="mirror-plan-changes">
        <li v-for="group in changeGroups" :key="group.key" class="space-y-2 px-3 py-2.5">
          <div class="grid gap-x-3 gap-y-1 text-xs sm:grid-cols-[3.5rem_minmax(0,1fr)]">
            <span class="text-muted-foreground">{{ $t('platform.agentUpdatesPage.mirrors.plan.before') }}</span>
            <AgentSourceOrder :sources="group.before" :mirror-names="mirrorNames" :label="$t('platform.agentUpdatesPage.mirrors.plan.before')" />
            <span class="text-muted-foreground">{{ $t('platform.agentUpdatesPage.mirrors.plan.after') }}</span>
            <AgentSourceOrder :sources="group.after" :mirror-names="mirrorNames" :label="$t('platform.agentUpdatesPage.mirrors.plan.after')" />
          </div>
          <p class="text-xs text-muted-foreground">
            <span class="font-medium text-foreground">{{ $t('platform.agentUpdatesPage.mirrors.nodeCount', { n: group.nodes.length }, group.nodes.length) }}</span>
            <span>: </span>
            <template v-for="(node, index) in (expanded.has(group.key) ? { names: group.nodes } : namePreview(group.nodes, NAMES_SHOWN)).names" :key="node.id">
              <span v-if="index">, </span><span class="whitespace-nowrap">{{ node.name }}</span>
            </template>
            <button
              v-if="namePreview(group.nodes, NAMES_SHOWN).extra"
              type="button"
              class="touch-target ms-1 rounded-sm text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              :aria-expanded="expanded.has(group.key)"
              @click="toggle(group.key)"
            >{{ expanded.has(group.key) ? $t('platform.agentUpdatesPage.mirrors.showFewer') : $t('platform.agentUpdatesPage.mirrors.showAll', { n: namePreview(group.nodes, NAMES_SHOWN).extra }) }}</button>
          </p>
        </li>
      </ul>
    </section>
  </div>
</template>
