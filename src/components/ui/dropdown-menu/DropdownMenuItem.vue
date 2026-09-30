<script setup lang="ts">
import { computed, type HTMLAttributes } from "vue";
import { DropdownMenuItem, type DropdownMenuItemEmits, type DropdownMenuItemProps, useForwardPropsEmits } from "reka-ui";
import { cn } from "@/lib/utils";

const props = withDefaults(
  defineProps<
    DropdownMenuItemProps & {
      class?: HTMLAttributes["class"];
      /** Paints the item as a destructive action. */
      variant?: "default" | "destructive";
    }
  >(),
  { variant: "default" },
);

const emits = defineEmits<DropdownMenuItemEmits>();

const delegatedProps = computed(() => {
  const { class: _class, variant: _variant, ...rest } = props;
  return rest;
});

const forwarded = useForwardPropsEmits(delegatedProps, emits);
</script>

<template>
  <DropdownMenuItem
    data-slot="dropdown-menu-item"
    :data-variant="variant"
    v-bind="forwarded"
    :class="
      cn(
        `focus:bg-accent focus:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive [&_svg:not([class*='text-'])]:text-muted-foreground data-[variant=destructive]:[&_svg]:text-destructive relative flex min-h-8 cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-60 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4`,
        props.class,
      )
    "
  >
    <slot />
  </DropdownMenuItem>
</template>
