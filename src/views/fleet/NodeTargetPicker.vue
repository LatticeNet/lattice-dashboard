<script setup lang="ts">
/**
 * A node as a check's target (design 29 D9, D11): one choice from the nodes
 * grouped by region, each showing what it resolves to for the method (its
 * public IPv4 for ICMP, its public TCP line port for TCP). A node that
 * cannot be resolved for the method cannot be picked, with the reason; one
 * already chosen stays chosen so the editor can say why the save is refused.
 */
import { computed, ref, useId } from "vue";
import { useI18n } from "vue-i18n";
import { Search } from "lucide-vue-next";

import type { LatencyProbeNode, Node } from "@/lib/api";
import { regionOf, regionRank, type RegionKey } from "@/lib/regions";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

import { resolveNodeTarget, type NodeTargetResolution } from "./checksModel";
import { useTargetCopy } from "./checksCopy";

const props = defineProps<{
  nodes: Node[];
  kind: string;
  /** The path set plan's nodes, by id: the server's own resolution for the nodes it targets. */
  planNodes: Map<string, LatencyProbeNode>;
  label: string;
}>();
const selected = defineModel<string>({ required: true });

const { t } = useI18n();
const { resolutionText } = useTargetCopy();
const query = ref("");

function resolution(node: Node): NodeTargetResolution {
  return resolveNodeTarget(props.kind, node, props.planNodes.get(node.id));
}

const groups = computed(() => {
  const q = query.value.trim().toLowerCase();
  const list = props.nodes
    .filter((n) => !q || `${n.name} ${n.id} ${n.geo?.country ?? ""} ${n.public_ip ?? ""}`.toLowerCase().includes(q) || n.id === selected.value)
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

/** A chosen id the node list does not hold (deleted, or not readable here). */
const unknownChosen = computed(() => (selected.value && !props.nodes.some((n) => n.id === selected.value) ? selected.value : ""));
const name = `target-node-${useId()}`;
</script>

<template>
  <div class="grid gap-2">
    <div class="relative">
      <Search class="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <Input v-model="query" class="ps-8" :placeholder="t('fleet.monitoring.checks.editor.searchNodes')" :aria-label="t('fleet.monitoring.checks.editor.searchNodes')" />
    </div>
    <div class="max-h-64 overflow-auto rounded-md border border-border" role="radiogroup" :aria-label="label" data-testid="target-node-picker">
      <template v-for="group in groups" :key="group.region">
        <p class="sticky top-0 z-[1] bg-muted px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {{ t(`fleet.monitoring.topology.region.${group.region}`) }}
        </p>
        <label
          v-for="node in group.nodes"
          :key="node.id"
          :class="
            cn(
              'flex items-center gap-2 border-b border-border/60 px-2.5 py-1.5 last:border-b-0 pointer-coarse:min-h-11',
              resolution(node).state === 'refused' && node.id !== selected ? 'cursor-not-allowed' : 'cursor-pointer',
              node.id === selected && 'bg-primary/10',
            )
          "
          :data-target-node="node.id"
        >
          <input
            type="radio"
            :name="name"
            class="accent-[var(--primary)]"
            :value="node.id"
            :checked="node.id === selected"
            :disabled="resolution(node).state === 'refused' && node.id !== selected"
            :aria-describedby="`${name}-${node.id}`"
            @change="selected = node.id"
          />
          <span class="min-w-0 flex-1">
            <span :class="cn('block truncate text-sm', resolution(node).state === 'refused' && node.id !== selected && 'text-muted-foreground')" :title="node.name || node.id">
              {{ node.name || node.id }}
              <span v-if="node.geo?.country" class="ms-1 font-mono text-xs text-muted-foreground">{{ node.geo.country }}</span>
            </span>
            <span
              :id="`${name}-${node.id}`"
              :class="cn('block text-xs break-words', resolution(node).state === 'resolved' ? 'font-mono text-muted-foreground' : resolution(node).state === 'refused' && node.id === selected ? 'text-destructive' : 'text-muted-foreground')"
            >{{ resolutionText(kind, resolution(node)) }}</span>
          </span>
        </label>
      </template>
      <p v-if="unknownChosen" class="px-2.5 py-1.5 font-mono text-xs">{{ unknownChosen }}</p>
      <p v-if="groups.length === 0 && !unknownChosen" class="px-3 py-4 text-center text-xs text-muted-foreground">{{ t('fleet.monitoring.checks.editor.noNodes') }}</p>
    </div>
  </div>
</template>
