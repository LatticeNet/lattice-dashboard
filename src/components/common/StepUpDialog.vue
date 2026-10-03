<script setup lang="ts">
/**
 * The second-factor prompt in front of a reveal: a passcode or a passkey,
 * through one useStepUp handle (its grant lasts a minute).
 *
 * The caller supplies the words, because the operator has to know what is
 * about to be shown and to whom: a share's link in Publishing, a plugin's
 * call. The default slot sits under the description for the one fact the
 * caller wants on the record (the method a plugin asked for).
 *
 * `confirm` swaps the form for a confirm: used where a grant is still fresh
 * but the reveal must still be the operator's own decision (a plugin asking
 * for a second secret on the strength of a step-up given for the first).
 *
 * Every way out (Cancel, Escape, a click outside) goes through cancel(), so
 * whatever waits on the grant ends instead of staying pending.
 */
import { useId } from "vue";
import { Eye, KeyRound, RefreshCw } from "lucide-vue-next";

import type { useStepUp } from "@/composables/useStepUp";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogDescription, DialogHeader, DialogScrollContent, DialogTitle } from "@/components/ui/dialog";

const props = withDefaults(
  defineProps<{
    stepUp: ReturnType<typeof useStepUp>;
    title: string;
    description: string;
    submitLabel: string;
    /** Shown under the passcode field: where the reveal is recorded. */
    audit?: string;
    /** Open in confirm mode, independent of the step-up handle's own open state. */
    confirm?: boolean;
    confirmHint?: string;
    confirmLabel?: string;
    testId?: string;
  }>(),
  { audit: "", confirm: false, confirmHint: "", confirmLabel: "", testId: "step-up" },
);
const emit = defineEmits<{ confirm: []; cancel: [] }>();

// The handle is fixed for the caller's life, so its refs are taken once and
// unwrap in the template like local state.
const { open, code, error, pending } = props.stepUp;
const codeId = useId();

function setOpen(next: boolean): void {
  if (!next) cancel();
}

function cancel(): void {
  if (props.confirm) emit("cancel");
  else props.stepUp.cancel();
}
</script>

<template>
  <Dialog :open="confirm || open" @update:open="setOpen">
    <DialogScrollContent class="sm:max-w-md" :data-testid="testId">
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription>{{ description }}</DialogDescription>
      </DialogHeader>
      <slot />
      <div v-if="confirm" class="space-y-4">
        <p class="text-sm text-muted-foreground">{{ confirmHint }}</p>
        <div class="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" @click="cancel">{{ $t('common.actions.cancel') }}</Button>
          <Button type="button" :data-testid="`${testId}-confirm`" @click="emit('confirm')">
            <Eye class="size-4" aria-hidden="true" />
            {{ confirmLabel }}
          </Button>
        </div>
      </div>
      <form v-else class="space-y-4" @submit.prevent="stepUp.submitTotp">
        <div class="grid gap-2">
          <Label :for="codeId">{{ $t('common.stepUp.code') }}</Label>
          <Input
            :id="codeId"
            v-model="code"
            inputmode="numeric"
            autocomplete="one-time-code"
            maxlength="8"
            placeholder="123456"
            :data-testid="`${testId}-code`"
          />
          <p v-if="error" class="text-xs text-destructive" role="alert">{{ error }}</p>
          <p v-if="audit" class="text-xs text-muted-foreground">{{ audit }}</p>
        </div>
        <div class="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" @click="cancel">{{ $t('common.actions.cancel') }}</Button>
          <Button type="button" variant="outline" :disabled="!!pending || !stepUp.supportsPasskey" @click="stepUp.submitPasskey">
            <RefreshCw v-if="pending === 'passkey'" class="size-4 animate-spin" aria-hidden="true" />
            <KeyRound v-else class="size-4" aria-hidden="true" />
            {{ $t('common.stepUp.passkey') }}
          </Button>
          <Button type="submit" :disabled="!!pending || !code.trim()" :data-testid="`${testId}-submit`">
            <RefreshCw v-if="pending === 'totp'" class="size-4 animate-spin" aria-hidden="true" />
            <Eye v-else class="size-4" aria-hidden="true" />
            {{ submitLabel }}
          </Button>
        </div>
      </form>
    </DialogScrollContent>
  </Dialog>
</template>
