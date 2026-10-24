<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { ArrowRight, Check, Circle, Contrast, Minus, X } from "lucide-vue-next";
import type { MatrixCell, MatrixGroup, NetPolicyMatrix } from "@/lib/api";
import GroupChip from "./GroupChip.vue";
import PolicyMatrixCell from "./PolicyMatrixCell.vue";
import { rowExclusions, shownNames, type RowExclusions } from "./policyMatrixModel";
import { Badge } from "@/components/ui/badge";

/**
 * Reachability matrix: rows = source groups, columns = destination groups.
 * Each cell shows whether the source group is allowed to reach the destination
 * (see PolicyMatrixCell for the glyph legend). A trailing column rolls up each
 * source group's rules that target endpoints OUTSIDE any group (cidr / domain /
 * any / external node). Outbound only: group policy compiles no inbound
 * rules (design 32 D7), so the matrix offers no direction.
 *
 * A row header names the members a policy excludes from it, and policies
 * that target the whole fleet get a read-only row of their own, after the
 * group rows (design 32 S3b): a cell is never read as the whole group's when
 * some members are left out.
 */
const props = withDefaults(
  defineProps<{
    matrix: NetPolicyMatrix;
    canAdmin?: boolean;
  }>(),
  { canAdmin: false },
);

const emit = defineEmits<{
  (e: "edit", source: MatrixGroup, dest: MatrixGroup): void;
}>();

const groups = computed(() => props.matrix.groups);

const cellMap = computed(() => {
  const m = new Map<string, MatrixCell>();
  for (const c of props.matrix.cells) m.set(`${c.from}::${c.to}`, c);
  return m;
});

function cellFor(from: string, to: string): MatrixCell | undefined {
  return cellMap.value.get(`${from}::${to}`);
}

const externalMap = computed(() => {
  const m = new Map<string, number>();
  for (const e of props.matrix.external) m.set(e.from, e.rule_count);
  return m;
});

function externalFor(from: string): number {
  return externalMap.value.get(from) ?? 0;
}

const { t } = useI18n();

const exclusionsByRow = computed(() => {
  const m = new Map<string, RowExclusions>();
  for (const g of groups.value) m.set(g.id, rowExclusions(props.matrix.exclusions, g.id));
  return m;
});

const fleet = computed(() => props.matrix.fleet);
const fleetExclusions = computed(() => rowExclusions(fleet.value?.exclusions));
const fleetCellMap = computed(() => {
  const m = new Map<string, MatrixCell>();
  for (const c of fleet.value?.cells ?? []) m.set(c.to, c);
  return m;
});

/** The short line under a row header: who is left out. */
function excludesText(row: RowExclusions | undefined): string {
  if (!row || row.names.length + row.hidden === 0) return "";
  const shown = shownNames(row);
  if (!shown.names.length) return t("networking.matrix.excludesHidden", { n: row.hidden }, row.hidden);
  const names = shown.names.join(", ");
  return shown.more ? t("networking.matrix.excludesMore", { nodes: names, n: shown.more }) : t("networking.matrix.excludes", { nodes: names });
}

/** The full sentence, per policy, for the title and screen readers. */
function excludesDetail(row: RowExclusions | undefined): string {
  if (!row) return "";
  return row.byPolicy
    .map((p) => {
      const parts = [...p.names];
      if (p.hidden) parts.push(t("networking.matrix.hiddenNodes", { n: p.hidden }, p.hidden));
      return t("networking.matrix.excludedBy", { policy: p.label, nodes: parts.join(", ") });
    })
    .join(" ");
}
</script>

