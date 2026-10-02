<script setup lang="ts">
/**
 * The step-up prompt in front of a machine's sealed console or detail link
 * (useMachineLinkReveal). Place it after any dialog it opens from, so it
 * stacks above that dialog.
 *
 * Every way out (Cancel, Escape, a click outside) goes through cancel(), so
 * the reveal waiting on the grant ends instead of staying pending.
 */
import { useId } from "vue";
import { KeyRound, Link as LinkIcon, RefreshCw } from "lucide-vue-next";

import type { useStepUp } from "@/composables/useStepUp";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogDescription, DialogHeader, DialogScrollContent, DialogTitle } from "@/components/ui/dialog";

const props = defineProps<{ stepUp: ReturnType<typeof useStepUp> }>();

// The handle is fixed for the page's life, so its refs are taken once and
// unwrap in the template like local state.
const { open, code, error, pending } = props.stepUp;
const codeId = useId();

function setOpen(next: boolean): void {
  if (!next) props.stepUp.cancel();
}
</script>

<template>
  <Dialog :open="open" @update:open="setOpen">
    <DialogScrollContent class="sm:max-w-md" data-testid="machine-link-step-up">
      <DialogHeader>
        <DialogTitle>{{ $t('fleet.inventory.stepUp.title') }}</DialogTitle>
        <DialogDescription>{{ $t('fleet.inventory.stepUp.description') }}</DialogDescription>
      </DialogHeader>
      <form class="space-y-4" @submit.prevent="stepUp.submitTotp">
        <div class="grid gap-2">
          <Label :for="codeId">{{ $t('fleet.inventory.stepUp.code') }}</Label>
          <Input
            :id="codeId"
            v-model="code"
            inputmode="numeric"
            autocomplete="one-time-code"
            maxlength="8"
            placeholder="123456"
          />
          <p v-if="error" class="text-xs text-destructive">{{ error }}</p>
        </div>
        <div class="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" @click="stepUp.cancel">
            {{ $t('common.actions.cancel') }}
          </Button>
          <Button type="button" variant="outline" :disabled="!!pending || !stepUp.supportsPasskey" @click="stepUp.submitPasskey">
            <RefreshCw v-if="pending === 'passkey'" class="size-4 animate-spin" aria-hidden="true" />
            <KeyRound v-else class="size-4" aria-hidden="true" />
            {{ $t('fleet.inventory.stepUp.passkey') }}
          </Button>
          <Button type="submit" :disabled="!!pending || !code.trim()">
            <RefreshCw v-if="pending === 'totp'" class="size-4 animate-spin" aria-hidden="true" />
            <LinkIcon v-else class="size-4" aria-hidden="true" />
            {{ $t('fleet.inventory.stepUp.submit') }}
          </Button>
        </div>
      </form>
    </DialogScrollContent>
  </Dialog>
</template>
