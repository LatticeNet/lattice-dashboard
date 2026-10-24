<script setup lang="ts">
/**
 * An editor's footer after a save did not go through (design 32 R6): the
 * refusal, naming the field it marked, or the version conflict, naming what
 * changed on the server with the two ways out. The draft is never dropped
 * here; the editor decides what reload and overwrite mean
 * (useSaveRefusal). A conflict takes focus when it appears, since the Save
 * button that had it is now disabled.
 */
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, RefreshCw } from "lucide-vue-next";

import { Button } from "@/components/ui/button";
import { resolveField, type SaveRefusal } from "@/lib/saveRefusal";
import { formatRelativeTime } from "@/lib/format";

const props = defineProps<{
  refusal?: SaveRefusal;
  /** The changed paths of a conflict, absent when there is none. */
  changed?: readonly string[];
  /** Who saved the newer version and when, when the object records it. */
  by?: string;
  at?: string;
  /** Request path to the label the editor shows for it. */
  labels: Readonly<Record<string, string>>;
  /** The id the marked control is described by. */
  messageId: string;
  /** A save is running: the conflict's buttons wait. */
  pending?: boolean;
  /** What the object is called in a sentence ("check", "policy"). */
  noun?: string;
}>();

const emit = defineEmits<{ reload: []; overwrite: [] }>();

const { t } = useI18n();

const fieldLabel = computed(() => {
  const path = resolveField(props.refusal?.field, Object.keys(props.labels));
  return path ? props.labels[path] : undefined;
});

const changedLabels = computed(() => {
  const seen = new Set<string>();
  for (const path of props.changed ?? []) seen.add(props.labels[path] ?? path);
  return [...seen];
});

const savedBy = computed(() => {
  if (!props.by && !props.at) return "";
  if (!props.at) return t("common.saveRefusal.savedBy", { who: props.by });
  // Under a minute reads "just now"; a relative "now" reads as an order in Chinese.
  const justNow = Math.abs(Date.now() - new Date(props.at).getTime()) < 60_000;
  if (props.by) return justNow ? t("common.saveRefusal.savedByJustNow", { who: props.by }) : t("common.saveRefusal.savedByAt", { who: props.by, when: formatRelativeTime(props.at) });
  return justNow ? t("common.saveRefusal.savedJustNow") : t("common.saveRefusal.savedAt", { when: formatRelativeTime(props.at) });
});

const conflictEl = ref<HTMLElement>();
watch(
  () => props.changed,
  (now, before) => {
    if (now && !before) void nextTick(() => conflictEl.value?.focus());
  },
);

</script>

<template>
  <div
    v-if="changed"
    ref="conflictEl"
    tabindex="-1"
    role="alert"
    class="basis-full rounded-md border border-warning/40 bg-warning/10 px-3 py-2.5 text-xs"
    data-testid="save-conflict"
  >
    <p class="flex items-start gap-2 font-medium text-foreground">
      <AlertTriangle class="mt-px size-3.5 shrink-0 text-warning-text" aria-hidden="true" />
      <span>{{ $t('common.saveRefusal.conflictTitle', { noun: noun ?? $t('common.saveRefusal.nounDefault') }) }}</span>
    </p>
    <p v-if="savedBy" class="mt-1 ps-5.5 text-muted-foreground" data-testid="save-conflict-by">{{ savedBy }}</p>
    <p class="mt-1 ps-5.5 text-muted-foreground" data-testid="save-conflict-changed">
      {{ changedLabels.length ? $t('common.saveRefusal.changed', { fields: changedLabels.join($t('common.saveRefusal.join')) }) : $t('common.saveRefusal.changedNone') }}
    </p>
    <p class="mt-1 ps-5.5 text-muted-foreground">{{ $t('common.saveRefusal.keptDraft') }}</p>
    <div class="mt-2 flex flex-wrap gap-2 ps-5.5">
      <Button type="button" size="sm" variant="outline" :disabled="pending" data-testid="save-conflict-reload" @click="emit('reload')">
        {{ $t('common.saveRefusal.reload') }}
      </Button>
      <Button type="button" size="sm" variant="destructive" :disabled="pending" data-testid="save-conflict-overwrite" @click="emit('overwrite')">
        <RefreshCw v-if="pending" class="size-4 animate-spin" aria-hidden="true" />
        {{ $t('common.saveRefusal.overwrite') }}
      </Button>
    </div>
  </div>
  <p v-else-if="refusal" :id="messageId" role="alert" class="basis-full text-xs text-destructive" data-testid="save-refusal">
    <template v-if="fieldLabel">{{ $t('common.saveRefusal.fieldRefused', { field: fieldLabel, reason: refusal.message }) }}</template>
    <template v-else>{{ $t('common.saveRefusal.refused', { reason: refusal.message }) }}</template>
  </p>
</template>
