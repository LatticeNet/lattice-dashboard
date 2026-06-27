<script setup lang="ts">
import { computed } from "vue";
import { diffLines } from "@/lib/diff";

// Renders a before → after line diff of two rendered plans so an operator sees
// exactly what a change does. `before` empty means "no prior config" (the diff
// then shows everything as added).
const props = defineProps<{ before: string; after: string }>();
const result = computed(() => diffLines(props.before ?? "", props.after ?? ""));
</script>

<template>
  <div class="overflow-hidden rounded-md border border-border">
    <div class="flex flex-wrap items-center gap-3 border-b border-border bg-muted/40 px-3 py-1.5 text-xs">
      <span class="font-medium text-success">+{{ result.added }}</span>
      <span class="font-medium text-destructive">−{{ result.removed }}</span>
      <span v-if="result.truncated" class="text-muted-foreground">{{ $t('operations.approvals.diffTruncated') }}</span>
      <span v-else-if="result.added === 0 && result.removed === 0" class="text-muted-foreground">{{ $t('operations.approvals.diffNoChange') }}</span>
    </div>
    <div class="max-h-[520px] overflow-auto font-mono text-xs leading-relaxed">
      <div
        v-for="(line, idx) in result.lines"
        :key="idx"
        :class="[
          'flex gap-2 whitespace-pre-wrap break-all px-3 py-0.5',
          line.type === 'add' && 'bg-success/10 text-success',
          line.type === 'del' && 'bg-destructive/10 text-destructive',
          line.type === 'ctx' && 'text-muted-foreground',
        ]"
      >
        <span class="select-none opacity-60">{{ line.type === "add" ? "+" : line.type === "del" ? "−" : " " }}</span>
        <span class="min-w-0 flex-1">{{ line.text }}</span>
      </div>
    </div>
  </div>
</template>
