<script setup lang="ts">
import { computed } from "vue";
import { ArrowRight, Check, Circle, Contrast, Minus, X } from "lucide-vue-next";
import type { MatrixCell, MatrixGroup, NetPolicyMatrix, NetRuleDirection } from "@/lib/api";
import GroupChip from "./GroupChip.vue";
import PolicyMatrixCell from "./PolicyMatrixCell.vue";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Reachability matrix: rows = source groups, columns = destination groups.
 * Each cell shows whether the source group is allowed to reach the destination
 * (see PolicyMatrixCell for the glyph legend). A trailing column rolls up each
 * source group's rules that target endpoints OUTSIDE any group (cidr / domain /
 * any / external node).
 */
const props = withDefaults(
  defineProps<{
    matrix: NetPolicyMatrix;
    direction: NetRuleDirection;
    canAdmin?: boolean;
  }>(),
  { canAdmin: false },
);

const emit = defineEmits<{
  (e: "update:direction", value: NetRuleDirection): void;
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

function onDirection(value: unknown) {
  if (value === "egress" || value === "ingress") emit("update:direction", value);
}
</script>

<template>
  <div class="space-y-4">
    <!-- Controls + glyph legend -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex items-center gap-2">
        <span class="text-sm text-muted-foreground">{{ $t("networking.matrix.direction") }}</span>
        <Select :model-value="direction" @update:model-value="onDirection">
          <SelectTrigger class="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="egress">{{ $t("networking.matrix.egress") }}</SelectItem>
            <SelectItem value="ingress">{{ $t("networking.matrix.ingress") }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span class="inline-flex items-center gap-1"><Check class="size-3.5 text-success" aria-hidden="true" /> {{ $t("networking.matrix.legendAllow") }}</span>
        <span class="inline-flex items-center gap-1"><X class="size-3.5 text-destructive" aria-hidden="true" /> {{ $t("networking.matrix.legendDeny") }}</span>
        <span class="inline-flex items-center gap-1"><Contrast class="size-3.5 text-warning" aria-hidden="true" /> {{ $t("networking.matrix.legendMixed") }}</span>
        <span class="inline-flex items-center gap-1"><Minus class="size-3.5 text-muted-foreground/60" aria-hidden="true" /> {{ $t("networking.matrix.legendNone") }}</span>
        <span class="inline-flex items-center gap-1"><Circle class="size-3.5 text-muted-foreground/60" aria-hidden="true" /> {{ $t("networking.matrix.legendSelf") }}</span>
      </div>
    </div>

    <!-- Grid -->
    <div class="overflow-x-auto rounded-lg border border-border">
      <table class="w-full border-collapse text-sm">
        <thead>
          <tr class="bg-muted/40">
            <th
              scope="col"
              class="sticky left-0 z-10 min-w-[10rem] bg-muted/40 px-3 py-2 text-left text-xs font-medium text-muted-foreground"
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
            >
              {{ $t("networking.matrix.externalCol") }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="src in groups" :key="`row-${src.id}`" class="border-t border-border">
            <th
              scope="row"
              class="sticky left-0 z-10 min-w-[10rem] bg-card px-3 py-2 text-left"
            >
              <GroupChip :name="src.name" :color="src.color" />
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
              <Badge v-if="externalFor(src.id) > 0" variant="secondary" class="tabular-nums">
                {{ externalFor(src.id) }}
              </Badge>
              <span v-else class="text-muted-foreground/50">{{ $t("common.misc.none") }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
