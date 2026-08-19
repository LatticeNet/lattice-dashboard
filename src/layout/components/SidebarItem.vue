<script setup lang="ts">
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useI18n } from "vue-i18n";
import { Pin, PinOff } from "lucide-vue-next";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { NavItem } from "@/router/nav";
import { formatBadge, type NavSignal } from "../navSignals";

const props = defineProps<{
  item: NavItem;
  collapsed: boolean;
  /** Manifest titles are already user-facing and do not have static i18n keys. */
  plugin?: boolean;
  /** Optional section context shown in the collapsed-rail tooltip. */
  context?: string;
  pinnable?: boolean;
  pinned?: boolean;
  /** Live state for this destination: pending work, or something failing. */
  signal?: NavSignal;
}>();

const emit = defineEmits<{
  (e: "toggle-pin", id: string): void;
}>();

const { t } = useI18n();
const label = computed(() => (props.plugin ? props.item.title : t(`nav.items.${props.item.name}`)));

const base =
  "group/item flex h-9 items-center gap-3 rounded-md px-3 text-sm outline-none transition-colors focus-visible:ring-ring/50 focus-visible:ring-[3px]";
const idle =
  "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground";
const active = "bg-sidebar-accent font-medium text-sidebar-accent-foreground";
</script>

<template>
  <Tooltip v-if="collapsed" :delay-duration="0">
    <TooltipTrigger as-child>
      <RouterLink
        :to="item.path"
        :exact-active-class="item.path === '/' ? active : ''"
        :active-class="item.path === '/' ? '' : active"
        :class="cn(base, idle, 'justify-center px-0')"
      >
        <span class="relative">
          <component :is="item.icon" class="size-4 shrink-0" aria-hidden="true" />
          <span
            v-if="signal"
            :class="cn(
              'absolute -right-1 -top-1 size-2 rounded-full ring-2 ring-sidebar',
              signal.tone === 'attention' ? 'bg-destructive' : 'bg-warning',
            )"
            aria-hidden="true"
          />
        </span>
        <span class="sr-only">{{ label }}<template v-if="signal">, {{ signal.label }}</template></span>
      </RouterLink>
    </TooltipTrigger>
    <TooltipContent side="right">
      <div class="font-medium">{{ label }}</div>
      <div v-if="signal" class="text-[10px]" :class="signal.tone === 'attention' ? 'text-destructive' : 'text-warning'">
        {{ signal.label }}
      </div>
      <div v-if="context" class="text-[10px] text-muted-foreground">{{ context }}</div>
    </TooltipContent>
  </Tooltip>

  <div v-else class="group/nav-item relative flex items-center rounded-md">
    <RouterLink
      :to="item.path"
      :exact-active-class="item.path === '/' ? active : ''"
      :active-class="item.path === '/' ? '' : active"
      :class="cn(base, idle, 'min-w-0 flex-1', pinnable && 'pr-10')"
    >
      <component :is="item.icon" class="size-4 shrink-0" aria-hidden="true" />
      <span class="truncate">{{ label }}</span>
      <span
        v-if="signal"
        :class="cn(
          'ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums',
          signal.tone === 'attention'
            ? 'bg-destructive/15 text-destructive'
            : 'bg-warning/15 text-warning',
        )"
        :title="signal.label"
      >
        {{ formatBadge(signal.count) }}
      </span>
    </RouterLink>
    <button
      v-if="pinnable"
      type="button"
      :class="
        cn(
          'absolute right-0 grid size-9 place-items-center rounded text-sidebar-foreground/55 outline-none transition-opacity hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring/50 md:right-1.5 md:size-6',
          pinned
            ? 'opacity-70 hover:opacity-100'
            : 'opacity-0 group-hover/nav-item:opacity-60 hover:opacity-100 focus-visible:opacity-100',
        )
      "
      :aria-label="pinned ? $t('shell.sidebar.unpin') : $t('shell.sidebar.pin')"
      :title="pinned ? $t('shell.sidebar.unpin') : $t('shell.sidebar.pin')"
      @click="emit('toggle-pin', item.name)"
    >
      <PinOff v-if="pinned" class="size-3.5" aria-hidden="true" />
      <Pin v-else class="size-3.5" aria-hidden="true" />
    </button>
  </div>
</template>
