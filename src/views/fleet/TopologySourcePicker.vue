<script setup lang="ts">
/**
 * Topology's source picker (design 29 D13): which sources draw their fan.
 * Every path set source is listed in the path set's order with its reach
 * counts (up, degraded, down of its paths), so the operator picks the ones
 * worth drawing; the control reads "4 of 9 sources". The choice lives in
 * ?topo.sources= (the layer writes it); the menu stays open while ticking, and
 * the last drawn source cannot be unticked, so the drawing is never empty.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Check, ChevronDown } from "lucide-vue-next";
import { DropdownMenuCheckboxItem, DropdownMenuItemIndicator } from "reka-ui";

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

import { DEFAULT_DRAWN_SOURCES, formatDrawnSources, type TopoSourceChoice } from "./topologyModel";

const props = defineProps<{ choices: TopoSourceChoice[] }>();
const emit = defineEmits<{ update: [ids: string[]] }>();

const { t } = useI18n();

const drawn = computed(() => props.choices.filter((c) => c.drawn).map((c) => c.node.id));
const isDefault = computed(() => formatDrawnSources(drawn.value, props.choices.slice(0, DEFAULT_DRAWN_SOURCES).map((c) => c.node.id)) === undefined);

function toggle(id: string, on: boolean): void {
  const next = on ? [...drawn.value, id] : drawn.value.filter((x) => x !== id);
  if (next.length === 0) return;
  emit("update", props.choices.map((c) => c.node.id).filter((x) => next.includes(x)));
}

/** The source's reach, each count in its own state's ink, so only the counts that need a look carry colour. */
function reach(choice: TopoSourceChoice): { key: string; text: string; tone: string }[] {
  const r = choice.reach;
  const parts = [{ key: "up", text: t("fleet.monitoring.topology.sources.reach", { up: r.up, total: r.total }), tone: "text-muted-foreground" }];
  if (r.degraded) parts.push({ key: "degraded", text: t("fleet.monitoring.topology.proof.degraded", { n: r.degraded }), tone: "text-warning-text" });
  if (r.down) parts.push({ key: "down", text: t("fleet.monitoring.topology.proof.down", { n: r.down }), tone: "text-destructive" });
  return parts;
}
</script>

<template>
  <DropdownMenu :modal="false">
    <DropdownMenuTrigger as-child>
      <button
        type="button"
        class="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
        data-testid="topology-sources"
      >
        {{ $t('fleet.monitoring.topology.sources.control', { shown: drawn.length, total: choices.length }) }}
        <ChevronDown class="size-3.5 text-muted-foreground" aria-hidden="true" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" class="w-80 max-w-[calc(100vw-2rem)]">
      <DropdownMenuLabel class="text-xs font-medium text-muted-foreground">{{ $t('fleet.monitoring.topology.sources.title') }}</DropdownMenuLabel>
      <DropdownMenuCheckboxItem
        v-for="choice in choices"
        :key="choice.node.id"
        :model-value="choice.drawn"
        :disabled="choice.drawn && drawn.length === 1"
        class="relative flex min-h-9 cursor-default items-start gap-2 rounded-sm py-1.5 ps-8 pe-2 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:opacity-60 pointer-coarse:min-h-11"
        :data-source="choice.node.id"
        @select="(e: Event) => e.preventDefault()"
        @update:model-value="(on: boolean | 'indeterminate') => toggle(choice.node.id, on === true)"
      >
        <span class="absolute start-2 top-2 flex size-4 items-center justify-center">
          <DropdownMenuItemIndicator><Check class="size-4" aria-hidden="true" /></DropdownMenuItemIndicator>
        </span>
        <span class="min-w-0 flex-1">
          <span class="block truncate">
            <span v-if="choice.drawn" class="me-1 font-mono text-[10px] text-muted-foreground tabular">{{ drawn.indexOf(choice.node.id) + 1 }}</span>{{ choice.node.name }}
          </span>
          <span class="block text-xs">
            <template v-for="(part, i) in reach(choice)" :key="part.key"><span v-if="i" class="text-muted-foreground"> · </span><span :class="part.tone">{{ part.text }}</span></template>
          </span>
        </span>
      </DropdownMenuCheckboxItem>
      <template v-if="!isDefault">
        <DropdownMenuSeparator />
        <DropdownMenuItem data-testid="topology-sources-default" @select="emit('update', [])">{{ $t('fleet.monitoring.topology.sources.reset', { n: Math.min(DEFAULT_DRAWN_SOURCES, choices.length) }) }}</DropdownMenuItem>
      </template>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
