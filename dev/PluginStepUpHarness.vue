<script setup lang="ts">
/**
 * The console's step-up for a plugin call, alone, so it can be rendered
 * without a plugin bundle: a button asks as PluginFrameHost does when the
 * server answers a vpn-core link_reveal with step_up_required.
 * `?confirm=1` opens the confirm a still-fresh grant gets instead.
 */
import { ref } from "vue";
import { useRoute } from "vue-router";

import { useStepUp } from "@/composables/useStepUp";
import { Button } from "@/components/ui/button";
import PluginStepUpDialog, { type PluginStepUpAsk } from "@/views/platform/PluginStepUpDialog.vue";

const route = useRoute();
const stepUp = useStepUp({ required: "Second-factor verification is required, so nothing was revealed.", failed: "Passcode verification failed.", passkeyFailed: "Passkey verification failed." });
const ask = ref<PluginStepUpAsk | null>(null);
const outcome = ref("");

async function open(): Promise<void> {
  const confirm = route.query.confirm === "1";
  ask.value = { plugin: "VPN core", service: "latticenet.vpn-core/users-admin", method: "link_reveal", confirm };
  outcome.value = "";
  if (confirm) return;
  try {
    await stepUp.request();
    outcome.value = "granted";
  } catch {
    outcome.value = "cancelled";
  } finally {
    ask.value = null;
  }
}

function answer(ok: boolean): void {
  outcome.value = ok ? "confirmed" : "cancelled";
  ask.value = null;
}
</script>

<template>
  <div class="space-y-3 p-6">
    <Button data-testid="ask" @click="open">Ask as vpn-core link_reveal</Button>
    <p class="text-sm text-muted-foreground" data-testid="outcome">{{ outcome }}</p>
    <PluginStepUpDialog :step-up="stepUp" :ask="ask" @confirm="answer(true)" @cancel="answer(false)" />
  </div>
</template>
