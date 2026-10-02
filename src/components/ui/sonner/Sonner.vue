<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Toaster as Sonner, type ToasterProps } from "vue-sonner";
import "vue-sonner/style.css";
import { useThemeStore } from "@/stores/theme";
import { useIsMobile } from "@/composables/useMediaQuery";
import { TOAST_AVOID_SELECTOR, TOAST_SHEET_SELECTOR, toastPlacement, type ToastPlacement } from "@/lib/toastClearance";

const props = defineProps<ToasterProps>();

const theme = useThemeStore();

const activeTheme = computed<ToasterProps["theme"]>(() => (theme.isDark ? "dark" : "light"));

/*
 * Where toasts go, so they never cover what the operator is using (see
 * toastClearance.ts). Below 768 px an object sheet takes the whole screen
 * with its title and close button at the top, so toasts rise from the bottom
 * and lift above any open footer (Approve, Reject, Delete and Rerun live
 * there, and toasts take pointer events). From 768 px up they sit top right,
 * except while a sheet is open beside the collection: then they move left of
 * it, or, without room for a toast there, rise above its footer at the
 * bottom right. One measurement per frame at most, on DOM changes, resizes
 * and the end of a sheet's slide.
 */
const mobile = useIsMobile();
const placement = ref<ToastPlacement | null>(null);
let observer: MutationObserver | undefined;
let frame = 0;

function boxes(selector: string): DOMRect[] {
  return [...document.querySelectorAll<HTMLElement>(selector)].map((el) => el.getBoundingClientRect());
}

function measure(): void {
  frame = 0;
  placement.value = toastPlacement({
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    mobile: mobile.value,
    sheets: boxes(TOAST_SHEET_SELECTOR),
    footers: boxes(TOAST_AVOID_SELECTOR),
  });
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
}

onMounted(start);
watch(mobile, schedule);
onBeforeUnmount(stop);

const position = computed<ToasterProps["position"]>(
  () => props.position ?? placement.value?.position ?? (mobile.value ? "bottom-center" : "top-right"),
);

function placedOffset(fallback: ToasterProps["offset"]): ToasterProps["offset"] {
  const at = placement.value;
  if (!at || props.position) return fallback;
  if (at.position === "top-right") return at.right === undefined ? fallback : { right: at.right };
  return at.bottom === null ? fallback : { bottom: at.bottom };
}

const offset = computed<ToasterProps["offset"]>(() => placedOffset(props.offset));
const mobileOffset = computed<ToasterProps["mobileOffset"]>(() => placedOffset(props.mobileOffset));
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
