<script setup lang="ts">
/**
 * The console's own step-up for a plugin call the server answered
 * step_up_required (pluginBridgeModel.ts, STEP_UP_REQUIRED).
 *
 * It names the plugin and the method, in the console's words, because the
 * plugin's page is not where a second factor should ever be typed. With no
 * fresh grant it asks for a passcode or a passkey. With a grant still inside
 * its minute it asks the operator to confirm this reveal instead: the server
 * would take the grant again without a word, but a plugin should not get a
 * second secret on the strength of a step-up given for the first, and a
 * TOTP code cannot be typed twice (the server refuses a replayed one).
 */
import type { useStepUp } from "@/composables/useStepUp";
import StepUpDialog from "@/components/common/StepUpDialog.vue";

export interface PluginStepUpAsk {
  plugin: string;
  service: string;
  method: string;
  /** A grant is still fresh: confirm this reveal rather than typing a factor again. */
  confirm: boolean;
}

const props = defineProps<{
  stepUp: ReturnType<typeof useStepUp>;
  ask: PluginStepUpAsk | null;
}>();
const emit = defineEmits<{ confirm: []; cancel: [] }>();
</script>

<template>
  <!-- Mounted only while a call waits, so the prompt cannot open with no plugin behind it. -->
  <StepUpDialog
    v-if="props.ask"
    :step-up="props.stepUp"
    :title="$t('pluginViews.stepUp.title', { plugin: props.ask.plugin })"
    :description="$t('pluginViews.stepUp.description', { plugin: props.ask.plugin })"
    :submit-label="$t('pluginViews.stepUp.submit')"
    :audit="$t('pluginViews.stepUp.audit')"
    :confirm="props.ask.confirm"
    :confirm-hint="$t('pluginViews.stepUp.confirmHint')"
    :confirm-label="$t('pluginViews.stepUp.confirm')"
    test-id="plugin-step-up"
    @confirm="emit('confirm')"
    @cancel="emit('cancel')"
  >
    <p class="rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs break-all" data-testid="plugin-step-up-method">
      {{ props.ask.service }} · {{ props.ask.method }}
    </p>
  </StepUpDialog>
</template>
