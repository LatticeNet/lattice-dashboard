<script setup lang="ts">
/**
 * One control for every target field (design 32 D5): explicit nodes, node
 * groups, the whole fleet, and nodes to leave out, with a live line that says
 * how many nodes the choice resolves to and lists them one click away.
 *
 * Built from the path set's source picker (SourcePicker): searchable,
 * multi-select, nodes grouped by region. Groups sit above the nodes; a node a
 * chosen group or the whole fleet already covers says so and offers "Leave
 * out" instead of a second tick. The chips row on top is the choice at a
 * glance and the quickest way to drop part of it.
 *
 * The value is the stored selector shape (selectorModel.normalizeSelector),
 * so a caller sends it as is. Resolution here is over what this session can
 * see; the server resolves again when it uses the selector.
 *
 * Props: `nodes` and `groups` are the visible fleet (groups carry their
 * resolved members); `label` names the field for assistive technology;
 * `allowGroups` and `allowFleet` turn those choices off, with
 * `restrictedReason` saying why (a token confined to some nodes may name only
 * nodes, the rule design 32 D1 sets for stored selectors); `notes` maps a node
 * id to one short line shown under that node in the warning tone, for what
 * the caller knows about it (a check source whose agent cannot run the chosen
 * method, for example). Nodes without a note look as before.
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Minus, Search, X } from "lucide-vue-next";

import type { Node } from "@/lib/api";
import { regionOf, regionRank, type RegionKey } from "@/lib/regions";
import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import GroupChip from "@/components/networking/GroupChip.vue";

import {
  coverageMap,
  nodeSearchText,
  normalizeSelector,
  onlyMatch,
  resolveSelector,
  selectorParts,
  setWholeFleet,
  toggleExclude,
  toggleGroup,
  toggleNode,
  type SelectorGroup,
  type SelectorPart,
  type TargetSelector,
} from "./selectorModel";

type PickerGroup = SelectorGroup & { color?: string };

const props = withDefaults(
  defineProps<{
    nodes: Node[];
    groups: PickerGroup[];
    label: string;
    allowGroups?: boolean;
    allowFleet?: boolean;
    restrictedReason?: string;
    idPrefix?: string;
    notes?: Record<string, string>;
  }>(),
  { allowGroups: true, allowFleet: true, restrictedReason: "", idPrefix: "selector", notes: () => ({}) },
);
const model = defineModel<TargetSelector>({ required: true });

const { t } = useI18n();
const query = ref("");
const showResolved = ref(false);

const value = computed(() => normalizeSelector(model.value ?? {}));
function emit(next: TargetSelector): void {
  model.value = normalizeSelector(next);
}

/** The picks the whole fleet replaced, so turning it off again restores them. */
const beforeFleet = ref<TargetSelector>({});
watch(
  () => value.value.all,
  (all) => {
    if (!all) beforeFleet.value = {};
  },
);
function setFleet(on: boolean): void {
  if (on) beforeFleet.value = { nodes: value.value.nodes, groups: value.value.groups };
  emit(setWholeFleet(value.value, on, beforeFleet.value));
}

const groupById = computed(() => new Map(props.groups.map((g) => [g.id, g])));
const resolved = computed(() => resolveSelector(value.value, props.nodes, props.groups));
const parts = computed(() => selectorParts(value.value, props.nodes, props.groups));

const shownGroups = computed(() => {
  if (!props.allowGroups) return [];
  const q = query.value.trim().toLowerCase();
  const chosen = value.value.groups ?? [];
  return [...props.groups]
    .filter((g) => !q || g.name.toLowerCase().includes(q) || chosen.includes(g.id))
    .sort((a, b) => a.name.localeCompare(b.name));
});

