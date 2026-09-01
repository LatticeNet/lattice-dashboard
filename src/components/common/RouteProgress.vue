<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import { useRouter } from "vue-router";

// The bar waits ~150ms before appearing: most route changes resolve within a
// frame or two (cached lazy chunks, no blocking guards), and flashing a bar on
// every click would make the app feel slower rather than more responsive. Only
// transitions still pending after the delay get visible feedback.
const SHOW_DELAY_MS = 150;
const DONE_SWEEP_MS = 250;

const router = useRouter();
const visible = ref(false);
const done = ref(false);

let showTimer: ReturnType<typeof setTimeout> | undefined;
let hideTimer: ReturnType<typeof setTimeout> | undefined;

function begin() {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  done.value = false;
  if (!visible.value) {
    showTimer = setTimeout(() => {
      visible.value = true;
    }, SHOW_DELAY_MS);
  }
}

function finish() {
  clearTimeout(showTimer);
  if (!visible.value) return; // never shown: the transition was instant, stay silent
  done.value = true; // brief completion sweep to full width, then fade out
  hideTimer = setTimeout(() => {
    visible.value = false;
    done.value = false;
  }, DONE_SWEEP_MS);
}

const offBefore = router.beforeEach(() => begin());
const offAfter = router.afterEach(() => finish());
const offError = router.onError(() => finish());

onBeforeUnmount(() => {
  offBefore();
  offAfter();
  offError();
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
});
</script>

<template>
  <div v-if="visible" class="route-progress bg-primary" :class="{ done }" aria-hidden="true" />
</template>

<style scoped>
.route-progress {
  position: fixed;
  top: 0;
  left: 0;
  height: 2px;
  width: 0;
  z-index: 100;
  pointer-events: none;
  animation: route-progress-trickle 4s cubic-bezier(0.15, 0.6, 0.3, 1) forwards;
}
.route-progress.done {
  animation: none;
  width: 100%;
  opacity: 0;
  transition: width 120ms ease-out, opacity 100ms ease-in 120ms;
}
@keyframes route-progress-trickle {
  to { width: 85%; }
}
@media (prefers-reduced-motion: reduce) {
  /* Drop the motion, keep the pending signal: a static full-width bar. */
  .route-progress { animation: none; width: 100%; transition: none; }
}
</style>
