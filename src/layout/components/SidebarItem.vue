<script setup lang="ts">
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useI18n } from "vue-i18n";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { NavItem } from "@/router/nav";

const props = defineProps<{
  item: NavItem;
  collapsed: boolean;
  /**
   * Plugin-contributed items carry their own (manifest-provided) title — there's
   * no static `nav.items.*` i18n key — and render a small affordance marking them
   * as contributed by an active plugin.
   */
  plugin?: boolean;
}>();

const { t } = useI18n();

// Static items resolve their label from i18n by name; plugin items use the
// manifest title verbatim.
const label = computed(() =>
  props.plugin ? props.item.title : t("nav.items." + props.item.name),
);

const base =
  "group/item flex h-9 items-center gap-3 rounded-md px-3 text-sm outline-none transition-colors focus-visible:ring-ring/50 focus-visible:ring-[3px]";
const idle =
  "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground";
const active =
  "bg-sidebar-accent font-medium text-sidebar-accent-foreground";
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
        <component :is="item.icon" class="size-4 shrink-0" aria-hidden="true" />
        <span class="sr-only">{{ label }}</span>
      </RouterLink>
    </TooltipTrigger>
    <TooltipContent side="right" class="flex items-center gap-1.5">
      {{ label }}
      <span v-if="plugin" class="text-[10px] uppercase tracking-wide text-muted-foreground">{{ $t('nav.pluginContributed') }}</span>
    </TooltipContent>
  </Tooltip>

  <RouterLink
    v-else
    :to="item.path"
    :exact-active-class="item.path === '/' ? active : ''"
    :active-class="item.path === '/' ? '' : active"
    :class="cn(base, idle)"
  >
    <component :is="item.icon" class="size-4 shrink-0" aria-hidden="true" />
    <span class="truncate">{{ label }}</span>
    <span
      v-if="plugin"
      class="ml-auto size-1.5 shrink-0 rounded-full bg-sidebar-primary/70"
      :title="$t('nav.pluginContributed')"
      aria-hidden="true"
    />
  </RouterLink>
</template>
