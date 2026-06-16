<script setup lang="ts">
import { computed, useSlots } from "vue";
import { useAuthStore } from "@/stores/auth";

const props = withDefaults(
  defineProps<{
    scope: string | string[];
    requireAll?: boolean;
  }>(),
  {
    requireAll: false,
  },
);

const auth = useAuthStore();
const slots = useSlots();

const scopes = computed(() =>
  Array.isArray(props.scope) ? props.scope : [props.scope],
);

const allowed = computed(() => {
  if (scopes.value.length === 0) return true;
  return props.requireAll
    ? scopes.value.every((s) => auth.can(s))
    : auth.canAny(scopes.value);
});
</script>

<template>
  <slot v-if="allowed" />
  <slot v-else-if="slots.fallback" name="fallback" />
</template>
