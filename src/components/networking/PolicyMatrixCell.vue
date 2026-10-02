<script setup lang="ts">
import { computed, type Component } from "vue";
import { useI18n } from "vue-i18n";
import { Check, Circle, Contrast, Minus, X } from "lucide-vue-next";
import { cn } from "@/lib/utils";
import type { MatrixCell } from "@/lib/api";

/**
 * One cell of the reachability matrix: source group (row) to dest group (col).
 *
 * Icons follow the spec legend (keep PolicyMatrix's legend in step):
 *   check allow, x deny, contrast mixed, minus none, circle self (same group,
 *   no explicit rule)
 *
 * A glyph has to clear 3:1 on the card to be read at all. The rule glyphs use
 * the -text inks (the light amber and green fills measured 2.47 and 3.3), and
 * the empty marks are plain muted ink: they read as empty by being grey and
 * a dash or a ring, not by being faint (at /40 and /50 they measured 1.75 and
 * 2.04 in light).
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

type Glyph = { icon: Component; tone: string; key: string };

const glyph = computed<Glyph>(() => {
  const c = props.cell;
  if (c) {
    if (c.mixed) return { icon: Contrast, tone: "text-warning-text", key: "mixed" };
    if (c.action === "allow") return { icon: Check, tone: "text-success-text", key: "allow" };
    return { icon: X, tone: "text-destructive", key: "deny" };
  }
  if (props.isSelf) return { icon: Circle, tone: "text-muted-foreground", key: "self" };
  return { icon: Minus, tone: "text-muted-foreground", key: "none" };
});

/** Hover summary: protocol/ports/rule-count when a rule exists. */
const title = computed(() => {
  const c = props.cell;
  if (!c) return props.isSelf ? t("networking.matrix.selfTitle") : t("networking.matrix.noneTitle");
  const proto = c.protocols?.length ? c.protocols.join("/") : t("common.misc.all");
  const ports = c.ports?.length ? `:${c.ports.join(",")}` : "";
  return t(
    "networking.matrix.cellTitle",
    { action: c.action, proto: `${proto}${ports}`, count: c.rule_count },
    c.rule_count,
  );
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
    <component :is="glyph.icon" :key="glyph.key" :class="cn('size-3.5', glyph.tone)" aria-hidden="true" />
    <span v-if="subLabel" class="font-mono text-[10px] text-muted-foreground">{{ subLabel }}</span>
  </component>
</template>
