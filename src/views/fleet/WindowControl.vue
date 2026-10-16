<script setup lang="ts">
/**
 * The page's one window control (design 29 D7): every layer that reads a
 * window reads this one, through `?window=`. Only the windows this server
 * can answer are offered; a link naming another reads the nearest offered
 * one, and the control marks that one.
 */
import type { MonitorWindow } from "@/lib/api";
import { cn } from "@/lib/utils";

defineProps<{ offered: readonly MonitorWindow[]; label: string }>();
const model = defineModel<MonitorWindow>({ required: true });
</script>

<template>
  <div class="flex rounded-md border border-border p-0.5 text-xs" role="group" :aria-label="label" data-testid="monitoring-window">
    <button
      v-for="w in offered"
      :key="w"
      type="button"
      :class="
        cn(
          'rounded px-2.5 py-1 font-mono outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11 pointer-coarse:min-w-11 max-[400px]:px-2',
          model === w ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
        )
      "
      :aria-pressed="model === w"
      @click="model = w"
    >
      {{ $t(`fleet.monitoring.window.${w}`) }}
    </button>
  </div>
</template>
