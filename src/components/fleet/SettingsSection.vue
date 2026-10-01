<script setup lang="ts">
/**
 * One section of a node's Settings layer (design 23, 4.2: "one save
 * pattern"). Every section is the same shape: a title that says what it
 * governs, the fields, and one footer whose first button saves the section
 * and is enabled only when something changed. Identity, IP discovery, the
 * launch profile, location, auto-update and diagnostics used four save
 * flows in three button styles before.
 */
import { useSlots } from "vue";

import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const props = defineProps<{
  title: string;
  description?: string;
  /** The danger zone: a red edge, and it sits last. */
  danger?: boolean;
  id?: string;
}>();

const slots = useSlots();
</script>

<template>
  <Card :id="props.id" :class="cn('gap-4 py-5', danger && 'border-destructive/40')">
    <CardHeader class="gap-1 px-5">
      <div class="flex flex-wrap items-start justify-between gap-2">
        <h2 :id="props.id ? `${props.id}-title` : undefined" :class="cn('text-base font-semibold leading-none', danger && 'text-destructive')">{{ title }}</h2>
        <div v-if="slots.status" class="flex flex-wrap items-center gap-1.5">
          <slot name="status" />
        </div>
      </div>
      <CardDescription v-if="description">{{ description }}</CardDescription>
    </CardHeader>
    <CardContent class="space-y-4 px-5 text-sm">
      <slot />
    </CardContent>
    <div v-if="slots.actions" class="flex flex-wrap items-center gap-2 border-t border-border px-5 pt-4">
      <slot name="actions" />
    </div>
  </Card>
</template>
