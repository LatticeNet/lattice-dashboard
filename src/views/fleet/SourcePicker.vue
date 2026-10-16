<script setup lang="ts">
/**
 * Where a check runs from (design 29 D9): the nodes grouped by region, a
 * search over names and countries, and, when editing, a pause per chosen
 * source. Pausing keeps the source on the check and its history; removing it
 * stops its path for good.
 */
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Search } from "lucide-vue-next";

import type { Node } from "@/lib/api";
import { regionOf, regionRank, type RegionKey } from "@/lib/regions";
import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

const props = withDefaults(defineProps<{ nodes: Node[]; showPause?: boolean; label: string }>(), { showPause: false });
const selected = defineModel<string[]>({ required: true });
const paused = defineModel<string[]>("paused", { default: () => [] });

const { t } = useI18n();
const query = ref("");

const groups = computed(() => {
  const q = query.value.trim().toLowerCase();
  const list = props.nodes
    .filter((n) => !q || `${n.name} ${n.id} ${n.geo?.country ?? ""}`.toLowerCase().includes(q) || selected.value.includes(n.id))
    .sort((a, b) => regionRank(regionOf(a.geo?.country)) - regionRank(regionOf(b.geo?.country)) || (a.name || a.id).localeCompare(b.name || b.id));
  const out: { region: RegionKey; nodes: Node[] }[] = [];
  for (const node of list) {
    const region = regionOf(node.geo?.country);
    const last = out[out.length - 1];
    if (last && last.region === region) last.nodes.push(node);
    else out.push({ region, nodes: [node] });
  }
  return out;
});

/** Chosen ids no longer in the node list (deleted, or this session cannot read them) still show, by id. */
const unknownChosen = computed(() => selected.value.filter((id) => !props.nodes.some((n) => n.id === id)));

function toggle(id: string, on: boolean): void {
  const has = selected.value.includes(id);
  if (on && !has) selected.value = [...selected.value, id].sort();
  if (!on && has) {
    selected.value = selected.value.filter((x) => x !== id);
    paused.value = paused.value.filter((x) => x !== id);
  }
}

function togglePause(id: string, on: boolean): void {
  const has = paused.value.includes(id);
  if (on && !has) paused.value = [...paused.value, id].sort();
  if (!on && has) paused.value = paused.value.filter((x) => x !== id);
}
</script>

<template>
  <div class="grid gap-2">
    <div class="flex items-center gap-2">
      <div class="relative flex-1">
        <Search class="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input v-model="query" class="ps-8" :placeholder="t('fleet.monitoring.checks.editor.searchNodes')" :aria-label="t('fleet.monitoring.checks.editor.searchNodes')" />
      </div>
      <span class="shrink-0 text-xs text-muted-foreground tabular" data-testid="source-count">{{ t('fleet.monitoring.checks.editor.chosen', { n: selected.length }) }}</span>
    </div>
    <div class="max-h-72 overflow-auto rounded-md border border-border" role="group" :aria-label="label" data-testid="source-picker">
      <template v-for="group in groups" :key="group.region">
        <p class="sticky top-0 z-[1] bg-muted px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {{ t(`fleet.monitoring.topology.region.${group.region}`) }}
        </p>
        <div v-for="node in group.nodes" :key="node.id" class="flex items-center gap-2 border-b border-border/60 px-2.5 last:border-b-0">
          <label class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5 pointer-coarse:min-h-11">
            <Checkbox :model-value="selected.includes(node.id)" @update:model-value="(v) => toggle(node.id, v === true)" />
            <span class="min-w-0 flex-1 truncate text-sm" :title="node.name || node.id">{{ node.name || node.id }}</span>
            <span :class="cn('shrink-0 text-xs', node.online ? 'text-muted-foreground' : 'text-warning-text')">{{ node.online ? t('fleet.monitoring.result.on') : t('fleet.monitoring.result.off') }}</span>
          </label>
          <label
            v-if="showPause && selected.includes(node.id)"
            class="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground pointer-coarse:min-h-11"
          >
            <Checkbox :model-value="paused.includes(node.id)" :aria-label="t('fleet.monitoring.checks.editor.pauseSource', { name: node.name || node.id })" @update:model-value="(v) => togglePause(node.id, v === true)" />
            {{ t('fleet.monitoring.checks.editor.paused') }}
          </label>
        </div>
      </template>
      <div v-for="id in unknownChosen" :key="id" class="flex items-center gap-2 border-b border-border/60 px-2.5 py-1.5 last:border-b-0">
        <Checkbox :model-value="true" @update:model-value="(v) => toggle(id, v === true)" />
        <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ id }}</span>
      </div>
      <p v-if="groups.length === 0 && unknownChosen.length === 0" class="px-3 py-4 text-center text-xs text-muted-foreground">{{ t('fleet.monitoring.checks.editor.noNodes') }}</p>
    </div>
  </div>
</template>
