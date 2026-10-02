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
 *
 * While `pending` is true the dialog ignores every request to close it
 * (Escape, an outside click, the close button, Cancel is disabled), so the
 * operator never loses sight of a request whose outcome is unknown. The
 * caller must therefore set `pending` back to false in a `finally`, on
 * failure as well as success: a `pending` left true after an error is a
 * dialog nobody can close. Close it on success through `open`; on failure
 * leave it open, with the typed name, so the operator can retry.
 *
 *   async function confirmDelete() {
 *     deleting.value = true;
 *     try {
 *       await api.thing.delete(id);
 *       deleteOpen.value = false;
 *     } catch (error) {
 *       toast.error(message(error));
 *     } finally {
 *       deleting.value = false;
 *     }
 *   }
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
    /**
     * Where focus lands when the dialog closes. Left out, it returns to
     * whatever had focus when the dialog opened, which is gone when a row
     * menu item opened it.
     */
    returnFocus?: () => HTMLElement | null;
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
    returnFocus: undefined,
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
/** A dialog with nothing to describe says so, instead of pointing at a missing element. */
const describedBy = computed(() => (props.description || props.impact?.length ? {} : { "aria-describedby": undefined }));
const blocked = computed(() => props.confirmDisabled || !typedOk.value);

function setOpen(value: boolean) {
  // Escape, an outside click or the close button while the request is in
  // flight would drop the dialog, and the name typed into it, with the
  // outcome still unknown. It stays until the caller settles the request and
  // closes it (on success) or leaves it open to try again (on failure).
  if (!value && props.pending) return;
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

function onCloseAutoFocus(event: Event) {
  const target = props.returnFocus?.();
  if (!target?.isConnected) return;
  event.preventDefault();
  target.focus();
}
</script>

<template>
  <Dialog :open="open" @update:open="setOpen">
    <!-- A 16 px gutter on a phone, and a title that stops short of the close
         button: a long name ("Revoke the storage token edge-config reader?")
         ran under it at 375. -->
    <DialogScrollContent class="w-[calc(100%-2rem)] sm:max-w-md" v-bind="describedBy" @close-auto-focus="onCloseAutoFocus">
      <DialogHeader class="pe-6">
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription v-if="description && !impact?.length">
          {{ description }}
        </DialogDescription>
      </DialogHeader>

      <!-- With impact lines, the description and the list are one
           DialogDescription, so a screen reader reads what stops working
           along with the title (and reka has the description it asks for). -->
      <DialogDescription v-if="impact?.length" as="div" class="space-y-3">
        <p v-if="description">{{ description }}</p>
        <section class="space-y-1.5" data-testid="confirm-impact">
          <h3 class="text-xs font-medium">{{ impactTitle ?? $t('common.confirm.impactTitle') }}</h3>
          <ul class="space-y-1 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-foreground">
            <li v-for="line in impact" :key="line" class="flex gap-2">
              <span aria-hidden="true" class="text-destructive">&#8226;</span>
              <span class="min-w-0 break-words">{{ line }}</span>
            </li>
          </ul>
        </section>
      </DialogDescription>

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
