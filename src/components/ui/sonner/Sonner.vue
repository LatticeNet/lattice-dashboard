<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Toaster as Sonner, type ToasterProps } from "vue-sonner";
import "vue-sonner/style.css";
import { useThemeStore } from "@/stores/theme";
import { useIsMobile } from "@/composables/useMediaQuery";
import { TOAST_AVOID_SELECTOR, toastLift } from "@/lib/toastClearance";

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

/*
 * At the bottom a toast would sit on the sheet's or a tall dialog's footer,
 * where Approve, Reject, Cancel task, Delete and Rerun live, and toasts take
 * pointer events. Below 768 px the toaster watches for open footers and lifts
 * itself above any that reaches into its band (see toastClearance.ts). One
 * measurement per frame at most, and nothing runs at 768 px and up.
 */
const lift = ref<number | null>(null);
let observer: MutationObserver | undefined;
let frame = 0;

function measure(): void {
  frame = 0;
  const boxes = [...document.querySelectorAll<HTMLElement>(TOAST_AVOID_SELECTOR)].map((el) => el.getBoundingClientRect());
  lift.value = toastLift(window.innerHeight, boxes);
}

function schedule(): void {
  if (!frame) frame = requestAnimationFrame(measure);
}

function start(): void {
  if (observer) return;
  observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-state"] });
  window.addEventListener("resize", schedule);
  // A sheet sliding in is measured again once it lands.
  document.addEventListener("animationend", schedule, true);
  document.addEventListener("transitionend", schedule, true);
  schedule();
}

function stop(): void {
  observer?.disconnect();
  observer = undefined;
  window.removeEventListener("resize", schedule);
  document.removeEventListener("animationend", schedule, true);
  document.removeEventListener("transitionend", schedule, true);
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  lift.value = null;
}

onMounted(() => {
  if (mobile.value) start();
});
watch(mobile, (on) => (on ? start() : stop()));
onBeforeUnmount(stop);

const offset = computed<ToasterProps["offset"]>(() => (lift.value === null ? props.offset : { bottom: lift.value }));
const mobileOffset = computed<ToasterProps["mobileOffset"]>(() => (lift.value === null ? props.mobileOffset : { bottom: lift.value }));
</script>

<template>
  <Sonner
    class="toaster group"
    :theme="props.theme ?? activeTheme"
    :rich-colors="props.richColors ?? true"
    :position="position"
    :offset="offset"
    :mobile-offset="mobileOffset"
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
