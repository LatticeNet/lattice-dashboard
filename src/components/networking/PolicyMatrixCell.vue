<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { cn } from "@/lib/utils";
import type { MatrixCell } from "@/lib/api";

/**
 * One cell of the reachability matrix: source group (row) → dest group (col).
 *
 * Glyphs follow the spec legend:
 *   ✓ allow · ✗ deny · ◐ mixed · — none · ● self (same group, no explicit rule)
 */
const props = withDefaults(
  defineProps<{
    cell?: MatrixCell;
    /** from === to: the diagonal "same group" cell. */
    isSelf?: boolean;
    /** When true the cell is clickable (operator may author a rule). */
    editable?: boolean;
  }>(),
  { cell: undefined, isSelf: false, editable: false },
);

const emit = defineEmits<{ (e: "edit"): void }>();

const { t } = useI18n();

type Glyph = { ch: string; tone: string; key: string };

const glyph = computed<Glyph>(() => {
  const c = props.cell;
  if (c) {
    if (c.mixed) return { ch: "◐", tone: "text-amber-600 dark:text-amber-400", key: "mixed" };
    if (c.action === "allow") return { ch: "✓", tone: "text-success", key: "allow" };
    return { ch: "✗", tone: "text-destructive", key: "deny" };
  }
  if (props.isSelf) return { ch: "●", tone: "text-muted-foreground/50", key: "self" };
  return { ch: "—", tone: "text-muted-foreground/40", key: "none" };
});

/** Hover summary: protocol/ports/rule-count when a rule exists. */
const title = computed(() => {
  const c = props.cell;
  if (!c) return props.isSelf ? t("networking.matrix.selfTitle") : t("networking.matrix.noneTitle");
  const proto = c.protocols?.length ? c.protocols.join("/") : t("common.misc.all");
  const ports = c.ports?.length ? `:${c.ports.join(",")}` : "";
  return t("networking.matrix.cellTitle", {
    action: c.action,
    proto: `${proto}${ports}`,
    count: c.rule_count,
  });
});

const subLabel = computed(() => {
  const c = props.cell;
  if (!c) return "";
  if (c.ports?.length) return `:${c.ports.slice(0, 2).join(",")}${c.ports.length > 2 ? "…" : ""}`;
  if (c.protocols?.length) return c.protocols[0];
  return "";
});
</script>

<template>
  <component
    :is="editable ? 'button' : 'div'"
    :type="editable ? 'button' : undefined"
    :title="title"
    :aria-label="title"
    :class="
      cn(
        'flex h-12 w-full flex-col items-center justify-center gap-0.5 border-l border-border text-base leading-none transition-colors',
        editable && 'cursor-pointer hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )
    "
    @click="editable ? emit('edit') : undefined"
  >
    <span :class="cn('font-semibold', glyph.tone)">{{ glyph.ch }}</span>
    <span v-if="subLabel" class="font-mono text-[10px] text-muted-foreground">{{ subLabel }}</span>
  </component>
</template>
