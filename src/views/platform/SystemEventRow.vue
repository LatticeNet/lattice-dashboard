<script setup lang="ts">
/**
 * One plugin method, route group or store caller on the System page: calls,
 * rate, p50, p95, failures and a p95 sparkline. From 768 px up it is a 40 px
 * row of aligned columns; below, two lines (the name with its sparkline,
 * then the figures as one sentence), so a phone never wraps a number apart
 * from its unit.
 */
import { computed } from "vue";

import type { SystemEventRow } from "@/lib/api/systemTypes";
import { cn } from "@/lib/utils";

import RangeSparkline from "@/components/common/RangeSparkline.vue";

import { errorTone, eventRowTone, formatErrorRate, formatRate, formatSeconds, type Tone } from "./systemModel";

const props = defineProps<{ row: SystemEventRow; from: number; to: number; indent?: boolean }>();

const tone = computed<Tone>(() => eventRowTone(props.row));
const failTone = computed<Tone>(() => errorTone(props.row));
const slow = computed(() => props.row.p95_seconds >= 1);
const TONE_TEXT: Record<Tone, string> = { default: "", warning: "text-warning-text", destructive: "text-destructive" };
</script>

<template>
  <li :class="cn('border-t border-border/60 px-4 first:border-t-0', indent && 'md:ps-10')">
    <div class="hidden min-h-10 items-center gap-3 md:flex">
      <span class="min-w-0 grow truncate font-mono text-sm" :title="row.name">{{ row.name }}</span>
      <span class="w-20 text-right font-mono text-sm tabular">{{ row.calls.toLocaleString('en-US') }}</span>
      <span class="w-16 text-right font-mono text-xs tabular text-muted-foreground">{{ formatRate(row.per_minute) }}</span>
      <span class="w-20 text-right font-mono text-sm tabular text-muted-foreground">{{ formatSeconds(row.p50_seconds) }}</span>
      <span :class="cn('w-20 text-right font-mono text-sm tabular', slow && 'text-warning-text')">{{ formatSeconds(row.p95_seconds) }}</span>
      <span :class="cn('w-16 text-right font-mono text-sm tabular', TONE_TEXT[failTone])">{{ formatErrorRate(row) }}</span>
      <RangeSparkline :spark="row.spark" :from="from" :to="to" :tone="tone" />
    </div>
    <div class="space-y-0.5 py-2 md:hidden">
      <div class="flex items-center gap-3">
        <!-- Wraps on a phone: a truncated method name with only a title is unreadable on touch. -->
        <span class="min-w-0 grow font-mono text-sm wrap-anywhere">{{ row.name }}</span>
        <RangeSparkline :spark="row.spark" :from="from" :to="to" :tone="tone" />
      </div>
      <!-- Each figure stays whole; the line breaks only between them. -->
      <p class="font-mono text-xs tabular text-muted-foreground">
        <span class="whitespace-nowrap">{{ $t('platform.system.row.calls', { n: row.calls.toLocaleString('en-US') }, row.calls) }}</span>
        · <span class="whitespace-nowrap">p50 {{ formatSeconds(row.p50_seconds) }}</span>
        · <span :class="cn('whitespace-nowrap', slow ? 'text-warning-text' : 'text-foreground')">p95 {{ formatSeconds(row.p95_seconds) }}</span>
        · <span :class="cn('whitespace-nowrap', TONE_TEXT[failTone])">{{ $t('platform.system.row.failed', { rate: formatErrorRate(row) }) }}</span>
      </p>
    </div>
  </li>
</template>