const regions = computed(() => {
  const q = query.value.trim().toLowerCase();
  const keep = new Set([...(value.value.nodes ?? []), ...(value.value.exclude ?? [])]);
  const list = props.nodes
    .filter((n) => !q || nodeSearchText(n).includes(q) || keep.has(n.id))
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

/** Chosen ids this session cannot see (deleted, or outside its reach): still listed, by id. */
const visibleIds = computed(() => new Set(props.nodes.map((n) => n.id)));
const unseen = computed(() => [...(value.value.nodes ?? []), ...(value.value.exclude ?? [])].filter((id) => !visibleIds.value.has(id)));

/** Every visible node's coverage, computed once per change rather than per row and per read. */
const coverage = computed(() => coverageMap(value.value, props.nodes, props.groups));
const NO_COVERAGE = { explicit: false, via: [], fleet: false, excluded: false, targeted: false };
function coverageOf(node: Node) {
  return coverage.value.get(node.id) ?? NO_COVERAGE;
}

/** A node a group or the fleet already covers is ticked by that, not by itself. */
function coveredElsewhere(node: Node): boolean {
  const c = coverageOf(node);
  return !c.explicit && (c.fleet || c.via.length > 0);
}

function noteOf(node: Node): string {
  const c = coverageOf(node);
  if (c.excluded) return t("selector.leftOut");
  if (c.explicit) return "";
  if (c.fleet) return t("selector.viaFleet");
  if (c.via.length) return t("selector.via", { groups: c.via.map((id) => groupById.value.get(id)?.name ?? id).join(", ") });
  return "";
}

/** The ids of the lines that describe a node's row, for aria-describedby. */
function describedBy(node: Node): string | undefined {
  const ids: string[] = [];
  if (noteOf(node)) ids.push(`${props.idPrefix}-note-${node.id}`);
  if (props.notes[node.id]) ids.push(`${props.idPrefix}-warn-${node.id}`);
  return ids.length ? ids.join(" ") : undefined;
}

function partLabel(part: SelectorPart): string {
  switch (part.kind) {
    case "fleet":
      return t("selector.wholeFleet");
    case "exclude":
      return t("selector.except", { name: part.name });
    default:
      return part.name;
  }
}

function removePart(part: SelectorPart): void {
  switch (part.kind) {
    case "fleet":
      setFleet(false);
      return;
    case "group":
      emit(toggleGroup(value.value, part.id, false));
      return;
    case "node":
      emit(toggleNode(value.value, part.id, false));
      return;
    case "exclude":
      emit(toggleExclude(value.value, part.id, false));
  }
}

function nodeName(id: string): string {
  return props.nodes.find((n) => n.id === id)?.name || id;
}

function groupMemberCount(group: PickerGroup): number {
  return group.resolved_members.filter((id) => visibleIds.value.has(id)).length;
}

/**
 * Enter in the search box picks the only match and clears the search. It
 * never reaches a form around the picker, which would save a half-made
 * target (design review of S3a).
 */
function pickOnlyMatch(): void {
  const hit = onlyMatch(query.value, props.nodes, props.groups, props.allowGroups);
  if (!hit) return;
  if (hit.kind === "group") {
    if (!value.value.all && !(value.value.groups ?? []).includes(hit.id)) emit(toggleGroup(value.value, hit.id, true));
  } else {
    const node = props.nodes.find((n) => n.id === hit.id);
    if (node && !coverageOf(node).explicit && !coveredElsewhere(node)) emit(toggleNode(value.value, hit.id, true));
  }
  query.value = "";
}

const resolvedId = computed(() => `${props.idPrefix}-resolved`);
const nothingVisible = computed(() => shownGroups.value.length === 0 && regions.value.length === 0 && unseen.value.length === 0);
</script>

<template>
  <div class="grid gap-2" data-testid="selector-picker">
    <!-- The choice at a glance; each chip drops its part. -->
    <ul class="flex min-h-7 flex-wrap items-center gap-1.5" :aria-label="t('selector.chosenLabel', { field: label })">
      <li v-for="part in parts" :key="`${part.kind}:${'id' in part ? part.id : ''}`" class="max-w-full">
        <span
          :class="cn(
            'inline-flex max-w-full items-center gap-1 rounded-full border py-0.5 pe-1 ps-2 text-xs font-medium',
            part.kind === 'exclude' ? 'border-dashed border-border text-muted-foreground' : 'border-border bg-muted/40',
          )"
          :data-part="part.kind"
        >
          <Minus v-if="part.kind === 'exclude'" class="size-3 shrink-0" aria-hidden="true" />
          <GroupChip v-if="part.kind === 'group'" :name="part.name" :color="groupById.get(part.id)?.color" class="text-xs" />
          <span v-else class="truncate">{{ partLabel(part) }}</span>
          <button
            type="button"
            class="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:size-7"
            :aria-label="t('selector.remove', { name: partLabel(part) })"
            @click="removePart(part)"
          >
            <X class="size-3" aria-hidden="true" />
          </button>
        </span>
      </li>
      <li v-if="parts.length === 0" class="text-xs text-muted-foreground">{{ t('selector.nothingChosen') }}</li>
    </ul>

    <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
      <label
        :class="cn(
          'flex h-9 shrink-0 items-center gap-2 rounded-md border border-input px-3 text-sm',
          allowFleet ? 'cursor-pointer' : 'cursor-not-allowed text-muted-foreground',
        )"
      >
        <Checkbox
          :model-value="value.all === true"
          :disabled="!allowFleet"
          :aria-describedby="!allowFleet && restrictedReason ? `${idPrefix}-restricted` : undefined"
          data-testid="selector-fleet"
          @update:model-value="(v) => setFleet(v === true)"
        />
        {{ t('selector.wholeFleet') }}
      </label>
      <div class="relative flex-1">
        <Search class="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          v-model="query"
          class="ps-8"
          @keydown.enter.prevent="pickOnlyMatch"
          :placeholder="allowGroups ? t('selector.searchGroupsAndNodes') : t('selector.searchNodes')"
          :aria-label="allowGroups ? t('selector.searchGroupsAndNodes') : t('selector.searchNodes')"
        />
      </div>
    </div>

    <div class="max-h-72 overflow-auto rounded-md border border-border" role="group" :aria-label="label">
      <template v-if="shownGroups.length">
        <p class="sticky top-0 z-[1] bg-muted px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {{ t('selector.groupsHeading') }}
        </p>
        <label
          v-for="group in shownGroups"
          :key="group.id"
          :class="cn(
            'flex items-center gap-2 border-b border-border/60 px-2.5 py-1.5 pointer-coarse:min-h-11',
            value.all ? 'cursor-not-allowed text-muted-foreground' : 'cursor-pointer',
          )"
          :data-group="group.id"
        >
          <Checkbox
            :model-value="(value.groups ?? []).includes(group.id)"
            :disabled="value.all === true"
            @update:model-value="(v) => emit(toggleGroup(value, group.id, v === true))"
          />
          <GroupChip :name="group.name" :color="group.color" class="min-w-0 flex-1" />
          <span class="shrink-0 text-xs text-muted-foreground tabular">{{ t('selector.groupNodes', { n: groupMemberCount(group) }, groupMemberCount(group)) }}</span>
        </label>
      </template>

      <template v-for="region in regions" :key="region.region">
        <p class="sticky top-0 z-[1] bg-muted px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {{ t(`fleet.monitoring.topology.region.${region.region}`) }}
        </p>
        <div
          v-for="node in region.nodes"
          :key="node.id"
          class="flex items-center gap-2 border-b border-border/60 px-2.5 last:border-b-0"
          :data-node="node.id"
          :data-covered="coveredElsewhere(node) ? 'true' : undefined"
          :data-excluded="coverageOf(node).excluded ? 'true' : undefined"
        >
          <label :class="cn('flex min-w-0 flex-1 items-center gap-2 py-1.5 pointer-coarse:min-h-11', coveredElsewhere(node) ? 'cursor-default' : 'cursor-pointer')">
            <Checkbox
              :model-value="coverageOf(node).targeted"
              :disabled="coveredElsewhere(node)"
              :aria-describedby="describedBy(node)"
              @update:model-value="(v) => emit(toggleNode(value, node.id, v === true))"
            />
            <span class="min-w-0 flex-1">
              <span :class="cn('block truncate text-sm', coverageOf(node).excluded && 'text-muted-foreground line-through')" :title="node.name || node.id">{{ node.name || node.id }}</span>
              <span v-if="noteOf(node)" :id="`${idPrefix}-note-${node.id}`" class="block truncate text-xs text-muted-foreground">{{ noteOf(node) }}</span>
              <span v-if="notes[node.id]" :id="`${idPrefix}-warn-${node.id}`" class="block text-xs text-warning-text wrap-anywhere" :data-note="node.id">{{ notes[node.id] }}</span>
            </span>
          </label>
          <label
            v-if="coveredElsewhere(node) || coverageOf(node).excluded"
            class="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground pointer-coarse:min-h-11"
          >
            <Checkbox
              :model-value="coverageOf(node).excluded"
              :aria-label="t('selector.leaveOutNode', { name: node.name || node.id })"
              @update:model-value="(v) => emit(toggleExclude(value, node.id, v === true))"
            />
            {{ t('selector.leaveOut') }}
          </label>
        </div>
      </template>

      <div v-for="id in unseen" :key="id" class="flex items-center gap-2 border-b border-border/60 px-2.5 py-1.5 last:border-b-0" :data-node="id">
        <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ id }}</span>
        <span class="shrink-0 text-xs text-muted-foreground">{{ t('selector.unseen') }}</span>
      </div>
      <p v-if="nothingVisible" class="px-3 py-4 text-center text-xs text-muted-foreground">{{ t('selector.noMatch') }}</p>
    </div>

    <p v-if="restrictedReason && (!allowGroups || !allowFleet)" :id="`${idPrefix}-restricted`" class="text-xs text-muted-foreground">
      {{ restrictedReason }}
    </p>

    <!-- The live answer to "which nodes is that", one click from the list. -->
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" aria-live="polite">
      <span :class="cn('tabular', resolved.length === 0 && 'text-warning-text')" data-testid="selector-resolves">
        {{ t('selector.resolves', { n: resolved.length }, resolved.length) }}
      </span>
      <button
        v-if="resolved.length > 0"
        type="button"
        class="text-xs text-primary underline-offset-4 outline-none hover:underline focus-visible:underline pointer-coarse:min-h-11"
        :aria-expanded="showResolved"
        :aria-controls="resolvedId"
        @click="showResolved = !showResolved"
      >
        {{ showResolved ? t('selector.hideNodes') : t('selector.showNodes') }}
      </button>
    </div>
    <ul
      v-if="showResolved && resolved.length > 0"
      :id="resolvedId"
      class="flex max-h-40 flex-wrap gap-x-3 gap-y-1 overflow-auto rounded-md border border-border px-3 py-2 text-xs"
    >
      <li v-for="id in resolved" :key="id" class="max-w-full truncate">{{ nodeName(id) }}</li>
    </ul>
  </div>
</template>
