<script setup lang="ts">
import { computed, type HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";
import type { NodeHealth } from "@/lib/status";

/**
 * `inheritAttrs: false` is DELIBERATE. StatusDot owns a small, explicit prop
 * surface (`status` / `online` / `tone` / `pulse` / `label` / `class`). Without
 * this, a caller typo or a stray undeclared attribute (e.g. `:colour="..."`,
 * `:active="..."`) would silently fall through to the root <span> and no-op,
 * the exact failure mode behind a past critical bug where a dot rendered the
 * wrong color with no error. With `inheritAttrs: false` such props are dropped
 * loudly (visible in DevTools / vue-tsc surface) instead of pretending to work.
 * Add any new visual control as a real declared prop below, never via $attrs.
 */
defineOptions({ inheritAttrs: false });

type Status = NodeHealth;

/** Explicit color tones, decoupled from health semantics. */
type Tone = "success" | "warning" | "info" | "destructive" | "neutral";

const props = withDefaults(
  defineProps<{
    /** Canonical health state (drives color + pulse). */
    status?: Status;
    /**
     * Convenience boolean: `true` -> online, `false` -> offline.
     *
     * @deprecated Pass `status` instead. This prop is the reason the bug below
     * was possible, and it has no callers left; it stays only so an external
     * one does not break silently.
     *
     * MUST keep an explicit `undefined` default below. Vue casts an ABSENT
     * Boolean prop to `false` rather than leaving it undefined, so without that
     * default `props.online` is `false` for every caller that passes only
     * `status`, the `online !== undefined` branch always wins, and the dot
     * renders "offline" no matter what health was asked for. That shipped: the
     * whole fleet list drew red dots beside green "online" badges.
     */
    online?: boolean;
    /**
     * Explicit color override. Wins over `status`/`online` so a caller can
     * render, e.g., an amber "attention" dot without faking a health state.
     */
    tone?: Tone;
    pulse?: boolean;
    label?: string;
    class?: HTMLAttributes["class"];
  }>(),
  {
    status: "unknown",
    pulse: true,
    // Not cosmetic. A Boolean prop with no default is cast to `false` when the
    // caller omits it, which silently disables the `status` path entirely.
    online: undefined,
  },
);

/** Tones map onto the same health buckets the SSOT (`@/lib/status`) colors. */
const TONE_HEALTH: Record<Tone, Status> = {
  success: "online",
  warning: "degraded",
  info: "pending",
  destructive: "offline",
  neutral: "unknown",
};

/**
 * Resolution order: explicit `tone` > `online` boolean > `status` enum.
 * Returns a {@link NodeHealth} that drives both color and pulse so the dot's
 * coloring stays consistent with `@/lib/status` `statusMeta(...)`.
 */
const resolved = computed<Status>(() => {
  if (props.tone !== undefined) return TONE_HEALTH[props.tone];
  // The `online: undefined` default above is what makes this branch correct,
  // and it is the ONLY thing that does. A type check here would not help: Vue
  // casts an absent Boolean prop to `false`, and `false` is a boolean, so the
  // branch would still win. Delete that default and every dot goes red again.
  if (props.online !== undefined) return props.online ? "online" : "offline";
  return props.status;
});

/**
 * Dot color (background + ring) keyed by the resolved health. Kept local to the
 * component because the ring treatment is StatusDot-specific; the health->color
 * MAPPING mirrors the SSOT table in `@/lib/status` (success/warning/info/
 * destructive/muted tokens defined in `src/style/app.css`).
 */
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
    // Never reported is muted on purpose, like unknown and unlike offline: it
    // is an unfinished setup, not a failure.
    case "never":
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
