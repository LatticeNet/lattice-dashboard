<script setup lang="ts">
/**
 * The target selector (design 32 D5): one control for every target field.
 * It edits the stored shape `{ nodes, groups, all, exclude }`: chips for what
 * is chosen, a whole-fleet switch, node groups, and the nodes by region with
 * a search, the picker the live walk singled out to keep. A node a group or
 * the whole fleet covers reads "via" that, and turning it off excludes it.
 * Under the list, a live line says how many nodes it resolves to, with the
 * names one click away.
 *
 * `allowBroad` false (a token with a node allowlist) offers named nodes
 * only, as the server would refuse a group or the whole fleet.
 */
import { computed, ref, useId } from "vue";
import { useI18n } from "vue-i18n";
import { Search, X } from "lucide-vue-next";

import type { GroupView, Node, TargetSelector } from "@/lib/api";
import { regionOf, regionRank, type RegionKey } from "@/lib/regions";
import { resolveTargetSelector, selectorCover, setSelectorAll, toggleSelectorGroup, toggleSelectorNode } from "@/lib/targetSelector";
import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

const props = withDefaults(
  defineProps<{
    nodes: Node[];
    groups: GroupView[];
    label: string;
    /** Groups and the whole fleet may be chosen (a token with no node allowlist). */
    allowBroad?: boolean;
    /** A note per node id that flags it (say, its agent cannot run the method); the node stays choosable. */
    notes?: Record<string, string>;
    /** Node ids never offered (say, the only source of a check to itself). */
    hidden?: string[];
  }>(),
  { allowBroad: true, notes: () => ({}), hidden: () => [] },
);
const model = defineModel<TargetSelector>({ required: true });

const { t } = useI18n();
const uid = useId();
const query = ref("");
const showResolved = ref(false);

/** The groups worth offering: the operator's own, not the built-in Ungrouped. */
const offeredGroups = computed(() => props.groups.filter((g) => !g.system).sort((a, b) => a.name.localeCompare(b.name)));
const nodeById = computed(() => new Map(props.nodes.map((n) => [n.id, n])));
const groupById = computed(() => new Map(props.groups.map((g) => [g.id, g])));

const resolved = computed(() => resolveTargetSelector(model.value, props.nodes, props.groups));
const resolvedSet = computed(() => new Set(resolved.value));

function nodeName(id: string): string {
  return nodeById.value.get(id)?.name || id;
}
function groupName(id: string): string {
  return groupById.value.get(id)?.name || id;
}

/* ---- Chips: what is chosen, each removable ---- */

interface Chip {
  key: string;
  label: string;
  kind: "all" | "group" | "node" | "exclude";
  remove: () => void;
}

const chips = computed<Chip[]>(() => {
  const sel = model.value;
  const out: Chip[] = [];
  if (sel.all) out.push({ key: "all", kind: "all", label: t("common.selector.wholeFleet"), remove: () => setAll(false) });
  for (const id of sel.groups ?? []) {
    const n = groupById.value.get(id)?.resolved_members?.length;
    out.push({
      key: `g:${id}`,
      kind: "group",
      label: n === undefined ? groupName(id) : t("common.selector.groupChip", { name: groupName(id), n }, n),
      remove: () => (model.value = toggleSelectorGroup(model.value, id, false, props.groups)),
    });
  }
  for (const id of sel.nodes ?? []) out.push({ key: `n:${id}`, kind: "node", label: nodeName(id), remove: () => (model.value = toggleSelectorNode(model.value, id, false, props.groups)) });
  for (const id of sel.exclude ?? []) {
    out.push({ key: `x:${id}`, kind: "exclude", label: t("common.selector.exceptChip", { name: nodeName(id) }), remove: () => (model.value = toggleSelectorNode(model.value, id, true, props.groups)) });
  }
  return out;
});

/* ---- The list ---- */

const matches = (text: string) => {
  const q = query.value.trim().toLowerCase();
  return !q || text.toLowerCase().includes(q);
};

