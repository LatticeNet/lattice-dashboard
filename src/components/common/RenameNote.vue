<script setup lang="ts">
/**
 * A renamed page's first-visit note (renameNoteModel): the old name next to
 * the new one, once per viewer, with a dismiss button. Quiet on purpose: it
 * explains a moved habit and gets out of the way.
 */
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { Info, X } from "lucide-vue-next";

import { useAuthStore } from "@/stores/auth";
import { cn } from "@/lib/utils";
import { takeRenameNote, type RenamedPage } from "./renameNoteModel";

const props = defineProps<{ id: RenamedPage; class?: string }>();

const { t } = useI18n();
const auth = useAuthStore();

function storage() {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

const shown = ref(takeRenameNote(storage(), auth.principal?.actor_id, props.id));
</script>

<template>
  <p
    v-if="shown"
    role="note"
    :class="cn('flex items-start gap-2 rounded-md border border-border bg-muted/40 py-2 pe-1.5 ps-3 text-sm text-muted-foreground', props.class)"
    data-testid="rename-note"
  >
    <Info class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
    <span class="min-w-0 flex-1">{{ t(`renames.${id}`) }}</span>
    <button
      type="button"
      class="inline-flex size-6 shrink-0 items-center justify-center rounded-md outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:size-9"
      :aria-label="t('renames.dismiss')"
      @click="shown = false"
    >
      <X class="size-4" aria-hidden="true" />
    </button>
  </p>
</template>
