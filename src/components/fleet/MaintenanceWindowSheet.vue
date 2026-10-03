<script setup lang="ts">
/**
 * Create or change a maintenance window: a name, why, which nodes or groups,
 * and when. Inside the window incidents on covered nodes still open and
 * close; only their open messages are held, and still-open ones notify once
 * when it ends. That sentence sits at the top of the form, because it is
 * what an operator needs to trust before relying on it.
 *
 * Nodes and groups are checkbox lists with a filter, since a window usually
 * covers one to a handful of nodes out of thirty-odd. Times are native
 * datetime-local inputs in the browser's zone; the end has 1 h, 4 h and 24 h
 * shortcuts from the start.
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import { api, type MaintenanceWindow } from "@/lib/api";
import { toast } from "@/lib/toast";
import {
  WINDOW_NAME_MAX,
  WINDOW_REASON_MAX,
  draftFromWindow,
  fromLocalInput,
  newWindowDraft,
  toLocalInput,
  windowDraftErrors,
  windowDraftInput,
  type WindowDraft,
} from "@/views/fleet/incidentsModel";
import ObjectSheet from "@/components/common/ObjectSheet.vue";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const props = defineProps<{
  open: boolean;
  /** The window being changed; undefined for a new one. */
  window?: MaintenanceWindow;
  /** A node to cover by default in a new window (the node page's action). */
  nodeId?: string;
  nodes: { id: string; name: string }[];
  groups: { id: string; name: string }[];
  /** Groups need a token without a node restriction. */
  allowGroups: boolean;
}>();

const emit = defineEmits<{ close: []; saved: [window: MaintenanceWindow] }>();
const { t } = useI18n();

const draft = ref<WindowDraft>(newWindowDraft(Date.now()));
const touched = ref(false);
const saving = ref(false);
const nodeFilter = ref("");

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    draft.value = props.window ? draftFromWindow(props.window) : newWindowDraft(Date.now(), props.nodeId);
    touched.value = false;
    nodeFilter.value = "";
  },
  { immediate: true },
);

const errors = computed(() => windowDraftErrors(draft.value, Date.now()));
const shownErrors = computed(() => (touched.value ? errors.value : errors.value.filter((e) => e !== "name" && e !== "target")));

const filteredNodes = computed(() => {
  const needle = nodeFilter.value.trim().toLowerCase();
  const list = [...props.nodes].sort((a, b) => a.name.localeCompare(b.name));
  if (!needle) return list;
  return list.filter((node) => node.name.toLowerCase().includes(needle) || node.id.toLowerCase().includes(needle));
});

function toggle(list: "nodeIds" | "groupIds", id: string, on: boolean | "indeterminate"): void {
  const current = new Set(draft.value[list]);
  if (on === true) current.add(id);
  else current.delete(id);
  draft.value = { ...draft.value, [list]: [...current] };
}

function endIn(hours: number): void {
  const start = draft.value.start === "now" && !draft.value.id ? Date.now() : fromLocalInput(draft.value.startsAt);
  if (Number.isNaN(start)) return;
  draft.value = { ...draft.value, endsAt: toLocalInput(start + hours * 3_600_000) };
}

