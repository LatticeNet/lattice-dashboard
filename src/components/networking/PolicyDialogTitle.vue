<script setup lang="ts">
/**
 * One title pattern for both outbound policy dialogs (design 32 D3): the
 * policy form and the matrix cell editor both read "<New|Edit> outbound
 * policy", then, after a separator, what the dialog is about (the policy's
 * name or target, or the source and destination groups of a matrix cell).
 */
import { DialogTitle } from "@/components/ui/dialog";

defineProps<{ editing: boolean }>();
</script>

<template>
  <DialogTitle class="flex flex-wrap items-center gap-x-2 gap-y-1">
    <span>{{ editing ? $t("networking.outbound.titleEdit") : $t("networking.outbound.titleNew") }}</span>
    <template v-if="$slots.default">
      <span class="text-muted-foreground" aria-hidden="true">·</span>
      <span class="flex min-w-0 flex-wrap items-center gap-1.5 font-normal"><slot /></span>
    </template>
  </DialogTitle>
</template>
