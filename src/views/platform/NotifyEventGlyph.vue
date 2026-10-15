<script setup lang="ts">
/**
 * A notification's glyph (design-notify-abstraction 13.3): the disc a Bark
 * push shows on the phone, drawn the same way in the console. Colour comes
 * from the tone (how bad), the glyph from the catalogue (what happened).
 *
 * The icons are named imports from an explicit allow-list, so the bundle
 * carries these twenty and no more; the Record type makes vue-tsc refuse a
 * name in NOTIFY_ICON_NAMES without an import here.
 */
import { computed, type Component, type HTMLAttributes } from "vue";
import {
  Activity,
  Bell,
  BellOff,
  BellRing,
  Bot,
  CalendarClock,
  FlaskConical,
  Gauge,
  HeartPulse,
  Hourglass,
  KeyRound,
  LockKeyhole,
  Power,
  PowerOff,
  Puzzle,
  Receipt,
  Server,
  ServerOff,
  ShieldAlert,
  Webhook,
} from "lucide-vue-next";

import { cn } from "@/lib/utils";
import { TONE_DISC, TONE_INK, notifyIconName, type NotifyIconName, type NotifyTone } from "./notifyCatalogueModel";

const ICONS: Record<NotifyIconName, Component> = {
  "server-off": ServerOff,
  server: Server,
  "power-off": PowerOff,
  power: Power,
  activity: Activity,
  "heart-pulse": HeartPulse,
  hourglass: Hourglass,
  bot: Bot,
  "key-round": KeyRound,
  "shield-alert": ShieldAlert,
  "lock-keyhole": LockKeyhole,
  gauge: Gauge,
  "calendar-clock": CalendarClock,
  receipt: Receipt,
  "bell-off": BellOff,
  "bell-ring": BellRing,
  "flask-conical": FlaskConical,
  puzzle: Puzzle,
  webhook: Webhook,
  bell: Bell,
};

const props = withDefaults(
  defineProps<{
    icon: string;
    tone: NotifyTone;
    /** The 28 px disc of the Sent log; off draws the glyph alone in the tone's ink. */
    disc?: boolean;
    class?: HTMLAttributes["class"];
  }>(),
  { disc: true, class: undefined },
);

const glyph = computed(() => ICONS[notifyIconName(props.icon)]);
</script>

<template>
  <span
    v-if="disc"
    aria-hidden="true"
    :data-tone="tone"
    :data-icon="notifyIconName(icon)"
    :class="cn('inline-flex size-7 shrink-0 items-center justify-center rounded-full', TONE_DISC[tone], props.class)"
  >
    <component :is="glyph" class="size-4" />
  </span>
  <component
    :is="glyph"
    v-else
    aria-hidden="true"
    :data-tone="tone"
    :data-icon="notifyIconName(icon)"
    :class="cn('size-4 shrink-0', TONE_INK[tone], props.class)"
  />
</template>