<template>
  <div class="space-y-4">
    <!-- Controls + glyph legend -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <span class="text-sm text-muted-foreground">{{ $t("networking.matrix.outboundOnly") }}</span>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span class="inline-flex items-center gap-1"><Check class="size-3.5 text-success-text" aria-hidden="true" /> {{ $t("networking.matrix.legendAllow") }}</span>
        <span class="inline-flex items-center gap-1"><X class="size-3.5 text-destructive" aria-hidden="true" /> {{ $t("networking.matrix.legendDeny") }}</span>
        <span class="inline-flex items-center gap-1"><Contrast class="size-3.5 text-warning-text" aria-hidden="true" /> {{ $t("networking.matrix.legendMixed") }}</span>
        <span class="inline-flex items-center gap-1"><Minus class="size-3.5 text-muted-foreground" aria-hidden="true" /> {{ $t("networking.matrix.legendNone") }}</span>
        <span class="inline-flex items-center gap-1"><Circle class="size-3.5 text-muted-foreground" aria-hidden="true" /> {{ $t("networking.matrix.legendSelf") }}</span>
      </div>
    </div>

    <!-- Grid -->
    <div class="relative overflow-x-auto rounded-lg border border-border">
      <table class="w-full border-collapse text-sm">
        <thead>
          <tr class="bg-muted/40">
            <th
              scope="col"
              class="sticky left-0 z-10 min-w-[7rem] sm:min-w-[10rem] bg-muted/40 px-3 py-2 text-left text-xs font-medium text-muted-foreground"
            >
              <span class="inline-flex items-center gap-1">
                {{ $t("networking.matrix.sourceAxis") }}
                <ArrowRight class="size-3" aria-hidden="true" />
                {{ $t("networking.matrix.destAxis") }}
              </span>
            </th>
            <th
              v-for="dest in groups"
              :key="`col-${dest.id}`"
              scope="col"
              class="min-w-[5.5rem] border-l border-border px-2 py-2 text-center align-bottom"
            >
              <GroupChip :name="dest.name" :color="dest.color" class="justify-center" />
            </th>
            <th
              scope="col"
              class="min-w-[4.5rem] border-l border-border px-2 py-2 text-center text-xs font-medium text-muted-foreground"
              :title="$t('networking.matrix.externalHint')"
            >
              {{ $t("networking.matrix.externalCol") }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="src in groups" :key="`row-${src.id}`" class="border-t border-border">
            <th
              scope="row"
              class="sticky left-0 z-10 min-w-[7rem] sm:min-w-[10rem] bg-card px-3 py-2 text-left"
            >
              <GroupChip :name="src.name" :color="src.color" />
              <p
                v-if="excludesText(exclusionsByRow.get(src.id))"
                class="mt-0.5 max-w-[12rem] truncate text-xs font-normal text-warning-text"
                :title="excludesDetail(exclusionsByRow.get(src.id))"
                data-testid="matrix-row-exclusions"
              >
                {{ excludesText(exclusionsByRow.get(src.id)) }}
                <span class="sr-only">{{ excludesDetail(exclusionsByRow.get(src.id)) }}</span>
              </p>
            </th>
            <td v-for="dest in groups" :key="`cell-${src.id}-${dest.id}`" class="p-0 text-center">
              <PolicyMatrixCell
                :cell="cellFor(src.id, dest.id)"
                :is-self="src.id === dest.id"
                :editable="canAdmin"
                @edit="emit('edit', src, dest)"
              />
            </td>
            <td class="border-l border-border px-2 py-2 text-center">
              <Badge v-if="externalFor(src.id) > 0" variant="secondary" class="whitespace-nowrap tabular-nums" :title="$t('networking.matrix.externalHint')">
                {{ $t("networking.matrix.externalRules", { n: externalFor(src.id) }, externalFor(src.id)) }}
              </Badge>
              <span v-else class="text-muted-foreground">{{ $t("common.misc.none") }}</span>
            </td>
          </tr>
          <!-- Policies that target the whole fleet: read here, edited on the Policies layer. -->
          <tr v-if="fleet" class="border-t-2 border-border" data-testid="matrix-fleet-row">
            <th scope="row" class="sticky left-0 z-10 min-w-[7rem] sm:min-w-[10rem] bg-card px-3 py-2 text-left" :title="$t('networking.matrix.fleetRowHint')">
              <span class="text-sm font-medium">{{ $t("networking.matrix.fleetRow") }}</span>
              <p v-if="excludesText(fleetExclusions)" class="mt-0.5 max-w-[12rem] truncate text-xs font-normal text-warning-text" :title="excludesDetail(fleetExclusions)">
                {{ excludesText(fleetExclusions) }}
                <span class="sr-only">{{ excludesDetail(fleetExclusions) }}</span>
              </p>
            </th>
            <td v-for="dest in groups" :key="`fleet-${dest.id}`" class="p-0 text-center">
              <PolicyMatrixCell :cell="fleetCellMap.get(dest.id)" :is-self="false" :editable="false" />
            </td>
            <td class="border-l border-border px-2 py-2 text-center">
              <Badge v-if="fleet.external > 0" variant="secondary" class="whitespace-nowrap tabular-nums" :title="$t('networking.matrix.externalHint')">
                {{ $t("networking.matrix.externalRules", { n: fleet.external }, fleet.external) }}
              </Badge>
              <span v-else class="text-muted-foreground">{{ $t("common.misc.none") }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
