<script setup lang="ts">
import { ref, onBeforeUnmount } from "vue";
import { Check, Copy } from "lucide-vue-next";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";

const props = withDefaults(
  defineProps<{
    value: string;
    label?: string;
    size?: string;
  }>(),
  {},
);

const copied = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

async function copy() {
  try {
    await navigator.clipboard.writeText(props.value);
    copied.value = true;
    toast.success("Copied");
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      copied.value = false;
    }, 1500);
  } catch {
    toast.error("Copy failed");
  }
}

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
});
</script>

<template>
  <Button
    type="button"
    variant="ghost"
    :size="label ? 'sm' : 'icon-sm'"
    :aria-label="label ?? 'Copy'"
    @click="copy"
  >
    <Check v-if="copied" class="text-success" />
    <Copy v-else />
    <span v-if="label">{{ label }}</span>
  </Button>
</template>