const shownGroups = computed(() => (props.allowBroad ? offeredGroups.value.filter((g) => matches(`${g.name} ${g.slug}`) || (model.value.groups ?? []).includes(g.id)) : []));

const regions = computed(() => {
  const hidden = new Set(props.hidden);
  const list = props.nodes
    .filter((n) => !hidden.has(n.id) && (matches(`${n.name} ${n.id} ${n.geo?.country ?? ""}`) || resolvedSet.value.has(n.id)))
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

/** Named ids with no node (deleted, or this session cannot read them) still show, so they can be removed. */
const unknownNamed = computed(() => [...(model.value.nodes ?? []), ...(model.value.exclude ?? [])].filter((id) => !nodeById.value.has(id)));

/** What a node row says under its name: why it is in the set, that it is excluded, or the caller's note. */
function coverText(node: Node): string | undefined {
  const cover = selectorCover({ ...model.value, nodes: [] }, node.id, props.groups);
  const excluded = (model.value.exclude ?? []).includes(node.id);
  if (excluded) return t("common.selector.excluded");
  if (!cover || (model.value.nodes ?? []).includes(node.id)) return undefined;
  return cover.by === "all" ? t("common.selector.viaFleet") : t("common.selector.viaGroup", { name: groupName(cover.by === "group" ? cover.groupId : "") });
}

function setAll(all: boolean): void {
  model.value = setSelectorAll(model.value, all, props.groups);
}
function toggleNode(id: string, on: boolean): void {
  model.value = toggleSelectorNode(model.value, id, on, props.groups);
}
function toggleGroup(id: string, on: boolean): void {
  model.value = toggleSelectorGroup(model.value, id, on, props.groups);
}

const resolvedNames = computed(() => resolved.value.map(nodeName).sort((a, b) => a.localeCompare(b)));
</script>

<template>
  <div class="grid min-w-0 gap-2" :data-testid="`selector-${uid}`">
    <!-- What is chosen, each removable. -->
    <ul v-if="chips.length" class="flex flex-wrap gap-1.5" :aria-label="t('common.selector.chosen', { field: label })">
      <li v-for="chip in chips" :key="chip.key">
        <button
          type="button"
          :class="
            cn(
              'inline-flex max-w-full items-center gap-1 rounded-sm border px-2 py-0.5 text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11',
              chip.kind === 'exclude' ? 'border-dashed border-border text-muted-foreground' : 'border-primary/40 bg-primary/10 font-medium text-foreground',
            )
          "
          :aria-label="t('common.selector.remove', { name: chip.label })"
          :data-chip="chip.kind"
          @click="chip.remove"
        >
          <span class="truncate">{{ chip.label }}</span>
          <X class="size-3 shrink-0" aria-hidden="true" />
        </button>
      </li>
    </ul>

    <label v-if="allowBroad" class="flex cursor-pointer items-start gap-2.5 pointer-coarse:min-h-11">
      <Checkbox class="mt-0.5" :model-value="!!model.all" data-testid="selector-all" @update:model-value="(v) => setAll(v === true)" />
      <span class="min-w-0">
        <span class="block text-sm">{{ t('common.selector.wholeFleet') }}</span>
        <span class="block text-xs text-muted-foreground">{{ t('common.selector.wholeFleetHint') }}</span>
      </span>
    </label>
    <p v-else class="text-xs text-muted-foreground" data-testid="selector-narrow">{{ t('common.selector.nodesOnly') }}</p>

    <div class="relative">
      <Search class="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <Input v-model="query" class="ps-8" :placeholder="allowBroad ? t('common.selector.search') : t('common.selector.searchNodes')" :aria-label="t('common.selector.searchLabel', { field: label })" />
    </div>

    <div class="max-h-72 overflow-auto rounded-md border border-border" role="group" :aria-label="label">
      <template v-if="shownGroups.length">
        <p class="sticky top-0 z-[1] bg-muted px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{{ t('common.selector.groups') }}</p>
        <label
          v-for="group in shownGroups"
          :key="group.id"
          class="flex cursor-pointer items-center gap-2 border-b border-border/60 px-2.5 py-1.5 pointer-coarse:min-h-11"
          :data-group="group.id"
        >
          <Checkbox :model-value="(model.groups ?? []).includes(group.id)" @update:model-value="(v) => toggleGroup(group.id, v === true)" />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm">{{ group.name }}</span>
            <span class="block text-xs text-muted-foreground">
              {{ t('common.selector.groupMembers', { n: group.resolved_members?.length ?? 0 }, group.resolved_members?.length ?? 0) }}<template v-if="group.selector"> · {{ t('common.selector.groupFollows') }}</template>
            </span>
          </span>
        </label>
      </template>
      <template v-for="block in regions" :key="block.region">
        <p class="sticky top-0 z-[1] bg-muted px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {{ t(`fleet.monitoring.topology.region.${block.region}`) }}
        </p>
        <label
          v-for="node in block.nodes"
          :key="node.id"
          class="flex cursor-pointer items-center gap-2 border-b border-border/60 px-2.5 py-1.5 last:border-b-0 pointer-coarse:min-h-11"
          :data-node="node.id"
        >
          <Checkbox
            :model-value="resolvedSet.has(node.id)"
            :aria-describedby="coverText(node) || notes[node.id] ? `${uid}-why-${node.id}` : undefined"
            @update:model-value="(v) => toggleNode(node.id, v === true)"
          />
          <span class="min-w-0 flex-1">
            <span :class="cn('block truncate text-sm', !resolvedSet.has(node.id) && coverText(node) && 'text-muted-foreground')" :title="node.name || node.id">{{ node.name || node.id }}</span>
            <span v-if="coverText(node) || notes[node.id]" :id="`${uid}-why-${node.id}`" class="flex flex-wrap gap-x-2 text-xs">
              <span v-if="coverText(node)" class="text-muted-foreground">{{ coverText(node) }}</span>
              <span v-if="notes[node.id]" :class="resolvedSet.has(node.id) ? 'text-warning-text' : 'text-muted-foreground'">{{ notes[node.id] }}</span>
            </span>
          </span>
          <span :class="cn('shrink-0 text-xs', node.online ? 'text-muted-foreground' : 'text-warning-text')">{{ node.online ? t('fleet.monitoring.checks.editor.online') : t('fleet.monitoring.checks.editor.offline') }}</span>
        </label>
      </template>
      <div v-for="id in unknownNamed" :key="id" class="flex items-center gap-2 border-b border-border/60 px-2.5 py-1.5 last:border-b-0">
        <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ id }}</span>
        <span class="text-xs text-muted-foreground">{{ t('common.selector.unknownNode') }}</span>
      </div>
      <p v-if="!shownGroups.length && !regions.length && !unknownNamed.length" class="px-3 py-4 text-center text-xs text-muted-foreground">{{ t('common.selector.noMatch') }}</p>
    </div>

    <!-- The live line: what the selector resolves to now, the names one click away. -->
    <p class="flex flex-wrap items-baseline gap-x-2 text-xs" aria-live="polite" data-testid="selector-resolves">
      <span :class="resolved.length ? 'text-foreground' : 'text-muted-foreground'">{{ t('common.selector.resolves', { n: resolved.length }, resolved.length) }}</span>
      <button
        v-if="resolved.length"
        type="button"
        class="font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground pointer-coarse:min-h-11"
        :aria-expanded="showResolved"
        :aria-controls="`${uid}-resolved`"
        @click="showResolved = !showResolved"
      >{{ showResolved ? t('common.selector.hideNames') : t('common.selector.showNames') }}</button>
    </p>
    <p v-if="showResolved && resolved.length" :id="`${uid}-resolved`" class="rounded-md bg-muted/40 p-2.5 text-xs break-words">{{ resolvedNames.join(', ') }}</p>
  </div>
</template>
