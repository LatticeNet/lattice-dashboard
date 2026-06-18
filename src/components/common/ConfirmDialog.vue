<script setup lang="ts">
import { computed } from "vue";
import { RefreshCw } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from "@/components/ui/dialog";

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
 */
const props = withDefaults(
  defineProps<{
    /** v-model:open — controls visibility. */
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
  }>(),
  {
    description: undefined,
    confirmLabel: "Confirm",
    cancelLabel: "Cancel",
    variant: "destructive",
    pending: false,
  },
);

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "confirm"): void;
  (e: "cancel"): void;
}>();

const confirmVariant = computed(() => props.variant);

function setOpen(value: boolean) {
  emit("update:open", value);
}

function onCancel() {
  emit("cancel");
  setOpen(false);
}

function onConfirm() {
  if (props.pending) return;
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

      <slot />

      <DialogFooter>
        <Button type="button" variant="outline" :disabled="pending" @click="onCancel">
          {{ cancelLabel }}
        </Button>
        <Button type="button" :variant="confirmVariant" :disabled="pending" @click="onConfirm">
          <RefreshCw v-if="pending" class="size-4 animate-spin" aria-hidden="true" />
          {{ confirmLabel }}
        </Button>
      </DialogFooter>
    </DialogScrollContent>
  </Dialog>
</template>
