<script setup lang="ts">
/**
 * A row's one menu (design 23, section 3.6; design 22, section 2, rule 4).
 *
 * A row has one click target, the sheet, and one menu for everything else.
 * The trigger is always visible (touch has no hover), labelled "Actions for
 * <name>". A disabled item says why inline, because touch has no tooltip.
 * Dangerous items sit last, after a separator (chassisModel).
 */
import { computed, ref, type Component } from "vue";
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

/*
 * RowMenu decides where focus goes when the menu closes; reka's own return is
 * cancelled every time, through its public close-auto-focus event.
 *
 * - An item that runs puts focus on the trigger before its action, so a
 *   dialog the action opens remembers the trigger and returns focus there.
 *   Run from inside the menu, the dialog remembered the menu item, which is
 *   gone by the time it closes, and focus fell to the page. Focus then stays
 *   where the action left it (on the trigger, or in the dialog).
 * - A click or focus outside the menu leaves focus where the user put it.
 * - Any other close (Escape, a second click on the trigger) returns focus to
 *   the trigger.
 *
 * Letting reka decide went wrong both ways: its late return focused the
 * trigger after a dialog the item opened already held focus, and cancelling
 * only that return left reka's own "interacted outside" flag set by the
 * hand-made trigger focus, so the menu's next Escape dropped focus to the page.
 */
const trigger = ref<{ $el?: Node } | null>(null);
let leaveFocus = false;

// A component's $el is its first node, which is a text or comment node when
// the component renders a fragment, so walk to the first element.
function triggerEl(): HTMLElement | undefined {
  let node: Node | null | undefined = trigger.value?.$el;
  while (node && !(node instanceof HTMLElement)) node = node.nextSibling;
  return node ?? undefined;
}

function onOpenChange(open: boolean): void {
  if (open) leaveFocus = false;
}

function onInteractOutside(event: Event): void {
  const target = event.target;
  if (target instanceof Node && triggerEl()?.contains(target)) return;
  leaveFocus = true;
}

function select(item: RowMenuItem): void {
  if (item.disabled) return;
  if (item.to) {
    router.push(item.to).catch(() => {});
    return;
  }
  if (!item.run) return;
  triggerEl()?.focus();
  leaveFocus = true;
  item.run();
}

function onCloseAutoFocus(event: Event): void {
  event.preventDefault();
  if (leaveFocus) return;
  // Late, as reka does it: the menu content is still being torn down.
  const el = triggerEl();
  setTimeout(() => el?.focus(), 0);
}
</script>

<template>
  <DropdownMenu v-if="sections.safe.length || sections.danger.length" :modal="false" @update:open="onOpenChange">
    <DropdownMenuTrigger as-child>
      <Button
        ref="trigger"
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
    <DropdownMenuContent
      :align="align"
      class="w-56"
      @interact-outside="onInteractOutside"
      @close-auto-focus="onCloseAutoFocus"
    >
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
