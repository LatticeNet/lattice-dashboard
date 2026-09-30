<script setup lang="ts">
import { computed, ref, useId, watch } from "vue";
import { RefreshCw } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { typedConfirmMatches } from "./chassisModel";

/**
 * Themed destructive-confirm dialog.
 *
 * One reusable replacement for the many hand-rolled delete/confirm Dialogs and
 * the few native `window.confirm()` calls across the app. Callers pass already
 * translated strings via props (plain-English defaults keep it usable bare).
 *
 * Usage:
 *   <ConfirmDialog
 *     v-model:open="deleteOpen"
 *     :title="$t('...deleteTitle')"
 *     :description="$t('...deleteConfirm', { name })"
 *     :confirm-label="$t('common.actions.delete')"
 *     :cancel-label="$t('common.actions.cancel')"
 *     :pending="deleting"
 *     @confirm="confirmDelete"
 *   />
 *
 * Destructive actions are classed by what breaks (design 23, section 3.8).
 * An action that breaks something inside Lattice passes `impact`, one line
 * per thing that stops working. An action that breaks something outside it
 * (a live URL goes offline, clients lose a token) also passes
 * `typed-confirm`, the name the operator types before Confirm enables. A
 * reversible action passes `variant="default"` and neither.
 */
const props = withDefaults(
  defineProps<{
    /** v-model:open. Controls visibility. */
    open: boolean;
    /** Dialog heading (pass a translated string). */
    title: string;
    /** Optional body copy explaining the consequence. */
    description?: string;
    /** Confirm button label. */
    confirmLabel?: string;
    /** Cancel button label. */
    cancelLabel?: string;
    /** Confirm button style; destructive for irreversible actions. */
    variant?: "destructive" | "default";
    /** When true, disables the confirm button and shows a spinner. */
    pending?: boolean;
    /**
     * Blocks confirmation without claiming work is in flight. Dialogs that ask
     * the operator to type a resource name need this: `pending` would spin and
     * also disable Cancel, which reads as "already running" for a dialog that
     * has not started anything.
     */
    confirmDisabled?: boolean;
    /** What stops working, one line each. */
    impact?: string[];
    /** Heading over the impact lines; defaults to "What stops working". */
    impactTitle?: string;
    /** The name the operator must type before Confirm enables. */
    typedConfirm?: string;
  }>(),
  {
    description: undefined,
    confirmLabel: "Confirm",
    cancelLabel: "Cancel",
    variant: "destructive",
    pending: false,
    confirmDisabled: false,
    impact: undefined,
    impactTitle: undefined,
    typedConfirm: undefined,
  },
);

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "confirm"): void;
  (e: "cancel"): void;
}>();

const confirmVariant = computed(() => props.variant);

const typed = ref("");
const typedId = useId();
// Every opening starts empty: a name typed for the last object must not
// confirm the next one.
watch(
  () => props.open,
  (open) => {
    if (open) typed.value = "";
  },
);
const typedOk = computed(() => typedConfirmMatches(typed.value, props.typedConfirm));
const blocked = computed(() => props.confirmDisabled || !typedOk.value);

function setOpen(value: boolean) {
  emit("update:open", value);
}

function onCancel() {
  emit("cancel");
  setOpen(false);
}

function onConfirm() {
  if (props.pending || blocked.value) return;
  emit("confirm");
}
</script>

<template>
  <Dialog :open="open" @update:open="setOpen">
    <DialogScrollContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription v-if="description">
          {{ description }}
        </DialogDescription>
      </DialogHeader>

      <section v-if="impact?.length" class="space-y-1.5" data-testid="confirm-impact">
        <h3 class="text-xs font-medium text-muted-foreground">{{ impactTitle ?? $t('common.confirm.impactTitle') }}</h3>
        <ul class="space-y-1 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
          <li v-for="line in impact" :key="line" class="flex gap-2">
            <span aria-hidden="true" class="text-destructive">&#8226;</span>
            <span class="min-w-0 break-words">{{ line }}</span>
          </li>
        </ul>
      </section>

      <slot />

      <form v-if="typedConfirm !== undefined" class="space-y-1.5" @submit.prevent="onConfirm">
        <label :for="typedId" class="text-sm">
          <i18n-t keypath="common.confirm.typeToConfirm" tag="span" scope="global">
            <template #name>
              <code class="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs break-all">{{ typedConfirm }}</code>
            </template>
          </i18n-t>
        </label>
        <Input
          :id="typedId"
          v-model="typed"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          class="font-mono text-sm"
          data-testid="confirm-typed"
        />
      </form>

      <DialogFooter>
        <Button type="button" variant="outline" :disabled="pending" @click="onCancel">
          {{ cancelLabel }}
        </Button>
        <Button
        type="button"
        :variant="confirmVariant"
        :disabled="pending || blocked"
        @click="onConfirm"
      >
          <RefreshCw v-if="pending" class="size-4 animate-spin" aria-hidden="true" />
          {{ confirmLabel }}
        </Button>
      </DialogFooter>
    </DialogScrollContent>
  </Dialog>
</template>
