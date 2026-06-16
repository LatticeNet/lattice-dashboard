<script setup lang="ts">
import { RouterLink } from "vue-router";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { NavItem } from "@/router/nav";

defineProps<{
  item: NavItem;
  collapsed: boolean;
}>();

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
        <component :is="item.icon" class="size-4 shrink-0" />
        <span class="sr-only">{{ item.title }}</span>
      </RouterLink>
    </TooltipTrigger>
    <TooltipContent side="right">{{ item.title }}</TooltipContent>
  </Tooltip>

  <RouterLink
    v-else
    :to="item.path"
    :exact-active-class="item.path === '/' ? active : ''"
    :active-class="item.path === '/' ? '' : active"
    :class="cn(base, idle)"
  >
    <component :is="item.icon" class="size-4 shrink-0" />
    <span class="truncate">{{ item.title }}</span>
  </RouterLink>
</template>