async function save(): Promise<void> {
  touched.value = true;
  if (errors.value.length > 0 || saving.value) return;
  saving.value = true;
  try {
    const saved = await api.maintenance.upsert(windowDraftInput(draft.value));
    toast.success(props.window ? t("fleet.keepalive.maintenance.toast.updated") : t("fleet.keepalive.maintenance.toast.created"));
    emit("saved", saved);
  } catch (error) {
    toast.error(error instanceof Error && error.message ? error.message : t("fleet.keepalive.maintenance.toast.saveFailed"));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <ObjectSheet
    :open="open"
    :title="window ? $t('fleet.keepalive.maintenance.editTitle') : $t('fleet.keepalive.maintenance.newTitle')"
    @close="emit('close')"
  >
    <form class="space-y-5" novalidate @submit.prevent="save">
      <p class="text-sm text-muted-foreground">{{ $t('fleet.keepalive.maintenance.explain') }}</p>

      <div class="space-y-1.5">
        <Label for="mw-name">{{ $t('fleet.keepalive.maintenance.name') }}</Label>
        <Input id="mw-name" v-model="draft.name" :maxlength="WINDOW_NAME_MAX" :placeholder="$t('fleet.keepalive.maintenance.namePlaceholder')" :aria-invalid="shownErrors.includes('name') || undefined" />
        <p v-if="shownErrors.includes('name')" class="text-xs text-destructive">{{ $t('fleet.keepalive.maintenance.error.name') }}</p>
      </div>

      <div class="space-y-1.5">
        <Label for="mw-reason">{{ $t('fleet.keepalive.maintenance.reason') }}</Label>
        <Textarea id="mw-reason" v-model="draft.reason" :maxlength="WINDOW_REASON_MAX" rows="2" :placeholder="$t('fleet.keepalive.maintenance.reasonPlaceholder')" />
      </div>

      <fieldset class="space-y-2">
        <legend class="text-sm font-medium">{{ $t('fleet.keepalive.maintenance.covers') }}</legend>
        <p v-if="shownErrors.includes('target')" class="text-xs text-destructive">{{ $t('fleet.keepalive.maintenance.error.target') }}</p>
        <div class="space-y-1.5">
          <div class="flex items-center justify-between gap-2">
            <Label for="mw-node-filter" class="text-xs text-muted-foreground">
              {{ $t('fleet.keepalive.maintenance.nodes', { n: draft.nodeIds.length }) }}
            </Label>
          </div>
          <Input id="mw-node-filter" v-model="nodeFilter" type="search" :placeholder="$t('fleet.keepalive.maintenance.filterNodes')" class="h-8 pointer-coarse:h-11" />
          <ul class="max-h-48 overflow-y-auto rounded-md border border-border" role="list">
            <li v-for="node in filteredNodes" :key="node.id">
              <label class="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-sm hover:bg-muted/40 pointer-coarse:min-h-11">
                <Checkbox :model-value="draft.nodeIds.includes(node.id)" @update:model-value="(on) => toggle('nodeIds', node.id, on)" />
                <span class="min-w-0 truncate">{{ node.name }}</span>
                <span class="ms-auto shrink-0 font-mono text-xs text-muted-foreground">{{ node.id }}</span>
              </label>
            </li>
            <li v-if="!filteredNodes.length" class="px-3 py-2 text-xs text-muted-foreground">{{ $t('fleet.keepalive.maintenance.noNodes') }}</li>
          </ul>
        </div>
        <div v-if="groups.length" class="space-y-1.5">
          <p class="text-xs text-muted-foreground">{{ $t('fleet.keepalive.maintenance.groups', { n: draft.groupIds.length }) }}</p>
          <p v-if="!allowGroups" class="text-xs text-muted-foreground">{{ $t('fleet.keepalive.maintenance.groupsConfined') }}</p>
          <ul v-else class="flex flex-wrap gap-1.5" role="list">
            <li v-for="group in groups" :key="group.id">
              <label class="flex cursor-pointer items-center gap-2 rounded-md border border-border px-2.5 py-1 text-sm hover:bg-muted/40 pointer-coarse:min-h-11">
                <Checkbox :model-value="draft.groupIds.includes(group.id)" @update:model-value="(on) => toggle('groupIds', group.id, on)" />
                {{ group.name }}
              </label>
            </li>
          </ul>
        </div>
      </fieldset>

      <fieldset class="space-y-3">
        <legend class="text-sm font-medium">{{ $t('fleet.keepalive.maintenance.when') }}</legend>
        <div v-if="!draft.id" class="flex flex-wrap gap-4 text-sm">
          <label class="flex items-center gap-2 pointer-coarse:min-h-11">
            <input v-model="draft.start" type="radio" value="now" class="size-4 accent-primary" />
            {{ $t('fleet.keepalive.maintenance.startNow') }}
          </label>
          <label class="flex items-center gap-2 pointer-coarse:min-h-11">
            <input v-model="draft.start" type="radio" value="at" class="size-4 accent-primary" />
            {{ $t('fleet.keepalive.maintenance.startAt') }}
          </label>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <div v-if="draft.id || draft.start === 'at'" class="space-y-1.5">
            <Label for="mw-start">{{ $t('fleet.keepalive.maintenance.starts') }}</Label>
            <Input id="mw-start" v-model="draft.startsAt" type="datetime-local" class="pointer-coarse:h-11" :aria-invalid="shownErrors.includes('start') || undefined" />
          </div>
          <div class="space-y-1.5">
            <Label for="mw-end">{{ $t('fleet.keepalive.maintenance.ends') }}</Label>
            <Input id="mw-end" v-model="draft.endsAt" type="datetime-local" class="pointer-coarse:h-11" :aria-invalid="shownErrors.some((e) => e.startsWith('end') || e === 'tooLong') || undefined" />
          </div>
        </div>
        <div class="flex flex-wrap gap-1.5">
          <Button v-for="hours in [1, 4, 24]" :key="hours" variant="outline" size="sm" type="button" class="pointer-coarse:h-11" @click="endIn(hours)">
            {{ $t('fleet.keepalive.maintenance.lasts', { n: hours }, hours) }}
          </Button>
        </div>
        <p v-for="error in shownErrors.filter((e) => e !== 'name' && e !== 'target')" :key="error" class="text-xs text-destructive">
          {{ $t(`fleet.keepalive.maintenance.error.${error}`) }}
        </p>
      </fieldset>
    </form>
    <template #actions>
      <Button variant="ghost" type="button" @click="emit('close')">{{ $t('common.actions.cancel') }}</Button>
      <Button type="button" :disabled="saving" @click="save">
        {{ window ? $t('common.actions.saveChanges') : draft.start === 'now' ? $t('fleet.keepalive.maintenance.start') : $t('fleet.keepalive.maintenance.create') }}
      </Button>
    </template>
  </ObjectSheet>
</template>
