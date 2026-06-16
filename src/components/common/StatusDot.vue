<script setup lang="ts">
import { computed, type HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

type Status = "online" | "offline" | "degraded" | "pending" | "unknown";

const props = withDefaults(
  defineProps<{
    status?: Status;
    online?: boolean;
    pulse?: boolean;
    label?: string;
    class?: HTMLAttributes["class"];
  }>(),
  {
    status: "unknown",
    pulse: true,
  },
);

const resolved = computed<Status>(() => {
  if (props.online !== undefined) return props.online ? "online" : "offline";
  return props.status;
});

const dotClass = computed(() => {
  switch (resolved.value) {
    case "online":
      return "bg-success ring-success/25";
    case "offline":
      return "bg-destructive ring-destructive/25";
    case "degraded":
      return "bg-warning ring-warning/25";
    case "pending":
      return "bg-info ring-info/25";
    default:
      return "bg-muted-foreground ring-muted-foreground/25";
  }
});

const animated = computed(() => resolved.value === "online" && props.pulse);

const displayLabel = computed(() => props.label ?? "");
</script>

<template>
  <span :class="cn('inline-flex items-center gap-1.5', props.class)">
    <span
      :class="
        cn(
          'inline-block size-2 shrink-0 rounded-full ring-2',
          dotClass,
          animated && 'animate-pulse-dot',
        )
      "
      :aria-label="displayLabel || resolved"
    />
    <span
      v-if="label"
      class="text-xs text-muted-foreground capitalize"
    >
      {{ label }}
    </span>
  </span>
</template>
