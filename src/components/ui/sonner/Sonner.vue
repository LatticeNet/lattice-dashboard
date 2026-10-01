<script setup lang="ts">
import { computed } from "vue";
import { Toaster as Sonner, type ToasterProps } from "vue-sonner";
import "vue-sonner/style.css";
import { useThemeStore } from "@/stores/theme";
import { useIsMobile } from "@/composables/useMediaQuery";

const props = defineProps<ToasterProps>();

const theme = useThemeStore();

const activeTheme = computed<ToasterProps["theme"]>(() => (theme.isDark ? "dark" : "light"));

/**
 * Below 768 px an object sheet takes the whole screen with its title and
 * close button at the top, and a top toast sat on both for as long as it
 * showed. Toasts rise from the bottom there instead.
 */
const mobile = useIsMobile();
const position = computed<ToasterProps["position"]>(() => props.position ?? (mobile.value ? "bottom-center" : "top-right"));
</script>

<template>
  <Sonner
    class="toaster group"
    :theme="props.theme ?? activeTheme"
    :rich-colors="props.richColors ?? true"
    :position="position"
    :toast-options="
      props.toastOptions ?? {
        classes: {
          toast:
            'group toast group-[.toaster]:bg-card group-[.toaster]:text-card-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg group-[.toaster]:rounded-lg',
          description: 'group-[.toast]:text-muted-foreground',
          actionButton:
            'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
          cancelButton:
            'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground',
        },
      }
    "
    v-bind="$attrs"
  />
</template>
