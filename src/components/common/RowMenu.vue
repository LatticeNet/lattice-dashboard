<script setup lang="ts">
/**
 * A row's one menu (design 23, section 3.6; design 22, section 2, rule 4).
 *
 * A row has one click target, the sheet, and one menu for everything else.
 * The trigger is always visible (touch has no hover), labelled "Actions for
 * <name>". A disabled item says why inline, because touch has no tooltip.
 * Dangerous items sit last, after a separator (chassisModel).
 */
import { computed, type Component } from "vue";
import { useRouter, type RouteLocationRaw } from "vue-router";
import { MoreHorizontal } from "lucide-vue-next";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { rowMenuSections } from "./chassisModel";

export interface RowMenuItem {
  key: string;
  label: string;
  icon?: Component;
  disabled?: boolean;
  /** Why it is disabled, printed under the label. */
  reason?: string;
  danger?: boolean;
  /** Leave the item out entirely (no scope for it). */
  hidden?: boolean;
  to?: RouteLocationRaw;
  run?: () => void;
}

const props = withDefaults(
  defineProps<{
    /** The row's name, for the trigger's accessible label. */
    name: string;
    items: RowMenuItem[];
    align?: "start" | "end";
  }>(),
  { align: "end" },
);

const router = useRouter();
const sections = computed(() => rowMenuSections(props.items));

function select(item: RowMenuItem): void {
  if (item.disabled) return;
  if (item.to) router.push(item.to).catch(() => {});
  else item.run?.();
}
</script>

<template>
  <DropdownMenu v-if="sections.safe.length || sections.danger.length" :modal="false">
    <DropdownMenuTrigger as-child>
      <Button
        variant="ghost"
        size="icon-sm"
        type="button"
        class="text-muted-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
        :aria-label="$t('common.rowMenu.label', { name })"
        data-no-row-nav
        data-testid="row-menu"
      >
        <MoreHorizontal aria-hidden="true" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent :align="align" class="w-56">
      <DropdownMenuItem
        v-for="item in sections.safe"
        :key="item.key"
        :disabled="item.disabled"
        :class="item.disabled ? 'items-start data-[disabled]:opacity-100' : undefined"
        @select="select(item)"
      >
        <component :is="item.icon" v-if="item.icon" :class="item.disabled ? 'mt-0.5 opacity-60' : undefined" aria-hidden="true" />
        <span class="flex min-w-0 flex-col">
          <span :class="item.disabled ? 'text-muted-foreground' : undefined">{{ item.label }}</span>
          <span v-if="item.disabled && item.reason" class="text-xs text-muted-foreground">{{ item.reason }}</span>
        </span>
      </DropdownMenuItem>
      <DropdownMenuSeparator v-if="sections.safe.length && sections.danger.length" />
      <DropdownMenuItem
        v-for="item in sections.danger"
        :key="item.key"
        variant="destructive"
        :disabled="item.disabled"
        :class="item.disabled ? 'items-start data-[disabled]:opacity-100' : undefined"
        @select="select(item)"
      >
        <component :is="item.icon" v-if="item.icon" :class="item.disabled ? 'mt-0.5 opacity-60' : undefined" aria-hidden="true" />
        <span class="flex min-w-0 flex-col">
          <span :class="item.disabled ? 'text-muted-foreground' : undefined">{{ item.label }}</span>
          <span v-if="item.disabled && item.reason" class="text-xs text-muted-foreground">{{ item.reason }}</span>
        </span>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
